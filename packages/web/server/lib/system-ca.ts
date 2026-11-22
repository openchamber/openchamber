import tls from 'node:tls';


const usesOpenSslStore = (execArgv: readonly string[], nodeOptions: string) =>
  execArgv.includes('--use-openssl-ca') || /(^|\s)--use-openssl-ca(\s|$)/.test(nodeOptions);

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
