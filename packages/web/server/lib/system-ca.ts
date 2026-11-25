import tls from 'node:tls';

const splitNodeOptions = (nodeOptions: string) =>
  (nodeOptions.match(/(?:"(?:\\.|[^"\\])*"|[^ "])+/gs) ?? []).map((option) =>
    option.replace(/"((?:\\.|[^"\\])*)"/gs, (_, quoted: string) => quoted.replace(/\\(.)/gs, '$1')));

const usesOpenSslStore = (execArgv: readonly string[], nodeOptions: string) =>
  [...splitNodeOptions(nodeOptions), ...execArgv]
    .map((option) => option.replace(/=.*$/s, '').replaceAll('_', '-'))
    .findLast((name) => name === '--use-openssl-ca' || name === '--no-use-openssl-ca') === '--use-openssl-ca';

const hasErrorMessage = (value: unknown): value is { message?: unknown } =>
  value !== null && (typeof value === 'object' || typeof value === 'function');

export const applySystemCertificates = ({
  tlsModule = tls,
  execArgv = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS ?? '',
}: {
  tlsModule?: Pick<typeof tls, 'getCACertificates' | 'setDefaultCACertificates'>;
  execArgv?: readonly string[];
  nodeOptions?: string;
} = {}) => {
  if (usesOpenSslStore(execArgv, nodeOptions)) return false;
  try {
    const defaults = tlsModule.getCACertificates('default');
    const system = tlsModule.getCACertificates('system');
    const added = system.filter((certificate) => !defaults.includes(certificate));
    if (added.length === 0) return false;
    tlsModule.setDefaultCACertificates([...defaults, ...added]);
    return true;
  } catch (error) {
    console.warn('Could not add the system CA certificates:', hasErrorMessage(error) ? error.message || error : error);
    return false;
  }
};
