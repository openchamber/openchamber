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
  MANAGED_OPENCODE_HANDOFF_V2_MAX_LEASE_MS,
  ManagedOpenCodeHandoffV2State,
  normalizeManagedOpenCodeHandoffV2Record,
} from './record.js';

export const MANAGED_OPENCODE_HANDOFF_V2_STORE_FILENAME = 'records.sqlite3';

const STORE_USER_VERSION = 2_421_007;
const STORE_APPLICATION_ID = 0x4f434832;
const STORE_TABLE = 'managed_opencode_handoff_v2_records';
const STORE_EXPIRY_INDEX = 'managed_opencode_handoff_v2_expiry_idx';
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

const validateExactSchema = (database) => {
  const userVersion = database.pragma('user_version', { simple: true });
  const applicationId = database.pragma('application_id', { simple: true });
  if (userVersion !== STORE_USER_VERSION || applicationId !== STORE_APPLICATION_ID) {
    throw schemaError();
  }

  const entries = getUserSchemaEntries(database);
  if (
    entries.length !== 2
    || entries[0].type !== 'index'
    || entries[0].name !== STORE_EXPIRY_INDEX
    || entries[0].tbl_name !== STORE_TABLE
    || normalizeSql(entries[0].sql) !== normalizeSql(CREATE_EXPIRY_INDEX_SQL)
    || entries[1].type !== 'table'
    || entries[1].name !== STORE_TABLE
    || entries[1].tbl_name !== STORE_TABLE
    || normalizeSql(entries[1].sql) !== normalizeSql(CREATE_TABLE_SQL)
  ) {
    throw schemaError();
  }

  const columns = database.prepare(`PRAGMA table_info(${STORE_TABLE})`).all();
  if (
    columns.length !== EXPECTED_TABLE_COLUMNS.length
    || columns.some((column, index) => {
      const [name, type, notnull, pk] = EXPECTED_TABLE_COLUMNS[index];
      return column.cid !== index
        || column.name !== name
        || column.type !== type
        || column.notnull !== notnull
        || column.pk !== pk
        || column.dflt_value !== null;
    })
  ) {
    throw schemaError();
  }

  const indexes = database.prepare(`PRAGMA index_list(${STORE_TABLE})`).all();
  const primaryKeyIndex = `sqlite_autoindex_${STORE_TABLE}_1`;
  if (
    indexes.length !== 2
    || !indexes.some((index) => index.name === STORE_EXPIRY_INDEX
      && index.unique === 0 && index.origin === 'c' && index.partial === 0)
    || !indexes.some((index) => index.name === primaryKeyIndex
      && index.unique === 1 && index.origin === 'pk' && index.partial === 0)
  ) {
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
          database.pragma(`user_version = ${STORE_USER_VERSION}`);
          database.pragma(`application_id = ${STORE_APPLICATION_ID}`);
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
    deleteExpired: database.prepare(`
      DELETE FROM ${STORE_TABLE}
      WHERE lease_expires_at <= ?
        AND state IN (?, ?)
    `),
    authoritativeTime: database.prepare(
      "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now",
    ),
  };

  try {
    statements.all.all().map(rowToRecord);
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
    hasV2Records: async () => {
      assertOpen();
      return auditRows().length > 0;
    },
    list: async () => {
      assertOpen();
      return auditRows();
    },
    cleanup: async () => {
      assertOpen();
      return runImmediate(() => {
        auditRows();
        const now = readAuthoritativeTime(statements.authoritativeTime);
        const result = statements.deleteExpired.run(now, ...SAFE_CLEANUP_STATES);
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
