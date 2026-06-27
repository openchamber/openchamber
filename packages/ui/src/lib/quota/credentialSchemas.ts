import type { QuotaProviderId } from '@/types/quota';
import type { I18nKey } from '@/lib/i18n';

/**
 * UI-side mirror of the server credential schemas
 * (`packages/web/server/lib/quota/credentials/schemas.js`).
 *
 * Drives the credential entry dialog so each manual-auth provider renders the
 * correct fields and submits the credential shape its server schema expects.
 */
export interface ManualCredentialField {
  key: string;
  labelKey: I18nKey;
  required: boolean;
  secret: boolean;
}

export interface ManualAuthProvider {
  id: QuotaProviderId;
  name: string;
  fields: ManualCredentialField[];
  /**
   * Groups of field keys where at least one member must be provided.
   * Defaults to every `required` field forming its own single-member group.
   */
  requiredGroups?: string[][];
}

const F = (key: string, opts: { required?: boolean; secret?: boolean } = {}): ManualCredentialField => ({
  key,
  labelKey: `settings.credentials.field.${key}` as I18nKey,
  required: opts.required ?? false,
  secret: opts.secret ?? false,
});

export const MANUAL_AUTH_PROVIDERS: ManualAuthProvider[] = [
  {
    id: 'atlascloud',
    name: 'AtlasCloud',
    fields: [F('cookie', { required: true, secret: true }), F('accountUuid')],
  },
  {
    id: 'byteplus',
    name: 'BytePlus',
    fields: [F('cookie', { required: true, secret: true })],
  },
  {
    id: 'longcat',
    name: 'LongCat',
    fields: [F('passportToken', { secret: true }), F('cookie', { secret: true }), F('region')],
    requiredGroups: [['passportToken', 'cookie']],
  },
  {
    id: 'mistral',
    name: 'Mistral',
    fields: [F('cookie', { required: true, secret: true })],
  },
  {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    fields: [F('cookie', { required: true, secret: true })],
  },
  {
    id: 'opencode-go',
    name: 'OpenCode Go',
    fields: [F('workspaceId', { required: true }), F('authCookie', { required: true, secret: true })],
  },
  {
    id: 'qwencloud',
    name: 'QwenCloud',
    fields: [F('ticket', { required: true, secret: true }), F('isg', { required: true, secret: true }), F('esmTicket', { secret: true }), F('aliyunPk')],
  },
  {
    id: 'stepfun',
    name: 'StepFun',
    fields: [F('oasisToken', { required: true, secret: true }), F('oasisWebid', { required: true }), F('sessionToken', { secret: true })],
  },
];

const BY_ID = new Map(MANUAL_AUTH_PROVIDERS.map((p) => [p.id, p]));

export function getManualAuthProvider(id: string | undefined): ManualAuthProvider | undefined {
  if (!id) return undefined;
  return BY_ID.get(id as QuotaProviderId);
}

export function isManualAuthProvider(id: string | undefined): boolean {
  return id ? BY_ID.has(id as QuotaProviderId) : false;
}

const OPENCODE_PROVIDER_ALIASES: Record<string, QuotaProviderId> = {
  'byteplus-plan': 'byteplus',
  'byteplus-coding-plan': 'byteplus',
  // OpenCode Zen (models.dev id `opencode`) shares the Go+Zen dashboard credential.
  opencode: 'opencode-go',
  'opencode-zen': 'opencode-go',
  'atlas-cloud': 'atlascloud',
  atlas: 'atlascloud',
  ollama: 'ollama-cloud',
  'mistral-vibe': 'mistral',
  'alibaba-coding-plan': 'qwencloud',
};

export function resolveQuotaProviderId(opencodeId: string | undefined): QuotaProviderId | undefined {
  if (!opencodeId) return undefined;
  const id = opencodeId.toLowerCase();
  const alias = OPENCODE_PROVIDER_ALIASES[id];
  if (alias) return alias;
  if (BY_ID.has(id as QuotaProviderId)) return id as QuotaProviderId;
  // Custom-named providers (e.g. "mistral-schlambo") resolve by dash/underscore prefix.
  for (const p of MANUAL_AUTH_PROVIDERS) {
    if (id === p.id || id.startsWith(`${p.id}-`) || id.startsWith(`${p.id}_`)) return p.id;
  }
  return undefined;
}
