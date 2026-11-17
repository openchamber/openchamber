
// external: #5138 Google omits Gemini quota groups for an outdated Antigravity User-Agent.
export const ANTIGRAVITY_CLIENT_VERSION = '2.24.0';

const OS_NAMES = { win32: 'windows', darwin: 'darwin', linux: 'linux' };
const ARCH_NAMES = { x64: 'amd64', arm64: 'arm64' };

export const antigravityUserAgent = (platform = process.platform, arch = process.arch) => {
  const os = OS_NAMES[platform];
  const platformPart = os ? `${os}/${ARCH_NAMES[arch] ?? 'amd64'}` : 'windows/amd64';
  return `antigravity/${ANTIGRAVITY_CLIENT_VERSION} ${platformPart}`;
};

export const antigravityHeaders = () => ({
  'User-Agent': antigravityUserAgent(),
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'
});

const isThirdPartyGroup = (group) => /claude|gpt|3p/.test((group?.displayName || '').toLowerCase());

let warnedMissingGemini = false;

export const warnIfGeminiGroupMissing = (summaryPayload, warn = console.warn) => {
  const groups = Array.isArray(summaryPayload?.groups) ? summaryPayload.groups : [];
  if (warnedMissingGemini || groups.length === 0 || !groups.every(isThirdPartyGroup)) {
    return;
  }
  warnedMissingGemini = true;
  warn(
    `Antigravity quota: Google returned no Gemini quota group, so the Gemini rows are missing. `
      + `If Antigravity itself shows Gemini limits, ANTIGRAVITY_CLIENT_VERSION (${ANTIGRAVITY_CLIENT_VERSION}) `
      + 'in quota/providers/antigravity/client.js is probably out of date.'
  );
};
