import type { ProtectedConnectionView, ProtectedDefinition } from './protectedMcp';

/**
 * The edit form of a protected connection, and its conversion from and to the
 * broker's definition. Pure: no React, no store. Secret values live only in a
 * form held in component state; nothing here persists one.
 */

type Transport = ProtectedDefinition['transport'];
type StdioDefinition = Extract<ProtectedDefinition, { transport: 'stdio' }>;
type HttpDefinition = Extract<ProtectedDefinition, { transport: 'http' }>;
type Policy = ProtectedDefinition['policy'];
type SecretHeader = Exclude<HttpDefinition['http']['headers'][string], string>;
type SavedDefinition = ProtectedConnectionView['editable'];

/** A value the broker keeps: which slot it is stored under, whether it is set, and what the user typed. */
type SecretInput = { slot: string | null; stored: boolean; secret: string };

type EnvRow = SecretInput & { key: string; kind: 'text' | 'secret' | 'secretFile' | 'state'; text: string };
type HeaderRow = SecretInput & { name: string; kind: 'text' | 'secret'; text: string; prefix: string };

export type ProtectedForm = {
  /** Redacted baseline used only to preserve the presence of optional fields. */
  original: ProtectedDefinition | null;
  name: string;
  enabled: boolean;
  transport: Transport;
  command: { kind: 'path'; path: string } | { kind: 'package'; package: string; version: string; bin: string };
  args: { kind: 'text' | 'state'; value: string }[];
  env: EnvRow[];
  url: string;
  headers: HeaderRow[];
  oauth: { enabled: boolean; scopes: string[]; clientId: string; clientSecret: SecretInput; issuer: string; redirectUri: string };
  policy: { allowTools: string[]; denyTools: string[]; defaultArguments: { name: string; value: string }[] };
};

/** The label, and the base of the slot name, of an OAuth client secret. */
const OAUTH_CLIENT_SECRET = 'oauth_client_secret';
const SLOT_MAX = 32;
const noSecret = (): SecretInput => ({ slot: null, stored: false, secret: '' });

export const emptyProtectedForm = (name: string, transport: Transport): ProtectedForm => ({
  original: null,
  name,
  enabled: true,
  transport,
  command: { kind: 'path', path: '' },
  args: [],
  env: [],
  url: '',
  headers: [],
  oauth: { enabled: false, scopes: [], clientId: '', clientSecret: noSecret(), issuer: '', redirectUri: '' },
  policy: { allowTools: [], denyTools: [], defaultArguments: [] },
});

const formFromDefinition = (definition: SavedDefinition, secrets: ProtectedConnectionView['secrets']): ProtectedForm => {
  const storedInput = (slot: string): SecretInput => ({ slot, stored: secrets[slot]?.set ?? false, secret: '' });
  const form = emptyProtectedForm(definition.name, definition.transport);
  form.enabled = definition.enabled;
  form.policy = {
    allowTools: [...(definition.policy.allowTools ?? [])],
    denyTools: [...(definition.policy.denyTools ?? [])],
    defaultArguments: Object.entries(definition.policy.defaultArguments ?? {}).map(([name, value]) => ({ name, value })),
  };
  if (definition.transport === 'stdio') {
    const { command, args, env } = definition.stdio;
    form.command = { ...command };
    form.args = args.map((arg) => ({ ...arg }));
    form.env = Object.entries(env).map(([key, value]): EnvRow => {
      switch (value.kind) {
        case 'text':
        case 'state':
          return { key, kind: value.kind, text: value.text, ...noSecret() };
        case 'secret':
        case 'secretFile':
          return { key, kind: value.kind, text: '', ...storedInput(value.slot) };
        default: {
          const unhandled: never = value;
          return unhandled;
        }
      }
    });
    return form;
  }
  const { url, headers, oauth } = definition.http;
  form.url = url;
  form.headers = Object.entries(headers).map(([name, value]): HeaderRow => (value.kind === 'text'
    ? { name, kind: 'text', text: value.text, prefix: '', ...noSecret() }
    : { name, kind: 'secret', text: '', prefix: value.prefix, ...storedInput(value.slot) }));
  if (oauth) {
    form.oauth = {
      enabled: true,
      scopes: [...oauth.scopes],
      clientId: oauth.clientId ?? '',
      clientSecret: oauth.clientSecret ? storedInput(oauth.clientSecret.secret) : noSecret(),
      issuer: oauth.issuer ?? '',
      redirectUri: oauth.redirectUri ?? '',
    };
  }
  return form;
};

/** A form for an existing connection. Secret inputs start empty; `stored` says whether the broker has a value. */
export const formFromConnection = (view: ProtectedConnectionView): ProtectedForm => ({
  ...formFromDefinition(view.editable, view.secrets), original: view.rawEditable,
});

/**
 * A new slot name for a secret labelled `label`, unused in `taken`. The
 * broker's slot grammar is `[a-z0-9][a-z0-9_-]{0,31}`; the broker still
 * validates what is submitted.
 */
export const slotFor = (label: string, taken: ReadonlySet<string>): string => {
  const base = label.toLowerCase().replace(/[^a-z0-9_-]/g, '_').replace(/^[^a-z0-9]+/, '').slice(0, SLOT_MAX) || 'secret';
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix += 1) {
    const tail = `-${suffix}`;
    const candidate = `${base.slice(0, SLOT_MAX - tail.length)}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
};

/** A secret input with the label it is asked for under. */
type SecretEntry = { label: string; input: SecretInput };

/** The secret inputs the form submits. */
const secretInputsOf = (form: ProtectedForm): SecretEntry[] => {
  if (form.transport === 'stdio') {
    return form.env.flatMap((row) => (row.kind === 'secret' || row.kind === 'secretFile' ? [{ label: row.key, input: row }] : []));
  }
  const inputs = form.headers.flatMap((row): SecretEntry[] => (row.kind === 'secret' ? [{ label: row.name, input: row }] : []));
  const { clientSecret } = form.oauth;
  if (form.oauth.enabled && (clientSecret.slot !== null || clientSecret.stored || clientSecret.secret)) inputs.push({ label: OAUTH_CLIENT_SECRET, input: clientSecret });
  return inputs;
};

type SlotOf = (input: SecretInput, label: string) => string;

/** Slots for the form's secret inputs: an existing slot is kept, a new one comes from the input's label. */
const slotAssigner = (form: ProtectedForm): SlotOf => {
  const taken = new Set(secretInputsOf(form).flatMap(({ input }) => (input.slot === null ? [] : [input.slot])));
  const assigned = new Map<SecretInput, string>();
  return (input, label) => {
    const known = input.slot ?? assigned.get(input);
    if (known !== undefined) return known;
    const slot = slotFor(label, taken);
    taken.add(slot);
    assigned.set(input, slot);
    return slot;
  };
};

/** Resolve a broker's bare slot error using the same assignment order as submission. */
export const fieldForSecretSlot = (form: ProtectedForm, slot: string): string | null => {
  const slotOf = slotAssigner(form);
  for (const { label, input } of secretInputsOf(form)) {
    if (slotOf(input, label) !== slot) continue;
    if (form.transport === 'stdio') return `stdio.env.${label}`;
    return input === form.oauth.clientSecret ? 'http.oauth.clientSecret' : `http.headers.${label}`;
  }
  return null;
};

const policyOf = (policy: ProtectedForm['policy'], original: Policy | undefined): Policy => {
  const result: Policy = {};
  if (policy.allowTools.length > 0 || original?.allowTools?.length === 0) result.allowTools = [...policy.allowTools];
  if (policy.denyTools.length > 0 || original?.denyTools?.length === 0) result.denyTools = [...policy.denyTools];
  if (policy.defaultArguments.length > 0 || (original?.defaultArguments && Object.keys(original.defaultArguments).length === 0)) {
    result.defaultArguments = Object.fromEntries(policy.defaultArguments.map(({ name, value }) => [name, value]));
  }
  return result;
};

const stdioDefinition = (form: ProtectedForm, slotOf: SlotOf): StdioDefinition => {
  const command = form.command.kind === 'path'
    ? form.command.path
    : { package: form.command.package, version: form.command.version, bin: form.command.bin };
  const env: StdioDefinition['stdio']['env'] = {};
  for (const row of form.env) {
    switch (row.kind) {
      case 'text': env[row.key] = row.text; break;
      case 'state': env[row.key] = { state: row.text }; break;
      case 'secret': env[row.key] = { secret: slotOf(row, row.key) }; break;
      case 'secretFile': env[row.key] = { secretFile: slotOf(row, row.key) }; break;
      default: {
        const unhandled: never = row.kind;
        return unhandled;
      }
    }
  }
  const args = form.args.map((arg) => (arg.kind === 'text' ? arg.value : { state: arg.value }));
  return { name: form.name, enabled: form.enabled, transport: 'stdio', stdio: { command, args, env }, policy: policyOf(form.policy, form.original?.policy) };
};

const httpDefinition = (form: ProtectedForm, slotOf: SlotOf): HttpDefinition => {
  const original = form.original?.transport === 'http' ? form.original.http : null;
  const headers: HttpDefinition['http']['headers'] = {};
  for (const row of form.headers) {
    if (row.kind === 'text') {
      headers[row.name] = row.text;
      continue;
    }
    const header: SecretHeader = { secret: slotOf(row, row.name) };
    const originalHeader = original?.headers[row.name];
    if (row.prefix || (originalHeader !== undefined && Object.keys(originalHeader).includes('prefix'))) header.prefix = row.prefix;
    headers[row.name] = header;
  }
  const http: HttpDefinition['http'] = { url: form.url, headers };
  if (form.oauth.enabled) {
    const { scopes, clientId, clientSecret, issuer, redirectUri } = form.oauth;
    const oauth: NonNullable<HttpDefinition['http']['oauth']> = { scopes: [...scopes] };
    if (clientId || original?.oauth?.clientId === '') oauth.clientId = clientId;
    if (clientSecret.slot !== null || clientSecret.stored || clientSecret.secret) oauth.clientSecret = { secret: slotOf(clientSecret, OAUTH_CLIENT_SECRET) };
    if (issuer || original?.oauth?.issuer === '') oauth.issuer = issuer;
    if (redirectUri || original?.oauth?.redirectUri === '') oauth.redirectUri = redirectUri;
    http.oauth = oauth;
  }
  return { name: form.name, enabled: form.enabled, transport: 'http', http, policy: policyOf(form.policy, form.original?.policy) };
};

/** The definition to submit, and the typed secret values by slot. Only typed, non-empty values are sent. */
export const definitionFromForm = (form: ProtectedForm) => {
  const slotOf = slotAssigner(form);
  const secrets: Record<string, string> = {};
  // New slots are handed out in form order, here first, so the definition below reuses them.
  for (const { label, input } of secretInputsOf(form)) {
    const slot = slotOf(input, label);
    if (input.secret) secrets[slot] = input.secret;
  }
  const definition: ProtectedDefinition = form.transport === 'stdio' ? stdioDefinition(form, slotOf) : httpDefinition(form, slotOf);
  return { definition, secrets };
};

/** A record's entries in key order, so two records that differ only in row order compare equal. */
const byKey = <T>(record: Readonly<Record<string, T>>): [string, T][] =>
  Object.entries(record).sort(([a], [b]) => (a < b ? -1 : Number(a > b)));

/**
 * Where a credential goes and what runs with it. This mirrors
 * `destinationFingerprint` in `packages/web/server/lib/protected-mcp/service/definitions.js`:
 * the broker forgets stored credentials when it changes, so keep both in step.
 */
const destinationOf = (definition: ProtectedDefinition) => (definition.transport === 'stdio'
  ? { transport: 'stdio', command: definition.stdio.command, args: definition.stdio.args, env: byKey(definition.stdio.env) }
  : { transport: 'http', url: definition.http.url, headers: byKey(definition.http.headers), oauth: definition.http.oauth ?? null });

/**
 * Whether saving `next` over `saved` changes the destination, so the broker
 * drops the stored credentials. The API parser and form builder use the same
 * property order; records are compared by sorted key. An explicit empty optional
 * field remains distinct from an absent one, as in the broker's fingerprint.
 */
export const destinationChanged = (saved: ProtectedDefinition, next: ProtectedDefinition): boolean =>
  JSON.stringify(destinationOf(saved)) !== JSON.stringify(destinationOf(next));

/**
 * The labels whose secret must be typed before saving: on a new destination
 * every secret of the form that has no typed value, since nothing stored
 * follows it; otherwise the ones neither stored nor typed.
 */
export const secretsToType = (savedView: ProtectedConnectionView, form: ProtectedForm): string[] => {
  const renewed = destinationChanged(savedView.rawEditable, definitionFromForm(form).definition);
  return secretInputsOf(form)
    .filter(({ input }) => !input.secret && (renewed || !input.stored))
    .map(({ label }) => label);
};

/**
 * How the form differs from the saved connection: a destination change waits
 * for an explicit Save; anything else (enabled, tool policy, name) autosaves.
 */
export const changeKind = (savedView: ProtectedConnectionView, form: ProtectedForm): 'none' | 'autosave' | 'destination' => {
  const saved = savedView.rawEditable;
  const next = definitionFromForm(form).definition;
  if (destinationChanged(saved, next)) return 'destination';
  const rest = (definition: ProtectedDefinition) => JSON.stringify({
    name: definition.name,
    enabled: definition.enabled,
    allowTools: definition.policy.allowTools ?? [],
    denyTools: definition.policy.denyTools ?? [],
    defaultArguments: byKey(definition.policy.defaultArguments ?? {}),
  });
  return rest(saved) === rest(next) ? 'none' : 'autosave';
};
