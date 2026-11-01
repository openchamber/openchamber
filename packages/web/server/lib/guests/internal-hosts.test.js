import { describe, expect, it } from 'vitest';

import { downloadZip } from './install.js';
import {
  gitNetworkArgs,
  installTrust,
  isInstallableUrl,
  isInstallableZipUrl,
  parseGitInstallUrl,
  publicAddressesOf,
} from './clone.js';

const LINUX_POLICY = '/etc/openchamber/policy.json';

/** A machine whose policy file lists `origins` as the trusted plain-HTTP Git origins. */
const policyWith = (origins) => ({
  platform: 'linux',
  env: {},
  readFile: (filePath) => {
    if (filePath !== LINUX_POLICY) throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
    return JSON.stringify({ enterpriseMode: true, allowedInsecureGitOrigins: origins });
  },
});

const trusted = installTrust(policyWith(['http://gitlab.corp.internal:8080']));
const untrusted = installTrust(policyWith([]));

const lanLookup = async () => [{ address: '10.1.2.3' }];

describe('installTrust', () => {
  it('trusts nothing unless the policy lists a host', () => {
    expect(untrusted.hosts.size).toBe(0);
    expect(untrusted.origins.size).toBe(0);
  });

  it('keeps the exact origins and the bare hosts of the list', () => {
    expect([...trusted.origins]).toEqual(['http://gitlab.corp.internal:8080']);
    expect([...trusted.hosts]).toEqual(['gitlab.corp.internal']);
  });
});

describe('isInstallableUrl', () => {
  it('refuses an internal host and plain http by default, exactly as before', () => {
    expect(isInstallableUrl('https://gitlab.corp.internal/team/panel.git', untrusted)).toBe(false);
    expect(isInstallableUrl('http://gitlab.corp.internal:8080/team/panel.git', untrusted)).toBe(false);
    expect(isInstallableUrl('http://example.com/panel.git', untrusted)).toBe(false);
    expect(isInstallableUrl('https://example.com/panel.git', untrusted)).toBe(true);
  });

  it('accepts https on a listed host whatever the port, and http only on the listed origin', () => {
    expect(isInstallableUrl('https://gitlab.corp.internal/team/panel.git', trusted)).toBe(true);
    expect(isInstallableUrl('https://gitlab.corp.internal:8443/team/panel.git', trusted)).toBe(true);
    expect(isInstallableUrl('http://gitlab.corp.internal:8080/team/panel.git', trusted)).toBe(true);
    expect(isInstallableUrl('http://gitlab.corp.internal:9090/team/panel.git', trusted)).toBe(false);
    expect(isInstallableUrl('http://gitlab.corp.internal/team/panel.git', trusted)).toBe(false);
  });

  it('does not extend trust to other internal hosts or to credentials in the URL', () => {
    expect(isInstallableUrl('https://wiki.corp.internal/panel.git', trusted)).toBe(false);
    expect(isInstallableUrl('https://10.0.0.5/panel.git', trusted)).toBe(false);
    expect(isInstallableUrl('https://user:pw@gitlab.corp.internal/panel.git', trusted)).toBe(false);
  });

  it('never opens loopback or link-local, even when the list names them', () => {
    const named = installTrust(policyWith(['http://127.0.0.1:8080', 'http://localhost:3000', 'http://169.254.169.254', 'http://[0:0:0:0:0:0:0:1]:8080']));
    for (const url of ['http://127.0.0.1:8080/x.git', 'https://127.0.0.1/x.git', 'http://localhost:3000/x.git', 'https://localhost/x.git', 'http://169.254.169.254/x.git', 'http://[0:0:0:0:0:0:0:1]:8080/x.git']) {
      expect(isInstallableUrl(url, named), url).toBe(false);
    }
  });

  it('accepts a listed private address literal', () => {
    const lan = installTrust(policyWith(['http://10.0.0.5:8080']));
    expect(isInstallableUrl('http://10.0.0.5:8080/team/panel.git', lan)).toBe(true);
    expect(isInstallableUrl('https://10.0.0.5/team/panel.git', lan)).toBe(true);
  });
});

describe('isInstallableZipUrl', () => {
  it('needs the .zip suffix on top of the host rules', () => {
    expect(isInstallableZipUrl('https://gitlab.corp.internal/team/panel.zip', trusted)).toBe(true);
    expect(isInstallableZipUrl('http://gitlab.corp.internal:8080/team/panel.zip', trusted)).toBe(true);
    expect(isInstallableZipUrl('https://gitlab.corp.internal/team/panel.git', trusted)).toBe(false);
    expect(isInstallableZipUrl('https://gitlab.corp.internal/team/panel.zip', untrusted)).toBe(false);
  });
});

describe('parseGitInstallUrl', () => {
  it('takes internal https, ssh and listed http sources and keeps the ref', () => {
    expect(parseGitInstallUrl('https://gitlab.corp.internal/team/panel.git#v1', trusted)).toEqual({ url: 'https://gitlab.corp.internal/team/panel.git', ref: 'v1' });
    expect(parseGitInstallUrl('http://gitlab.corp.internal:8080/team/panel.git', trusted)).toEqual({ url: 'http://gitlab.corp.internal:8080/team/panel.git' });
    expect(parseGitInstallUrl('git@gitlab.corp.internal:team/panel.git', trusted)).toEqual({ url: 'git@gitlab.corp.internal:team/panel.git' });
  });

  it('refuses the same sources when nothing is listed', () => {
    for (const url of ['https://gitlab.corp.internal/team/panel.git', 'http://gitlab.corp.internal:8080/team/panel.git', 'git@gitlab.corp.internal:team/panel.git']) {
      expect(parseGitInstallUrl(url, untrusted), url).toBeNull();
    }
  });
});

describe('publicAddressesOf with a trusted host', () => {
  it('lets a listed name resolve to a private address', async () => {
    expect(await publicAddressesOf('gitlab.corp.internal', lanLookup, trusted)).toEqual([{ address: '10.1.2.3', family: 4 }]);
  });

  it('refuses a listed name that resolves to loopback or link-local, in any IPv6 spelling', async () => {
    expect(await publicAddressesOf('gitlab.corp.internal', async () => [{ address: '127.0.0.1' }], trusted)).toBeNull();
    expect(await publicAddressesOf('gitlab.corp.internal', async () => [{ address: '169.254.169.254' }], trusted)).toBeNull();
    expect(await publicAddressesOf('gitlab.corp.internal', async () => [{ address: '10.1.2.3' }, { address: '127.0.0.1' }], trusted)).toBeNull();
    expect(await publicAddressesOf('gitlab.corp.internal', async () => [{ address: '0:0:0:0:0:0:0:1' }], trusted)).toBeNull();
    expect(await publicAddressesOf('gitlab.corp.internal', async () => [{ address: '0:0:0:0:0:0:0:0' }], trusted)).toBeNull();
    expect(await publicAddressesOf('gitlab.corp.internal', async () => [{ address: 'fe80:0:0:0:1:2:3:4' }], trusted)).toBeNull();
  });

  it('lets a listed name resolve to a public IPv6 address', async () => {
    expect(await publicAddressesOf('gitlab.corp.internal', async () => [{ address: '2001:db8::1' }], trusted))
      .toEqual([{ address: '2001:db8::1', family: 6 }]);
  });

  it('still refuses a public name that resolves to a private address', async () => {
    expect(await publicAddressesOf('example.com', lanLookup, trusted)).toBeNull();
  });

  it('refuses an internal name nobody listed', async () => {
    expect(await publicAddressesOf('gitlab.corp.internal', lanLookup, untrusted)).toBeNull();
  });
});

describe('gitNetworkArgs with a trusted host', () => {
  it('pins https to the checked address on the URL port', async () => {
    expect(await gitNetworkArgs('https://gitlab.corp.internal:8443/team/panel.git', lanLookup, trusted)).toEqual([
      '-c', 'http.followRedirects=false',
      '-c', 'http.curloptResolve=gitlab.corp.internal:8443:10.1.2.3',
    ]);
  });

  it('pins a listed http origin on its own port', async () => {
    expect(await gitNetworkArgs('http://gitlab.corp.internal:8080/team/panel.git', lanLookup, trusted)).toEqual([
      '-c', 'http.followRedirects=false',
      '-c', 'http.curloptResolve=gitlab.corp.internal:8080:10.1.2.3',
    ]);
  });

  it('refuses an http URL that is not on the list, and an internal host nobody listed', async () => {
    expect(await gitNetworkArgs('http://gitlab.corp.internal:9090/team/panel.git', lanLookup, trusted)).toBeNull();
    expect(await gitNetworkArgs('https://gitlab.corp.internal/team/panel.git', lanLookup, untrusted)).toBeNull();
  });

  it('leaves a local path alone', async () => {
    expect(await gitNetworkArgs('/tmp/local/repo', undefined, trusted)).toEqual([]);
  });
});

describe('downloadZip with a trusted host', () => {
  const zipBytes = Buffer.from('zip');

  it('downloads from a listed https host and from a listed http origin, to the checked address', async () => {
    const calls = [];
    const request = async (url, target) => {
      calls.push({ url, address: target.address });
      return { status: 200, location: null, body: zipBytes };
    };
    expect(await downloadZip('https://gitlab.corp.internal/team/panel.zip', { request, lookup: lanLookup, trust: trusted })).toBe(zipBytes);
    expect(await downloadZip('http://gitlab.corp.internal:8080/team/panel.zip', { request, lookup: lanLookup, trust: trusted })).toBe(zipBytes);
    expect(calls).toEqual([
      { url: 'https://gitlab.corp.internal/team/panel.zip', address: '10.1.2.3' },
      { url: 'http://gitlab.corp.internal:8080/team/panel.zip', address: '10.1.2.3' },
    ]);
  });

  it('refuses the same URLs when nothing is listed, without making a request', async () => {
    const request = async () => { throw new Error('must not be called'); };
    expect(await downloadZip('https://gitlab.corp.internal/team/panel.zip', { request, lookup: lanLookup, trust: untrusted })).toBeNull();
    expect(await downloadZip('http://gitlab.corp.internal:8080/team/panel.zip', { request, lookup: lanLookup, trust: untrusted })).toBeNull();
  });

  it('checks every redirect hop: a listed host cannot bounce the install into the LAN or loopback', async () => {
    for (const location of ['https://wiki.corp.internal/panel.zip', 'http://127.0.0.1:8080/panel.zip', 'http://10.0.0.9/panel.zip']) {
      let hops = 0;
      const request = async () => {
        hops += 1;
        return { status: 302, location, body: null };
      };
      expect(await downloadZip('https://gitlab.corp.internal/team/panel.zip', { request, lookup: lanLookup, trust: trusted }), location).toBeNull();
      expect(hops, location).toBe(1);
    }
  });

  it('follows a redirect that stays on a listed host', async () => {
    const seen = [];
    const request = async (url) => {
      seen.push(url);
      return seen.length === 1
        ? { status: 302, location: '/download/abc', body: null }
        : { status: 200, location: null, body: zipBytes };
    };
    expect(await downloadZip('https://gitlab.corp.internal/team/panel.zip', { request, lookup: lanLookup, trust: trusted })).toBe(zipBytes);
    expect(seen).toEqual(['https://gitlab.corp.internal/team/panel.zip', 'https://gitlab.corp.internal/download/abc']);
  });
});
