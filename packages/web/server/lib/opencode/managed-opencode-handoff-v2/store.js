import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  assertPrivateRegularFile,
  ensurePrivateDirectory,
  fsyncDirectory,
  resolveManagedOpenCodeHandoffV2Root,
} from './filesystem.js';
import {
  isManagedOpenCodeHandoffV2Incarnation,
  isManagedOpenCodeHandoffV2OperationId,
  MANAGED_OPENCODE_HANDOFF_V2_MAX_LEASE_MS,
  ManagedOpenCodeHandoffV2State,
  normalizeManagedOpenCodeHandoffV2Operation,
  normalizeManagedOpenCodeHandoffV2Record,
} from './record.js';

export const MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME = 'records.sqlite3';

const LEGACY_STORE_USER_VERSION = 2_421_007;
const OPERATION_STORE_USER_VERSION = 2_421_008;
const STORE_USER_VERSION = 2_421_009;
const STORE_APPLICATION_ID = 0x4f434832;
const STORE_TABLE = 'managed_opencode_handoff_v2_records';
const STORE_EXPIRY_INDEX = 'managed_opencode_handoff_v2_expiry_idx';
const STORE_OPERATION_TABLE = 'managed_opencode_handoff_v2_operations';
const STORE_OPERATION_EXPIRY_INDEX = 'managed_opencode_handoff_v2_operations_expiry_idx';
const STORE_COLUMNS = Object.freeze([
  'incarnation',
  'owner_instance_id',
  'runtime_identity',
  'launch_fingerprint',
  'launch_spec',
  'version',
  'state',
  'credential_fingerprint',
  'pid',
  'port',
  'process_start_ticks',
  'created_at',
  'lease_expires_at',
  'revision',
  'mac',
]);
const EXPECTED_KEYS = Object.freeze(['revision', 'mac', 'leaseExpiresAt']);
const OPERATION_COLUMNS = Object.freeze([
  'operation_id',
  'version',
  'kind',
  'incarnation',
  'owner_instance_id',
  'runtime_identity',
  'launch_fingerprint',
  'target_revision',
  'target_lease_expires_at',
  'target_mac',
  'state',
  'resolution_state',
  'resolution_revision',
  'resolution_lease_expires_at',
  'resolution_mac',
  'created_at',
  'confirmation_expires_at',
  'revision',
  'mac',
]);
const STATE_SQL = Object.values(ManagedOpenCodeHandoffV2State)
  .map((state) => `'${state}'`)
  .join(', ');
// Lease expiry is not proof that an unresolved child is gone.  Only records
// already in a terminal state may be removed by time-based cleanup alone;
// stopping/handoff and other in-flight records remain the recovery handle
// until the guardian records an authoritative transition.
const SAFE_CLEANUP_STATES = Object.freeze([
  ManagedOpenCodeHandoffV2State.Interrupted,
  ManagedOpenCodeHandoffV2State.Retired,
]);
const CREATE_TABLE_SQL = `
  CREATE TABLE ${STORE_TABLE} (
    incarnation TEXT PRIMARY KEY NOT NULL,
    owner_instance_id TEXT,
    runtime_identity TEXT,
    launch_fingerprint TEXT,
    launch_spec TEXT,
    version INTEGER NOT NULL CHECK (version = 2),
    state TEXT NOT NULL CHECK (state IN (${STATE_SQL})),
    credential_fingerprint TEXT NOT NULL,
    pid INTEGER,
    port INTEGER,
    process_start_ticks TEXT,
    created_at INTEGER NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    mac TEXT NOT NULL,
    CHECK (lease_expires_at > created_at),
    CHECK (
      (pid IS NULL AND port IS NULL AND process_start_ticks IS NULL)
      OR (
        pid > 0
        AND port > 0
        AND port <= 65535
        AND typeof(process_start_ticks) = 'text'
        AND length(process_start_ticks) > 0
        AND process_start_ticks NOT GLOB '*[^0-9]*'
        AND (process_start_ticks = '0' OR substr(process_start_ticks, 1, 1) <> '0')
      )
    )
  ) STRICT
`;
const CREATE_EXPIRY_INDEX_SQL = `
  CREATE INDEX ${STORE_EXPIRY_INDEX} ON ${STORE_TABLE} (lease_expires_at)
`;
const CREATE_OPERATION_TABLE_SQL = `
  CREATE TABLE ${STORE_OPERATION_TABLE} (
    operation_id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL CHECK (version = 2),
    kind TEXT NOT NULL CHECK (kind IN ('spawn', 'stop', 'prepare-handoff', 'abort-handoff')),
    incarnation TEXT NOT NULL,
    owner_instance_id TEXT NOT NULL,
    runtime_identity TEXT NOT NULL,
    launch_fingerprint TEXT NOT NULL,
    target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
    target_lease_expires_at INTEGER NOT NULL,
    target_mac TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'expired')),
    resolution_state TEXT CHECK (resolution_state IS NULL OR resolution_state IN ('active', 'handoff-prepared', 'interrupted', 'retired')),
    resolution_revision INTEGER,
    resolution_lease_expires_at INTEGER,
    resolution_mac TEXT,
    created_at INTEGER NOT NULL,
    confirmation_expires_at INTEGER NOT NULL CHECK (confirmation_expires_at > created_at),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    mac TEXT NOT NULL,
    CHECK (
      (resolution_state IS NULL AND resolution_revision IS NULL AND resolution_lease_expires_at IS NULL AND resolution_mac IS NULL)
      OR (resolution_state IS NOT NULL AND resolution_revision >= 0 AND resolution_lease_expires_at IS NOT NULL AND resolution_mac IS NOT NULL)
    ),
    CHECK ((state = 'pending' AND resolution_state IS NULL) OR (state = 'resolved' AND resolution_state IS NOT NULL) OR state = 'expired')
  ) STRICT
`;
const CREATE_OPERATION_TABLE_SQL_LEGACY = `
  CREATE TABLE ${STORE_OPERATION_TABLE} (
    operation_id TEXT PRIMARY KEY NOT NULL,
    version INTEGER NOT NULL CHECK (version = 2),
    kind TEXT NOT NULL CHECK (kind IN ('spawn', 'stop', 'prepare-handoff', 'abort-handoff')),
    incarnation TEXT NOT NULL,
    owner_instance_id TEXT NOT NULL,
    runtime_identity TEXT NOT NULL,
    launch_fingerprint TEXT NOT NULL,
    target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
    target_lease_expires_at INTEGER NOT NULL,
    target_mac TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('pending', 'resolved', 'expired')),
    resolution_state TEXT CHECK (resolution_state IS NULL OR resolution_state IN ('active', 'interrupted', 'retired')),
    resolution_revision INTEGER,
    resolution_lease_expires_at INTEGER,
    resolution_mac TEXT,
    created_at INTEGER NOT NULL,
    confirmation_expires_at INTEGER NOT NULL CHECK (confirmation_expires_at > created_at),
    revision INTEGER NOT NULL CHECK (revision >= 0),
    mac TEXT NOT NULL,
    CHECK (
      (resolution_state IS NULL AND resolution_revision IS NULL AND resolution_lease_expires_at IS NULL AND resolution_mac IS NULL)
      OR (resolution_state IS NOT NULL AND resolution_revision >= 0 AND resolution_lease_expires_at IS NOT NULL AND resolution_mac IS NOT NULL)
    ),
    CHECK ((state = 'pending' AND resolution_state IS NULL) OR (state = 'resolved' AND resolution_state IS NOT NULL) OR state = 'expired')
  ) STRICT
`;
const CREATE_OPERATION_EXPIRY_INDEX_SQL = `
  CREATE INDEX ${STORE_OPERATION_EXPIRY_INDEX} ON ${STORE_OPERATION_TABLE} (confirmation_expires_at)
`;
const EXPECTED_TABLE_COLUMNS = Object.freeze([
  ['incarnation', 'TEXT', 1, 1],
  ['owner_instance_id', 'TEXT', 0, 0],
  ['runtime_identity', 'TEXT', 0, 0],
  ['launch_fingerprint', 'TEXT', 0, 0],
  ['launch_spec', 'TEXT', 0, 0],
  ['version', 'INTEGER', 1, 0],
  ['state', 'TEXT', 1, 0],
  ['credential_fingerprint', 'TEXT', 1, 0],
  ['pid', 'INTEGER', 0, 0],
  ['port', 'INTEGER', 0, 0],
  ['process_start_ticks', 'TEXT', 0, 0],
  ['created_at', 'INTEGER', 1, 0],
  ['lease_expires_at', 'INTEGER', 1, 0],
  ['revision', 'INTEGER', 1, 0],
  ['mac', 'TEXT', 1, 0],
]);
const EXPECTED_OPERATION_TABLE_COLUMNS = Object.freeze([
  ['operation_id', 'TEXT', 1, 1],
  ['version', 'INTEGER', 1, 0],
  ['kind', 'TEXT', 1, 0],
  ['incarnation', 'TEXT', 1, 0],
  ['owner_instance_id', 'TEXT', 1, 0],
  ['runtime_identity', 'TEXT', 1, 0],
  ['launch_fingerprint', 'TEXT', 1, 0],
  ['target_revision', 'INTEGER', 1, 0],
  ['target_lease_expires_at', 'INTEGER', 1, 0],
  ['target_mac', 'TEXT', 1, 0],
  ['state', 'TEXT', 1, 0],
  ['resolution_state', 'TEXT', 0, 0],
  ['resolution_revision', 'INTEGER', 0, 0],
  ['resolution_lease_expires_at', 'INTEGER', 0, 0],
  ['resolution_mac', 'TEXT', 0, 0],
  ['created_at', 'INTEGER', 1, 0],
  ['confirmation_expires_at', 'INTEGER', 1, 0],
  ['revision', 'INTEGER', 1, 0],
  ['mac', 'TEXT', 1, 0],
]);
const SQLITE_BUSY_CODES = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED']);
const INITIALIZATION_RETRY_ATTEMPTS = 8;
const INITIALIZATION_RETRY_DELAY_MS = 10;

const hasExactlyKeys = (value, expectedKeys) => value !== null
  && typeof value === 'object'
  && !Array.isArray(value)
  && Object.keys(value).length === expectedKeys.length
  && expectedKeys.every((key) => Object.hasOwn(value, key));

const isSafeNonNegativeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

const normalizeSql = (value) => String(value ?? '')
  .replace(/\s+/g, ' ')
  .trim()
  .replace(/;$/, '');

const schemaError = () => new Error('Managed OpenCode handoff v2 store schema is invalid');

const isBusyError = (error) => SQLITE_BUSY_CODES.has(error?.code)
  || /database is locked|database schema is locked/i.test(String(error?.message ?? ''));

const sleepSynchronously = (milliseconds) => {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, milliseconds);
};

const withInitializationRetry = (operation) => {
  let lastError;
  for (let attempt = 0; attempt < INITIALIZATION_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isBusyError(error) || attempt + 1 === INITIALIZATION_RETRY_ATTEMPTS) throw error;
      sleepSynchronously(INITIALIZATION_RETRY_DELAY_MS * (attempt + 1));
    }
  }
  throw lastError;
};

const getUserSchemaEntries = (database) => database.prepare(`
  SELECT type, name, tbl_name, sql
  FROM sqlite_master
  WHERE type IN ('table', 'index', 'trigger', 'view')
    AND name NOT GLOB 'sqlite_autoindex_*'
    AND name <> 'sqlite_sequence'
    AND name NOT GLOB 'sqlite_stat*'
  ORDER BY type, name
`).all();

const validateTableColumns = (database, tableName, expectedColumns) => {
  const columns = database.prepare(`PRAGMA table_info(${tableName})`).all();
  return columns.length === expectedColumns.length && columns.every((column, index) => {
    const [name, type, notnull, pk] = expectedColumns[index];
    return column.cid === index
      && column.name === name
      && column.type === type
      && column.notnull === notnull
      && column.pk === pk
      && column.dflt_value === null;
  });
};

const validateExactSchema = (database, { allowLegacy = false, allowOperationLegacy = false } = {}) => {
  const userVersion = database.pragma('user_version', { simple: true });
  const applicationId = database.pragma('application_id', { simple: true });
  if (
    applicationId !== STORE_APPLICATION_ID
    || (userVersion !== STORE_USER_VERSION
      && userVersion !== OPERATION_STORE_USER_VERSION
      && (!allowLegacy || userVersion !== LEGACY_STORE_USER_VERSION))
  ) {
    throw schemaError();
  }

  const entries = getUserSchemaEntries(database);
  const legacyEntries = entries.length === 2
    && entries[0].type === 'index'
    && entries[0].name === STORE_EXPIRY_INDEX
    && entries[0].tbl_name === STORE_TABLE
    && normalizeSql(entries[0].sql) === normalizeSql(CREATE_EXPIRY_INDEX_SQL)
    && entries[1].type === 'table'
    && entries[1].name === STORE_TABLE
    && entries[1].tbl_name === STORE_TABLE
    && normalizeSql(entries[1].sql) === normalizeSql(CREATE_TABLE_SQL);
  const operationTableSql = userVersion === OPERATION_STORE_USER_VERSION && allowOperationLegacy
    ? CREATE_OPERATION_TABLE_SQL_LEGACY
    : CREATE_OPERATION_TABLE_SQL;
  const currentEntries = entries.length === 4
    && entries.some((entry) => entry.type === 'index'
      && entry.name === STORE_EXPIRY_INDEX
      && entry.tbl_name === STORE_TABLE
      && normalizeSql(entry.sql) === normalizeSql(CREATE_EXPIRY_INDEX_SQL))
    && entries.some((entry) => entry.type === 'table'
      && entry.name === STORE_TABLE
      && entry.tbl_name === STORE_TABLE
      && normalizeSql(entry.sql) === normalizeSql(CREATE_TABLE_SQL))
    && entries.some((entry) => entry.type === 'index'
      && entry.name === STORE_OPERATION_EXPIRY_INDEX
      && entry.tbl_name === STORE_OPERATION_TABLE
      && normalizeSql(entry.sql) === normalizeSql(CREATE_OPERATION_EXPIRY_INDEX_SQL))
    && entries.some((entry) => entry.type === 'table'
      && entry.name === STORE_OPERATION_TABLE
      && entry.tbl_name === STORE_OPERATION_TABLE
       && normalizeSql(entry.sql) === normalizeSql(operationTableSql));
  if ((userVersion === LEGACY_STORE_USER_VERSION && !legacyEntries)
    || ((userVersion === STORE_USER_VERSION || userVersion === OPERATION_STORE_USER_VERSION) && !currentEntries)) {
    throw schemaError();
  }

  if (!validateTableColumns(database, STORE_TABLE, EXPECTED_TABLE_COLUMNS)) {
    throw schemaError();
  }

  if ((userVersion === STORE_USER_VERSION || userVersion === OPERATION_STORE_USER_VERSION)
    && !validateTableColumns(database, STORE_OPERATION_TABLE, EXPECTED_OPERATION_TABLE_COLUMNS)) {
    throw schemaError();
  }

  const indexes = database.prepare(`PRAGMA index_list(${STORE_TABLE})`).all();
  const primaryKeyIndex = `sqlite_autoindex_${STORE_TABLE}_1`;
  if (indexes.length !== 2
    || !indexes.some((index) => index.name === STORE_EXPIRY_INDEX
      && index.unique === 0 && index.origin === 'c' && index.partial === 0)
    || !indexes.some((index) => index.name === primaryKeyIndex
      && index.unique === 1 && index.origin === 'pk' && index.partial === 0)) {
    throw schemaError();
  }

  const expiryIndexColumns = database.prepare(`PRAGMA index_info(${STORE_EXPIRY_INDEX})`).all();
  if (
    expiryIndexColumns.length !== 1
    || expiryIndexColumns[0].seqno !== 0
    || expiryIndexColumns[0].cid !== 12
    || expiryIndexColumns[0].name !== 'lease_expires_at'
  ) {
    throw schemaError();
  }

  if (userVersion === STORE_USER_VERSION || userVersion === OPERATION_STORE_USER_VERSION) {
    const operationIndexes = database.prepare(`PRAGMA index_list(${STORE_OPERATION_TABLE})`).all();
    const operationPrimaryKeyIndex = `sqlite_autoindex_${STORE_OPERATION_TABLE}_1`;
    if (operationIndexes.length !== 2
      || !operationIndexes.some((index) => index.name === STORE_OPERATION_EXPIRY_INDEX
        && index.unique === 0 && index.origin === 'c' && index.partial === 0)
      || !operationIndexes.some((index) => index.name === operationPrimaryKeyIndex
        && index.unique === 1 && index.origin === 'pk' && index.partial === 0)) {
      throw schemaError();
    }
    const operationExpiryColumns = database.prepare(`PRAGMA index_info(${STORE_OPERATION_EXPIRY_INDEX})`).all();
    if (operationExpiryColumns.length !== 1
      || operationExpiryColumns[0].seqno !== 0
      || operationExpiryColumns[0].cid !== 16
      || operationExpiryColumns[0].name !== 'confirmation_expires_at') {
      throw schemaError();
    }
  }
};

const normalizeExpected = (value) => {
  if (!hasExactlyKeys(value, EXPECTED_KEYS)) return null;
  if (!isSafeNonNegativeInteger(value.revision) || !isSafeNonNegativeInteger(value.leaseExpiresAt)) {
    return null;
  }
  if (typeof value.mac !== 'string' || value.mac.length === 0) return null;
  return {
    revision: value.revision,
    mac: value.mac,
    leaseExpiresAt: value.leaseExpiresAt,
  };
};

const normalizeOperationExpected = (value) => {
  if (!hasExactlyKeys(value, ['revision', 'mac', 'confirmationExpiresAt'])) return null;
  if (!isSafeNonNegativeInteger(value.revision)
    || !isSafeNonNegativeInteger(value.confirmationExpiresAt)
    || typeof value.mac !== 'string'
    || value.mac.length === 0) return null;
  return {
    revision: value.revision,
    mac: value.mac,
    confirmationExpiresAt: value.confirmationExpiresAt,
  };
};

const recordToParameters = (record) => [
  record.incarnation,
  record.ownerInstanceId ?? null,
  record.runtimeIdentity ?? null,
  record.launchFingerprint ?? null,
  record.launchSpec ? JSON.stringify(record.launchSpec) : null,
  record.v,
  record.state,
  record.credentialFingerprint,
  record.pid,
  record.port,
  record.processStartTicks,
  record.createdAt,
  record.leaseExpiresAt,
  record.revision,
  record.mac,
];

const rowToRecord = (row) => {
  if (!hasExactlyKeys(row, STORE_COLUMNS)) {
    throw new Error('Managed OpenCode handoff v2 store contains a malformed row');
  }
  const record = normalizeManagedOpenCodeHandoffV2Record({
    v: row.version,
    state: row.state,
    incarnation: row.incarnation,
    ownerInstanceId: row.owner_instance_id,
    runtimeIdentity: row.runtime_identity,
    launchFingerprint: row.launch_fingerprint,
    launchSpec: row.launch_spec === null ? null : JSON.parse(row.launch_spec),
    credentialFingerprint: row.credential_fingerprint,
    pid: row.pid,
    port: row.port,
    processStartTicks: row.process_start_ticks,
    createdAt: row.created_at,
    leaseExpiresAt: row.lease_expires_at,
    revision: row.revision,
    mac: row.mac,
  });
  if (!record) throw new Error('Managed OpenCode handoff v2 store contains a corrupt record');
  return record;
};

const operationToParameters = (operation) => [
  operation.operationId,
  operation.v,
  operation.kind,
  operation.incarnation,
  operation.ownerInstanceId,
  operation.runtimeIdentity,
  operation.launchFingerprint,
  operation.targetRevision,
  operation.targetLeaseExpiresAt,
  operation.targetMac,
  operation.state,
  operation.resolutionState,
  operation.resolutionRevision,
  operation.resolutionLeaseExpiresAt,
  operation.resolutionMac,
  operation.createdAt,
  operation.confirmationExpiresAt,
  operation.revision,
  operation.mac,
];

const rowToOperation = (row) => {
  if (!hasExactlyKeys(row, OPERATION_COLUMNS)) {
    throw new Error('Managed OpenCode handoff v2 store contains a malformed operation row');
  }
  const operation = normalizeManagedOpenCodeHandoffV2Operation({
    v: row.version,
    operationId: row.operation_id,
    kind: row.kind,
    incarnation: row.incarnation,
    ownerInstanceId: row.owner_instance_id,
    runtimeIdentity: row.runtime_identity,
    launchFingerprint: row.launch_fingerprint,
    targetRevision: row.target_revision,
    targetLeaseExpiresAt: row.target_lease_expires_at,
    targetMac: row.target_mac,
    state: row.state,
    resolutionState: row.resolution_state,
    resolutionRevision: row.resolution_revision,
    resolutionLeaseExpiresAt: row.resolution_lease_expires_at,
    resolutionMac: row.resolution_mac,
    createdAt: row.created_at,
    confirmationExpiresAt: row.confirmation_expires_at,
    revision: row.revision,
    mac: row.mac,
  });
  if (!operation) throw new Error('Managed OpenCode handoff v2 store contains a corrupt operation');
  return operation;
};

const assertExistingDatabaseFile = (
  databasePath,
  platform,
  { username, aclInspector, reparseChecker } = {},
) => {
  try {
    assertPrivateRegularFile(databasePath, 0o600, {
      platform,
      username,
      aclInspector,
      reparseChecker,
    });
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};

const readAuthoritativeTime = (statement) => {
  const value = statement.get()?.now;
  if (!isSafeNonNegativeInteger(value)) {
    throw new Error('Managed OpenCode handoff v2 store clock is invalid');
  }
  return value;
};

/**
 * Opens the v2-only SQLite store. It deliberately uses a separate directory
 * and database from the legacy JSON managed-process registry.
 */
export const createManagedOpenCodeHandoffV2Store = ({
  rootDir,
  busyTimeoutMs = 5_000,
  platform = process.platform,
  username,
  aclInspector,
  reparseChecker,
} = {}) => {
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs <= 0 || busyTimeoutMs > 60_000) {
    throw new TypeError('Managed OpenCode handoff v2 store received an invalid busy timeout');
  }

  const rootPath = ensurePrivateDirectory(
    resolveManagedOpenCodeHandoffV2Root(rootDir),
    { platform, username, aclInspector, reparseChecker },
  );
  const databasePath = path.join(rootPath, MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME);
  const existed = assertExistingDatabaseFile(databasePath, platform, {
    username,
    aclInspector,
    reparseChecker,
  });
  let database;
  let closed = false;

  try {
    database = new Database(databasePath);
    if (!existed && platform !== 'win32') fs.chmodSync(databasePath, 0o600);
    withInitializationRetry(() => {
      database.pragma(`busy_timeout = ${busyTimeoutMs}`);
      const journalMode = database.pragma('journal_mode = WAL', { simple: true });
      if (String(journalMode).toLowerCase() !== 'wal') {
        throw new Error('Managed OpenCode handoff v2 store could not enable WAL');
      }
      database.pragma('synchronous = FULL');
      database.pragma('foreign_keys = ON');
      database.pragma('trusted_schema = OFF');
      if (
        Number(database.pragma('busy_timeout', { simple: true })) !== busyTimeoutMs
        || Number(database.pragma('synchronous', { simple: true })) !== 2
        || Number(database.pragma('foreign_keys', { simple: true })) !== 1
        || Number(database.pragma('trusted_schema', { simple: true })) !== 0
      ) {
        throw new Error('Managed OpenCode handoff v2 store pragmas are invalid');
      }
    });

    withInitializationRetry(() => {
      let transactionOpen = false;
      try {
        database.exec('BEGIN IMMEDIATE');
        transactionOpen = true;
        const existingEntries = getUserSchemaEntries(database);
        if (existingEntries.length === 0) {
          if (
            database.pragma('user_version', { simple: true }) !== 0
            || database.pragma('application_id', { simple: true }) !== 0
          ) {
            throw schemaError();
          }
          database.exec(CREATE_TABLE_SQL);
          database.exec(CREATE_EXPIRY_INDEX_SQL);
          database.exec(CREATE_OPERATION_TABLE_SQL);
          database.exec(CREATE_OPERATION_EXPIRY_INDEX_SQL);
          database.pragma(`user_version = ${STORE_USER_VERSION}`);
          database.pragma(`application_id = ${STORE_APPLICATION_ID}`);
        } else if (
          database.pragma('user_version', { simple: true }) === LEGACY_STORE_USER_VERSION
        ) {
          validateExactSchema(database, { allowLegacy: true });
          database.exec(CREATE_OPERATION_TABLE_SQL);
          database.exec(CREATE_OPERATION_EXPIRY_INDEX_SQL);
          database.pragma(`user_version = ${STORE_USER_VERSION}`);
        } else if (
          database.pragma('user_version', { simple: true }) === OPERATION_STORE_USER_VERSION
        ) {
          // 2421008 introduced the operation table.  2421009 widens its
          // resolution domain to include the durable prepare-handoff state.
          // Rebuild the strict table inside this transaction so a malformed
          // row, failed insert, or failed index creation rolls the migration
          // back to the known-good 2421008 database.
          validateExactSchema(database, { allowOperationLegacy: true });
          database.exec(`DROP INDEX ${STORE_OPERATION_EXPIRY_INDEX}`);
          database.exec(`ALTER TABLE ${STORE_OPERATION_TABLE} RENAME TO ${STORE_OPERATION_TABLE}_legacy`);
          database.exec(CREATE_OPERATION_TABLE_SQL);
          database.exec(`
            INSERT INTO ${STORE_OPERATION_TABLE} (${OPERATION_COLUMNS.join(', ')})
            SELECT ${OPERATION_COLUMNS.join(', ')} FROM ${STORE_OPERATION_TABLE}_legacy
          `);
          database.exec(`DROP TABLE ${STORE_OPERATION_TABLE}_legacy`);
          database.exec(CREATE_OPERATION_EXPIRY_INDEX_SQL);
          database.pragma(`user_version = ${STORE_USER_VERSION}`);
        }
        validateExactSchema(database);
        database.exec('COMMIT');
        transactionOpen = false;
      } finally {
        if (transactionOpen) {
          try { database.exec('ROLLBACK'); } catch {}
        }
      }
    });

    assertPrivateRegularFile(databasePath, 0o600, {
      platform,
      username,
      aclInspector,
      reparseChecker,
    });
    fsyncDirectory(rootPath, { platform });
  } catch (error) {
    try { database?.close(); } catch {}
    throw error;
  }

  const statements = {
    read: database.prepare(`SELECT ${STORE_COLUMNS.join(', ')} FROM ${STORE_TABLE} WHERE incarnation = ?`),
    all: database.prepare(`SELECT ${STORE_COLUMNS.join(', ')} FROM ${STORE_TABLE} ORDER BY incarnation`),
    insert: database.prepare(`
      INSERT INTO ${STORE_TABLE} (
        ${STORE_COLUMNS.join(', ')}
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    update: database.prepare(`
      UPDATE ${STORE_TABLE}
      SET owner_instance_id = ?, runtime_identity = ?, launch_fingerprint = ?, launch_spec = ?,
          version = ?, state = ?, credential_fingerprint = ?, pid = ?, port = ?,
          process_start_ticks = ?, created_at = ?, lease_expires_at = ?, revision = ?, mac = ?
      WHERE incarnation = ?
        AND revision = ?
        AND mac = ?
        AND lease_expires_at = ?
        AND lease_expires_at > ?
    `),
    updateExpiredRecovery: database.prepare(`
      UPDATE ${STORE_TABLE}
      SET owner_instance_id = ?, runtime_identity = ?, launch_fingerprint = ?, launch_spec = ?,
          version = ?, state = ?, credential_fingerprint = ?, pid = ?, port = ?,
          process_start_ticks = ?, created_at = ?, lease_expires_at = ?, revision = ?, mac = ?
      WHERE incarnation = ?
        AND revision = ?
        AND mac = ?
        AND lease_expires_at = ?
    `),
    authoritativeTime: database.prepare(
      "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now",
    ),
    readOperation: database.prepare(`SELECT ${OPERATION_COLUMNS.join(', ')} FROM ${STORE_OPERATION_TABLE} WHERE operation_id = ?`),
    allOperations: database.prepare(`SELECT ${OPERATION_COLUMNS.join(', ')} FROM ${STORE_OPERATION_TABLE} ORDER BY operation_id`),
    insertOperation: database.prepare(`
      INSERT INTO ${STORE_OPERATION_TABLE} (${OPERATION_COLUMNS.join(', ')})
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    updateOperation: database.prepare(`
      UPDATE ${STORE_OPERATION_TABLE}
      SET version = ?, kind = ?, incarnation = ?, owner_instance_id = ?, runtime_identity = ?, launch_fingerprint = ?,
          target_revision = ?, target_lease_expires_at = ?, target_mac = ?, state = ?, resolution_state = ?,
          resolution_revision = ?, resolution_lease_expires_at = ?, resolution_mac = ?, created_at = ?,
          confirmation_expires_at = ?, revision = ?, mac = ?
      WHERE operation_id = ? AND revision = ? AND mac = ? AND confirmation_expires_at = ?
    `),
  };

  try {
    statements.all.all().map(rowToRecord);
    statements.allOperations.all().map(rowToOperation);
  } catch (error) {
    try { database.close(); } catch {}
    throw error;
  }

  const assertOpen = () => {
    if (closed) throw new Error('Managed OpenCode handoff v2 store is closed');
  };

  const auditRows = () => statements.all.all().map(rowToRecord);

  const runImmediate = (operation) => {
    database.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const result = operation();
      database.exec('COMMIT');
      committed = true;
      return result;
    } finally {
      if (!committed) {
        try { database.exec('ROLLBACK'); } catch {}
      }
    }
  };

  return Object.freeze({
    read: async ({ incarnation } = {}) => {
      assertOpen();
      if (!isManagedOpenCodeHandoffV2Incarnation(incarnation)) {
        throw new TypeError('Invalid managed OpenCode handoff v2 incarnation');
      }
      const row = statements.read.get(incarnation);
      return row === undefined ? null : rowToRecord(row);
    },
    compareAndSwap: async ({ incarnation, expected, next, nextForAuthoritativeTime, allowExpired = false } = {}) => {
      assertOpen();
      if (!isManagedOpenCodeHandoffV2Incarnation(incarnation)) {
        throw new TypeError('Invalid managed OpenCode handoff v2 incarnation');
      }
      const normalizedExpected = expected === null ? null : normalizeExpected(expected);
      const hasStaticNext = next !== undefined;
      const hasAuthoritativeBuilder = typeof nextForAuthoritativeTime === 'function';
      const normalizedStaticNext = hasStaticNext
        ? normalizeManagedOpenCodeHandoffV2Record(next)
        : null;
      if (
        (expected !== null && !normalizedExpected)
        || hasStaticNext === hasAuthoritativeBuilder
        || (hasStaticNext && (!normalizedStaticNext || normalizedStaticNext.incarnation !== incarnation))
        || (allowExpired !== true && allowExpired !== false)
      ) {
        throw new TypeError('Invalid managed OpenCode handoff v2 compare-and-swap input');
      }

      return runImmediate(() => {
        const currentRow = statements.read.get(incarnation);
        const current = currentRow === undefined ? null : rowToRecord(currentRow);
        const now = readAuthoritativeTime(statements.authoritativeTime);
        const maxLeaseExpiresAt = now + MANAGED_OPENCODE_HANDOFF_V2_MAX_LEASE_MS;
        if (!Number.isSafeInteger(maxLeaseExpiresAt)) {
          throw new Error('Managed OpenCode handoff v2 store clock is invalid');
        }

        if (normalizedExpected === null) {
          if (current !== null) return { status: 'conflict' };
        } else {
          if (current === null) return { status: 'conflict' };
          if (
            current.revision !== normalizedExpected.revision
            || current.mac !== normalizedExpected.mac
            || current.leaseExpiresAt !== normalizedExpected.leaseExpiresAt
          ) {
            return { status: 'conflict' };
          }
          if (!allowExpired && (current.leaseExpiresAt <= now || normalizedExpected.leaseExpiresAt <= now)) {
            return { status: 'expired' };
          }
        }

        const candidate = hasAuthoritativeBuilder
          ? nextForAuthoritativeTime(now)
          : normalizedStaticNext;
        const normalizedNext = normalizeManagedOpenCodeHandoffV2Record(candidate);
        if (!normalizedNext || normalizedNext.incarnation !== incarnation) {
          throw new TypeError('Invalid managed OpenCode handoff v2 compare-and-swap candidate');
        }
        if (
          normalizedNext.leaseExpiresAt <= now
            && (!allowExpired
              || ![
                ManagedOpenCodeHandoffV2State.Interrupted,
                ManagedOpenCodeHandoffV2State.Stopping,
                ManagedOpenCodeHandoffV2State.Retired,
              ].includes(normalizedNext.state))
        ) {
          return { status: 'expired' };
        }
        if (normalizedNext.leaseExpiresAt > maxLeaseExpiresAt) {
          throw new TypeError('Managed OpenCode handoff v2 lease exceeds the maximum horizon');
        }

        if (normalizedExpected === null) {
          statements.insert.run(...recordToParameters(normalizedNext));
          return { status: 'applied' };
        }

        const updateParameters = [
          normalizedNext.ownerInstanceId,
          normalizedNext.runtimeIdentity,
          normalizedNext.launchFingerprint,
          normalizedNext.launchSpec ? JSON.stringify(normalizedNext.launchSpec) : null,
          normalizedNext.v,
          normalizedNext.state,
          normalizedNext.credentialFingerprint,
          normalizedNext.pid,
          normalizedNext.port,
          normalizedNext.processStartTicks,
          normalizedNext.createdAt,
          normalizedNext.leaseExpiresAt,
          normalizedNext.revision,
          normalizedNext.mac,
          normalizedNext.incarnation,
          normalizedExpected.revision,
          normalizedExpected.mac,
          normalizedExpected.leaseExpiresAt,
        ];
        const result = allowExpired
          ? statements.updateExpiredRecovery.run(...updateParameters)
          : statements.update.run(...updateParameters, now);
        return result.changes === 1 ? { status: 'applied' } : { status: 'conflict' };
      });
    },
    readOperation: async ({ operationId } = {}) => {
      assertOpen();
      if (!isManagedOpenCodeHandoffV2OperationId(operationId)) {
        throw new TypeError('Invalid managed OpenCode handoff v2 operation ID');
      }
      const row = statements.readOperation.get(operationId);
      return row === undefined ? null : rowToOperation(row);
    },
    compareAndSwapOperation: async ({ operationId, expected, next, nextForAuthoritativeTime, allowExpired = false } = {}) => {
      assertOpen();
      const normalizedExpected = expected === null ? null : normalizeOperationExpected(expected);
      const hasStaticNext = next !== undefined;
      const hasAuthoritativeBuilder = typeof nextForAuthoritativeTime === 'function';
      const normalizedStaticNext = hasStaticNext
        ? normalizeManagedOpenCodeHandoffV2Operation(next)
        : null;
      if (
        !isManagedOpenCodeHandoffV2OperationId(operationId)
        || (expected !== null && !normalizedExpected)
        || hasStaticNext === hasAuthoritativeBuilder
        || (hasStaticNext && (!normalizedStaticNext || normalizedStaticNext.operationId !== operationId))
        || (allowExpired !== true && allowExpired !== false)
      ) {
        throw new TypeError('Invalid managed OpenCode handoff v2 operation compare-and-swap input');
      }

      return runImmediate(() => {
        const currentRow = statements.readOperation.get(operationId);
        const current = currentRow === undefined ? null : rowToOperation(currentRow);
        const now = readAuthoritativeTime(statements.authoritativeTime);
        const maxHorizon = now + MANAGED_OPENCODE_HANDOFF_V2_MAX_LEASE_MS;
        if (!Number.isSafeInteger(maxHorizon)) throw new Error('Managed OpenCode handoff v2 operation clock is invalid');
        if (normalizedExpected === null) {
          if (current !== null) return { status: 'conflict' };
        } else {
          if (current === null) return { status: 'conflict' };
          if (current.revision !== normalizedExpected.revision
            || current.mac !== normalizedExpected.mac
            || current.confirmationExpiresAt !== normalizedExpected.confirmationExpiresAt) {
            return { status: 'conflict' };
          }
          if (!allowExpired && current.confirmationExpiresAt <= now) return { status: 'expired' };
        }
        const candidate = hasAuthoritativeBuilder
          ? nextForAuthoritativeTime(now)
          : normalizedStaticNext;
        const normalizedNext = normalizeManagedOpenCodeHandoffV2Operation(candidate);
        if (!normalizedNext || normalizedNext.operationId !== operationId) {
          throw new TypeError('Invalid managed OpenCode handoff v2 operation candidate');
        }
        if (normalizedNext.confirmationExpiresAt > maxHorizon) {
          throw new TypeError('Managed OpenCode handoff v2 operation exceeds the maximum horizon');
        }
        if (normalizedNext.confirmationExpiresAt <= now
          && (!allowExpired || normalizedNext.state !== 'expired')) {
          return { status: 'expired' };
        }
        if (normalizedExpected === null) {
          statements.insertOperation.run(...operationToParameters(normalizedNext));
          return { status: 'applied' };
        }
        const updateParameters = [
          normalizedNext.v,
          normalizedNext.kind,
          normalizedNext.incarnation,
          normalizedNext.ownerInstanceId,
          normalizedNext.runtimeIdentity,
          normalizedNext.launchFingerprint,
          normalizedNext.targetRevision,
          normalizedNext.targetLeaseExpiresAt,
          normalizedNext.targetMac,
          normalizedNext.state,
          normalizedNext.resolutionState,
          normalizedNext.resolutionRevision,
          normalizedNext.resolutionLeaseExpiresAt,
          normalizedNext.resolutionMac,
          normalizedNext.createdAt,
          normalizedNext.confirmationExpiresAt,
          normalizedNext.revision,
          normalizedNext.mac,
          normalizedNext.operationId,
          normalizedExpected.revision,
          normalizedExpected.mac,
          normalizedExpected.confirmationExpiresAt,
        ];
        const result = statements.updateOperation.run(...updateParameters);
        return result.changes === 1 ? { status: 'applied' } : { status: 'conflict' };
      });
    },
    hasV2Records: async () => {
      assertOpen();
      return auditRows().length > 0;
    },
    list: async () => {
      assertOpen();
      return auditRows();
    },
    listOperations: async () => {
      assertOpen();
      return statements.allOperations.all().map(rowToOperation);
    },
    cleanup: async ({ protectedIncarnations = [] } = {}) => {
      assertOpen();
      const protectedValues = [...new Set(protectedIncarnations)].filter(
        (incarnation) => isManagedOpenCodeHandoffV2Incarnation(incarnation),
      );
      return runImmediate(() => {
        auditRows();
        const now = readAuthoritativeTime(statements.authoritativeTime);
        const exclusion = protectedValues.length > 0
          ? `\n        AND incarnation NOT IN (${protectedValues.map(() => '?').join(', ')})`
          : '';
        const result = database.prepare(`
          DELETE FROM ${STORE_TABLE}
          WHERE lease_expires_at <= ?
            AND state IN (?, ?)
            AND NOT EXISTS (
              SELECT 1 FROM ${STORE_OPERATION_TABLE} operation
              WHERE operation.incarnation = ${STORE_TABLE}.incarnation
                AND operation.state IN ('pending', 'expired')
            )
            ${exclusion}
        `).run(now, ...SAFE_CLEANUP_STATES, ...protectedValues);
        // Resolved operations are signed lifecycle tombstones. Retain them
        // after their confirmation horizon so an HMR/web-process restart can
        // distinguish authoritative resolution from ordinary row absence even
        // after the terminal child row is pruned. Unresolved rows remain
        // durable for the same reason; neither kind is replayed.
        return { removed: result.changes };
      });
    },
    close: async () => {
      if (closed) return;
      database.close();
      closed = true;
    },
  });
};
