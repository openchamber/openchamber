import tls from 'node:tls';

// external: #5703 Node's bundled trust excludes company system CAs; add system trust without dropping an explicitly selected OpenSSL store.

const usesOpenSslStore = (execArgv, nodeOptions) =>
  execArgv.includes('--use-openssl-ca') || /(^|\s)--use-openssl-ca(\s|$)/.test(nodeOptions);

export const applySystemCertificates = ({
  tlsModule = tls,
  execArgv = process.execArgv,
  nodeOptions = process.env.NODE_OPTIONS ?? '',
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
    console.warn('Could not add the system CA certificates:', error?.message || error);
    return false;
  }
};
