
const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const runsAsElectron = (versions = process.versions) => Boolean(versions?.electron);

export const helperShellCommand = (scriptPath, args = [], { execPath = process.execPath, versions = process.versions } = {}) => {
  const prefix = runsAsElectron(versions) ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `${prefix}${[execPath, scriptPath, ...args].map(shellQuote).join(' ')}`;
};

export const helperSpawnEnv = (base = process.env, { versions = process.versions } = {}) => (runsAsElectron(versions)
  ? { ...base, ELECTRON_RUN_AS_NODE: '1' }
  : { ...base });
