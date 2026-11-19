
// external: #5138 Google omits Gemini quota groups for an outdated Antigravity User-Agent.
import { lowerCaseLabel } from '../../utils/labels.js';

export const ANTIGRAVITY_CLIENT_VERSION = '2.24.0';

const OS_NAMES = new Map([['win32', 'windows'], ['darwin', 'darwin'], ['linux', 'linux']]);
const ARCH_NAMES = new Map([['x64', 'amd64'], ['arm64', 'arm64']]);

type SummaryFields = { readonly groups?: unknown; readonly displayName?: unknown };
const hasSummaryFields = (value: unknown): value is SummaryFields => value !== null && value !== undefined;
const summaryFields = <Value>(value: Value) => (hasSummaryFields(value) ? value : undefined);

export const antigravityUserAgent = (platform: string = process.platform, arch: string = process.arch) => {
  const os = OS_NAMES.get(platform);
  const platformPart = os ? `${os}/${ARCH_NAMES.get(arch) ?? 'amd64'}` : 'windows/amd64';
  return `antigravity/${ANTIGRAVITY_CLIENT_VERSION} ${platformPart}`;
};

export const antigravityHeaders = () => ({
  'User-Agent': antigravityUserAgent(),
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata':
    '{"ideType":"IDE_UNSPECIFIED","platform":"PLATFORM_UNSPECIFIED","pluginType":"GEMINI"}'
});

const isThirdPartyGroup = <Group>(group: Group) => /claude|gpt|3p/.test(
  lowerCaseLabel(summaryFields(group)?.displayName || '', '((intermediate value) || "")'),
);

let warnedMissingGemini = false;

export const warnIfGeminiGroupMissing = <Payload>(summaryPayload: Payload, warn: (message: string) => void = console.warn) => {
  const groups: unknown = summaryFields(summaryPayload)?.groups;
  const listed: unknown[] = Array.isArray(groups) ? groups : [];
  if (warnedMissingGemini || listed.length === 0 || !listed.every(isThirdPartyGroup)) {
    return;
  }
  warnedMissingGemini = true;
  warn(
    `Antigravity quota: Google returned no Gemini quota group, so the Gemini rows are missing. `
      + `If Antigravity itself shows Gemini limits, ANTIGRAVITY_CLIENT_VERSION (${ANTIGRAVITY_CLIENT_VERSION}) `
      + 'in quota/providers/antigravity/client.ts is probably out of date.'
  );
};
