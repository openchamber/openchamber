
interface HelperVersions {
  [name: string]: string | undefined;
}

interface HelperLaunchOptions {
  execPath?: string;
  versions?: HelperVersions;
}

const shellQuote = (value: string) => `'${String(value).replace(/'/g, `'\\''`)}'`;

const runsAsElectron = (versions: HelperVersions = process.versions) => Boolean(versions?.electron);

export const helperShellCommand = (scriptPath: string, args: string[] = [], { execPath = process.execPath, versions = process.versions }: HelperLaunchOptions = {}) => {
  const prefix = runsAsElectron(versions) ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
  return `${prefix}${[execPath, scriptPath, ...args].map(shellQuote).join(' ')}`;
};

export const helperSpawnEnv = (base: NodeJS.ProcessEnv = process.env, { versions = process.versions }: Pick<HelperLaunchOptions, 'versions'> = {}) => (runsAsElectron(versions)
  ? { ...base, ELECTRON_RUN_AS_NODE: '1' }
  : { ...base });
