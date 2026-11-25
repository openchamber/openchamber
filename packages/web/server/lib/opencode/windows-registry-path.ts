import path from 'node:path';

export const WINDOWS_REGISTRY_PATH_KEYS = [
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
  'HKCU\\Environment',
];

export const windowsRegistryPathQuery = (key: string) => ({
  command: path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'),
  args: ['query', key, '/v', 'Path'],
});

export const expandWindowsEnvReferences = (value: string) => (
  value.replace(/%([^%]+)%/g, (reference, name: string) => process.env[name] ?? reference)
);

export const parseWindowsRegistryPath = (stdout: string) => {
  const [, type = '', value = ''] = /^[ \t]*Path[ \t]+(REG_\S+)[ \t]+(.+?)\s*$/im.exec(stdout) ?? [];
  return { type, value };
};
