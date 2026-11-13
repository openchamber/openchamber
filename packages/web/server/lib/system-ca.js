import tls from 'node:tls';

// Node verifies TLS against its bundled CA list plus NODE_EXTRA_CA_CERTS and
// ignores the operating system's trust store, so a GitHub Enterprise or
// self-hosted GitLab behind a company CA fails with "self-signed certificate
// in certificate chain" even though gh, curl and the browser trust it (#5703).
// The server adds the system store to the defaults once at load, which every
// later fetch and https request without its own `ca` uses. Trusting what the
// OS trusts matches those tools, so it is always on. Runtimes without the API
// (Bun) are a no-op.
//
// Under --use-openssl-ca the OpenSSL store (SSL_CERT_FILE, SSL_CERT_DIR) is
// missing from the 'default' list, so replacing the defaults would drop it;
// a process started that way keeps the trust it chose.

const usesOpenSslStore = (execArgv, nodeOptions) =>
  execArgv.includes('--use-openssl-ca') || /(^|\s)--use-openssl-ca(\s|$)/.test(nodeOptions);

/**
 * Add the operating system's trusted CA certificates to this process's
 * default TLS trust. Returns whether the defaults were replaced.
 */
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
