import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { toast } from '@/components/ui';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsBackButton, SettingsCardChip, SettingsCardPill } from '@/components/sections/shared/SettingsCards';
import { SettingsSection, SettingsFieldRow, SettingsStackedField, SettingsChipGroup, SettingsCheckboxRow, SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { AUTOSAVE_SAVED, AUTOSAVE_UNCHANGED, autosaveFailed, useAutosave } from '@/components/sections/shared/SettingsAutosave';
import { BusyDots } from '@/components/ui/busy-dots';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { McpScope } from '@/stores/mcpConfigResponse';
import { useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { normalizeMcpServerName } from './mcpDraft';
import { McpScopeSelect } from './McpScopeSelect';
import {
  ProtectedMcpRequestError, createProtectedConnection, getProtectedConnection, updateProtectedConnection,
  setProtectedConnectionEnabled, revokeProtectedCredentials, deleteProtectedConnection,
  startProtectedOAuth, getProtectedOAuthAttempt, completeProtectedOAuthFromAddress, protectedScopeAvailability,
  type ProtectedConnectionView, type useProtectedMcp,
} from './protectedMcp';
import { changeKind, definitionFromForm, destinationChanged, emptyProtectedForm, fieldForSecretSlot, formFromConnection, secretsToType, type ProtectedForm } from './protectedMcpForm';
import { PROTECTED_USE_LABEL_KEYS, protectedCards, selectionActions } from './protectedMcpCards';

type Mode =
  | { readonly kind: 'edit'; readonly id: string }
  | { readonly kind: 'create'; readonly name: string; readonly transport: ProtectedForm['transport'];
      /** Global uses the connection in all projects, Local project in this one; the select keeps Shared project off. */
      readonly scope: McpScope; readonly onScopeChange: (scope: McpScope) => void; readonly projectLocal: boolean | null;
      readonly onUnprotect: (name: string, transport: ProtectedForm['transport']) => void;
      readonly onCancel: () => void; readonly onCreated: () => void };
type PageProps = { readonly mode: Mode; readonly directory: string | null; readonly protectedMcp: ReturnType<typeof useProtectedMcp> };
type FieldFailure = { readonly field: string | null; readonly message: string; readonly focus?: boolean };
type Flow = { readonly kind: 'idle' } | { readonly kind: 'starting' }
  | { readonly kind: 'waiting' | 'finishing'; readonly attempt: string; readonly expires: number; readonly authorizationUrl: string };

const SECRET_ERRORS = new Set(['secret_missing', 'unknown_secret', 'invalid_secret', 'credential_rebind_required']);

const ERROR_KEYS = new Map<string, I18nKey>([
  ...(['invalid_definition', 'invalid_name', 'invalid_transport', 'invalid_command', 'invalid_package', 'invalid_url',
    'insecure_url', 'invalid_redirect_uri', 'invalid_secret_slot', 'invalid_state_path', 'reserved_environment', 'reserved_header',
    'secret_in_arguments', 'conflicting_authorization', 'name_taken', 'revision_conflict', 'credential_rebind_required',
    'secret_missing', 'unknown_secret', 'invalid_secret', 'connection_not_found', 'oauth_not_configured',
    'oauth_client_required', 'oauth_discovery_failed', 'oauth_registration_failed', 'oauth_exchange_failed',
    'oauth_state_invalid', 'oauth_denied', 'oauth_connection_changed', 'runtime_unavailable', 'runtime_installing',
    'package_install_failed', 'untrusted_executable', 'untrusted_argument', 'project_required', 'invalid_request',
    'invalid_directory', 'origin_unknown', 'name_in_use', 'selection_name_in_use', 'ordinary_mcp_unreadable',
    'selection_not_saved', 'selections_unreadable', 'invalid_response', 'service_unavailable', 'service_permission_denied',
    'service_timeout', 'body_too_large', 'unsupported_host'] as const).map((code) => [code, `settings.mcp.protectedPage.error.${code}`] satisfies [string, I18nKey]),
]);

const USE_BY_SCOPE = { user: 'global', local: 'project', project: null } as const satisfies Record<McpScope, 'global' | 'project' | null>;

const KIND_KEYS = {
  text: 'settings.mcp.protectedPage.kind.text', secret: 'settings.mcp.protectedPage.kind.secret',
  secretFile: 'settings.mcp.protectedPage.kind.secretFile', state: 'settings.mcp.protectedPage.kind.state',
} as const satisfies Record<ProtectedForm['env'][number]['kind'], I18nKey>;

const matchesField = (failure: FieldFailure | null, path: string) =>
  failure?.field === path || failure?.field?.startsWith(`${path}.`);

/** Keep a broker refusal next to the exact field it names, including dynamic env/header names. */
function Field({ path, failure, children, ...props }: React.ComponentProps<typeof SettingsStackedField> & {
  readonly path: string; readonly failure: FieldFailure | null;
}) {
  const invalid = matchesField(failure, path);
  return <div data-protected-field={path}>
    <SettingsStackedField {...props} controlClassName="flex-col items-stretch">
      {children}
      <p role={invalid ? 'alert' : undefined} className="min-h-5 typography-meta text-[var(--status-error-text)]">{invalid ? failure?.message : null}</p>
    </SettingsStackedField>
  </div>;
}

/** A stored value has no representation in the renderer. Replace only reveals a new, empty input. */
function SecretField({ input, label, required, multiline = false, onChange }: {
  readonly input: ProtectedForm['oauth']['clientSecret']; readonly label: string; readonly required: boolean;
  readonly multiline?: boolean; readonly onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [replacing, setReplacing] = React.useState(false);
  if (input.stored && !required && !replacing && !input.secret) {
    return <div className="flex min-h-8 items-center gap-2">
      <span className={SETTINGS_HELPER_CLASS}>{t('settings.mcp.protectedPage.credentials.stored')}</span>
      <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>{t('settings.mcp.protectedPage.actions.replace')}</Button>
    </div>;
  }
  const props = { value: input.secret, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
    'aria-label': label, autoComplete: 'new-password', dir: 'ltr', className: 'font-mono typography-meta' };
  return <div className="space-y-1.5">
    {multiline ? <Textarea {...props} rows={4} /> : <Input {...props} type="password" />}
    {replacing && !required ? <Button variant="ghost" size="xs" onClick={() => { onChange(''); setReplacing(false); }}>{t('settings.common.actions.cancel')}</Button> : null}
  </div>;
}

/** Policy lists and OAuth scopes share row editing, including removal without a blur target. */
function StringRows({ label, path, values, onChange, onCommit, failure }: {
  readonly label: I18nKey; readonly path: string; readonly values: string[];
  readonly onChange: (values: string[]) => void; readonly onCommit: () => void; readonly failure: FieldFailure | null;
}) {
  const { t } = useI18n();
  return <Field label={t(label)} path={path} failure={failure}>
    {values.map((value, index) => <div key={index} className="flex min-w-0 items-center gap-2">
      <Input value={value} aria-label={t(label)} dir="ltr" className="font-mono typography-meta"
        onChange={(event) => onChange(values.map((entry, i) => i === index ? event.target.value : entry))} />
      <Button variant="ghost" size="icon" aria-label={t('settings.mcp.protectedPage.actions.remove')} onClick={() => { onChange(values.filter((_, i) => i !== index)); onCommit(); }}><Icon name="close" className="size-4" /></Button>
    </div>)}
    <Button variant="outline" size="sm" className="self-start" onClick={() => onChange([...values, ''])}>{t('settings.mcp.protectedPage.actions.add')}</Button>
  </Field>;
}

/** Protected definitions are component-local. Only redacted views and selection ids enter shared state. */
export function ProtectedMcpPage({ mode, directory, protectedMcp }: PageProps) {
  const { t, locale } = useI18n();
  const id = mode.kind === 'edit' ? mode.id : null;
  const [saved, setSaved] = React.useState<ProtectedConnectionView | null>(null);
  const savedRef = React.useRef<ProtectedConnectionView | null>(null);
  const [form, setForm] = React.useState(() => emptyProtectedForm(mode.kind === 'create' ? mode.name : '', mode.kind === 'create' ? mode.transport : 'stdio'));
  const [failure, setFailure] = React.useState<FieldFailure | null>(null);
  const [conflict, setConflict] = React.useState(false);
  const conflictRef = React.useRef(false);
  const [busy, setBusy] = React.useState(false);
  const [confirm, setConfirm] = React.useState<'delete' | 'revoke' | null>(null);
  const [flow, setFlow] = React.useState<Flow>({ kind: 'idle' });
  const [address, setAddress] = React.useState('');
  const [outcome, setOutcome] = React.useState<string | null>(null);
  const alive = React.useRef(true);
  const flowGeneration = React.useRef(0);
  const rootRef = React.useRef<HTMLDivElement>(null);
  // Every revision-bearing write joins the same queue, including explicit Save after a blur autosave.
  const writes = React.useRef<Promise<void>>(Promise.resolve());
  const runtimeStatus = useMcpStore((state) => state.getStatusForDirectory(directory));
  const runtimeDiagnostics = useMcpStore((state) => state.getDiagnosticForDirectory(directory));
  const refreshStatus = useMcpStore((state) => state.refresh);
  const availability = protectedScopeAvailability(protectedMcp.state);
  const status = protectedMcp.state.kind === 'ready' ? protectedMcp.state.status : null;
  const service = status?.service.state === 'available' ? status.service.status : null;

  React.useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; flowGeneration.current += 1; };
  }, []);

  const describeError = React.useCallback((error: Error) => {
    if (error instanceof ProtectedMcpRequestError) {
      const key = ERROR_KEYS.get(error.code) ?? (error.status === 501 ? ERROR_KEYS.get('unsupported_host') : undefined);
      if (key) return t(key);
    }
    return error.message;
  }, [t]);

  const recordFailure = (error: Error, focus = false) => {
    const message = describeError(error);
    if (alive.current) {
      const brokerField = error instanceof ProtectedMcpRequestError ? error.field : null;
      const field = brokerField && error instanceof ProtectedMcpRequestError && SECRET_ERRORS.has(error.code)
        ? fieldForSecretSlot(form, brokerField) ?? brokerField : brokerField;
      const next = { field, message, focus };
      const rendered = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-protected-field]') ?? [])]
        .some((entry) => matchesField(next, entry.dataset.protectedField ?? ''));
      setFailure({ ...next, field: rendered ? field : null });
      if (error instanceof ProtectedMcpRequestError && error.code === 'revision_conflict') {
        conflictRef.current = true;
        setConflict(true);
        setConfirm(null);
      }
    }
    return message;
  };

  React.useEffect(() => {
    if (!failure?.field || !failure.focus) return;
    const field = [...(rootRef.current?.querySelectorAll<HTMLElement>('[data-protected-field]') ?? [])]
      .find((entry) => matchesField(failure, entry.dataset.protectedField ?? ''));
    const input = field?.querySelector<HTMLElement>('input, textarea') ?? field?.querySelector<HTMLElement>('button');
    input?.focus();
  }, [failure]);

  const load = React.useCallback(async (expectedFlow: number | null = null) => {
    if (!id) return null;
    try {
      const view = await getProtectedConnection(id);
      if (!alive.current || (expectedFlow !== null && expectedFlow !== flowGeneration.current)) return null;
      savedRef.current = view;
      setSaved(view);
      setForm(formFromConnection(view));
      setFailure(null);
      conflictRef.current = false;
      setConflict(false);
      return view;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!alive.current || (expectedFlow !== null && expectedFlow !== flowGeneration.current)) return null;
      const message = describeError(error);
      setFailure({ field: null, message });
      if (error instanceof ProtectedMcpRequestError && error.status === 404) {
        toast.error(t('settings.mcp.protectedPage.error.connection_not_found'));
        useMcpConfigStore.getState().setSelectedProtected(null);
      }
      return null;
    }
  }, [describeError, id, t]);
  const loadRef = React.useRef(load);
  loadRef.current = load;
  React.useEffect(() => { void loadRef.current(); }, [id]);

  const serialize = <T,>(action: () => Promise<T>): Promise<T> => {
    const next = writes.current.then(action);
    writes.current = next.then(() => undefined, () => undefined);
    return next;
  };
  const accept = (view: ProtectedConnectionView) => {
    savedRef.current = view;
    if (alive.current) setSaved(view);
  };
  const refreshRuntime = React.useCallback(() => {
    void refreshStatus({ directory, silent: true });
  }, [directory, refreshStatus]);
  const reconnectInUse = React.useCallback(async (view: ProtectedConnectionView) => {
    if (!alive.current) return;
    if (view.enabled) {
      const names = Object.entries(status?.selections?.effective ?? {})
        .filter(([, selection]) => selection.connection === view.id && !selection.disabled);
      // A failed alias must not block the rest or turn an applied broker write into a form failure.
      await Promise.allSettled(names.map(async ([name]) => {
        await useMcpStore.getState().disconnect(name, directory);
        if (alive.current) await useMcpStore.getState().connect(name, directory);
      }));
    }
    if (alive.current) await refreshStatus({ directory, silent: true });
  }, [directory, refreshStatus, status]);
  const autosave = useAutosave(async () => {
    if (!id || !savedRef.current || busy || conflict) return AUTOSAVE_UNCHANGED;
    const { enabled, policy } = form;
    return serialize(async () => {
      let view = savedRef.current;
      if (!view || !alive.current || conflictRef.current) return AUTOSAVE_UNCHANGED;
      try {
        let changed = false;
        if (view.enabled !== enabled) {
          view = await setProtectedConnectionEnabled(id, { expectedRevision: view.revision, enabled });
          accept(view);
          changed = true;
          if (enabled) await reconnectInUse(view);
        }
        const baseline = formFromConnection(view);
        if (changeKind(view, { ...baseline, policy }) !== 'none') {
          const nextPolicy = definitionFromForm({ ...baseline, policy }).definition.policy;
          // Policy autosave must retain the broker's exact destination, including empty optional fields.
          const next = { ...view.rawEditable, policy: nextPolicy };
          view = await updateProtectedConnection(id, { expectedRevision: view.revision, definition: next, secrets: {} });
          accept(view);
          changed = true;
        }
        if (!changed) return AUTOSAVE_UNCHANGED;
        if (alive.current) { setFailure(null); refreshRuntime(); void protectedMcp.reload(); }
        return AUTOSAVE_SAVED;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        return autosaveFailed(recordFailure(error));
      }
    });
  });

  const submitted = definitionFromForm(form);
  const destinationDirty = saved !== null && changeKind(saved, form) === 'destination';
  const typedSecrets = Object.keys(submitted.secrets).length > 0;
  const missing = saved ? secretsToType(saved, form) : [
    ...form.env.filter((row) => form.transport === 'stdio' && (row.kind === 'secret' || row.kind === 'secretFile') && !row.secret).map((row) => row.key),
    ...form.headers.filter((row) => form.transport === 'http' && row.kind === 'secret' && !row.secret).map((row) => row.name),
  ];
  // Keep the rebind warning visible after typing the last required value.
  const renewals = saved && destinationDirty ? secretsToType(saved, {
    ...form, env: form.env.map((row) => ({ ...row, secret: '' })), headers: form.headers.map((row) => ({ ...row, secret: '' })),
    oauth: { ...form.oauth, clientSecret: { ...form.oauth.clientSecret, secret: '' } },
  }) : [];
  const required = form.name.trim() && (form.transport === 'http' ? form.url.trim() && form.headers.every((row) => row.name.trim())
    : (form.command.kind === 'path' ? form.command.path.trim() : form.command.package.trim() && form.command.version.trim() && form.command.bin.trim()) && form.env.every((row) => row.key.trim()));
  const controlsDisabled = busy || flow.kind !== 'idle';
  const createUse = mode.kind === 'create' ? USE_BY_SCOPE[mode.scope] : null;
  const canSave = Boolean(required) && missing.length === 0 && !controlsDisabled && !conflict && (mode.kind === 'edit' || createUse !== null);
  const configurationDirty = saved !== null && changeKind(saved, form) !== 'none';
  const retypeLabels = renewals.map((label) => {
    const slot = form.env.find((row) => row.key === label)?.slot ?? form.headers.find((row) => row.name === label)?.slot;
    return slot && slot !== label ? `${label} · ${slot}` : label;
  }).join(', ');

  const leave = () => {
    setForm(emptyProtectedForm('', 'stdio'));
    setAddress('');
    flowGeneration.current += 1;
    if (mode.kind === 'create') mode.onCancel();
    else useMcpConfigStore.getState().setSelectedProtected(null);
  };
  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setFailure(null);
    try {
      if (mode.kind === 'create') {
        if (!createUse) return;
        const view = await createProtectedConnection({ ...submitted, use: { scope: createUse } }, directory);
        if (!alive.current) return;
        setForm(formFromConnection(view));
        mode.onCreated();
        const store = useMcpConfigStore.getState();
        store.setMcpDraft(null);
        store.setSelectedProtected(view.id);
        void protectedMcp.reload();
        refreshRuntime();
        toast.success(t('settings.mcp.protectedPage.created'));
      } else {
        await serialize(async () => {
          const baseline = savedRef.current;
          if (!baseline || conflictRef.current) return;
          // Re-evaluate against the latest revision after any queued autosave finishes.
          const changedDestination = destinationChanged(baseline.rawEditable, submitted.definition);
          if (changedDestination
            && secretsToType(baseline, form).length > 0) return;
          const view = await updateProtectedConnection(mode.id, { expectedRevision: baseline.revision, ...submitted });
          accept(view);
          if (alive.current) {
            setForm(formFromConnection(view));
            if (changedDestination || typedSecrets) await reconnectInUse(view);
            else refreshRuntime();
            void protectedMcp.reload();
          }
        });
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (alive.current) toast.error(recordFailure(error, true));
    } finally { if (alive.current) setBusy(false); }
  };

  const reloadProtected = protectedMcp.reload;
  const finishOutcome = React.useCallback(async (result: string) => {
    const generation = flowGeneration.current;
    setAddress('');
    setOutcome(result);
    const view = await load(generation);
    if (!alive.current || generation !== flowGeneration.current) return;
    if (result === 'authorized' && view) await reconnectInUse(view);
    else refreshRuntime();
    void reloadProtected();
    if (alive.current && generation === flowGeneration.current) setFlow({ kind: 'idle' });
  }, [load, reloadProtected, reconnectInUse, refreshRuntime]);

  React.useEffect(() => {
    if (flow.kind !== 'waiting') return;
    const generation = flowGeneration.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const timeout = setTimeout(() => {
      stopped = true;
      clearTimeout(timer);
      void finishOutcome('oauth_state_invalid');
    }, Math.max(0, flow.expires - Date.now()));
    const poll = async () => {
      try {
        const result = await getProtectedOAuthAttempt(flow.attempt);
        if (stopped || generation !== flowGeneration.current) return;
        switch (result.status) {
          case 'pending': timer = setTimeout(() => void poll(), 1500); return;
          case 'done':
          case 'unknown':
            stopped = true;
            clearTimeout(timeout);
            await finishOutcome(result.status === 'done' ? result.outcome ?? 'oauth_state_invalid' : 'oauth_state_invalid');
            return;
          default: { const unhandled: never = result.status; return unhandled; }
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (stopped || generation !== flowGeneration.current) return;
        setOutcome(describeError(error));
        timer = setTimeout(() => void poll(), 1500);
      }
    };
    timer = setTimeout(() => void poll(), 1500);
    return () => { stopped = true; clearTimeout(timer); clearTimeout(timeout); };
  }, [describeError, finishOutcome, flow]);

  const signIn = async () => {
    if (!id || configurationDirty || typedSecrets || conflict) return;
    const generation = ++flowGeneration.current;
    setFlow({ kind: 'starting' });
    setOutcome(null);
    try {
      const started = await serialize(async () => {
        const view = savedRef.current;
        return view && !conflictRef.current ? startProtectedOAuth(id, { expectedRevision: view.revision }) : null;
      });
      if (!started || !alive.current || generation !== flowGeneration.current) return;
      setFlow({ kind: 'waiting', attempt: started.attempt, expires: Date.now() + 600000, authorizationUrl: started.authorizationUrl });
      await openExternalUrl(started.authorizationUrl);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!alive.current || generation !== flowGeneration.current) return;
      setFlow({ kind: 'idle' });
      toast.error(recordFailure(error));
    }
  };
  const paste = async () => {
    if (flow.kind !== 'waiting' || !address.trim()) return;
    const waiting = flow;
    const generation = ++flowGeneration.current;
    setFlow({ ...waiting, kind: 'finishing' });
    try {
      const result = await completeProtectedOAuthFromAddress(address.trim());
      if (!alive.current || generation !== flowGeneration.current) return;
      if (result.outcome === 'authorized') { await finishOutcome(result.outcome); return; }
      // The browser callback may have consumed this address before it was pasted.
      const attempt = await getProtectedOAuthAttempt(waiting.attempt);
      if (!alive.current || generation !== flowGeneration.current) return;
      switch (attempt.status) {
        case 'done': await finishOutcome(attempt.outcome ?? 'oauth_state_invalid'); return;
        case 'unknown': await finishOutcome('oauth_state_invalid'); return;
        case 'pending': setOutcome(result.outcome); setFlow(waiting); return;
        default: { const unhandled: never = attempt.status; return unhandled; }
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (!alive.current || generation !== flowGeneration.current) return;
      toast.error(recordFailure(error));
      setFlow(waiting);
    }
  };

  const confirmAction = async () => {
    if (!id || !confirm || busy) return;
    setBusy(true);
    try {
      await serialize(async () => {
        const view = savedRef.current;
        if (!view || conflictRef.current) return;
        if (confirm === 'delete') {
          const notUpdated = await deleteProtectedConnection(id, { expectedRevision: view.revision });
          if (!alive.current) return;
          if (notUpdated.length) toast.warning(t('settings.mcp.protectedPage.deletePartial', { files: notUpdated.join(', ') }));
          leave();
        } else {
          const next = await revokeProtectedCredentials(id, { expectedRevision: view.revision });
          accept(next);
          if (alive.current) setForm(formFromConnection(next));
          await reconnectInUse(next);
        }
        if (alive.current) { setConfirm(null); refreshRuntime(); void protectedMcp.reload(); }
      });
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      if (alive.current) toast.error(recordFailure(error));
    } finally { if (alive.current) setBusy(false); }
  };

  const textField = (path: string, label: I18nKey, value: string, onChange: (value: string) => void, info?: string) => <Field key={path} path={path} label={t(label)} failure={failure} info={info}>
    <Input value={value} onChange={(event) => onChange(event.target.value)} aria-label={t(label)} aria-invalid={matchesField(failure, path) || undefined} dir="ltr" className="font-mono typography-meta" />
  </Field>;
  const kindSelect = <T extends keyof typeof KIND_KEYS,>(value: T, options: readonly T[], onChange: (value: T) => void) => <Select value={value} onValueChange={(candidate) => {
    const next = options.find((option) => option === candidate);
    if (next) onChange(next);
  }}>
    <SelectTrigger aria-label={t('settings.mcp.protectedPage.kind.label')}><span className="truncate">{t(KIND_KEYS[value])}</span></SelectTrigger>
    <SelectContent>{options.map((option) => <SelectItem key={option} value={option}>{t(KIND_KEYS[option])}</SelectItem>)}</SelectContent>
  </Select>;
  const updateEnv = (index: number, patch: Partial<ProtectedForm['env'][number]>) => setForm((current) => ({ ...current, env: current.env.map((row, i) => i === index ? { ...row, ...patch } : row) }));
  const updateHeader = (index: number, patch: Partial<ProtectedForm['headers'][number]>) => setForm((current) => ({ ...current, headers: current.headers.map((row, i) => i === index ? { ...row, ...patch } : row) }));
  const protectionKey = service?.enforcement.status ?? 'unverified';
  const protectionKeys = {
    protected: ['settings.mcp.protected.enforcement.protected', 'settings.mcp.protected.enforcement.protectedInfo'],
    unverified: ['settings.mcp.protected.enforcement.unverified', 'settings.mcp.protected.enforcement.unverifiedInfo'],
    unprotected: ['settings.mcp.protected.enforcement.unprotected', 'settings.mcp.protected.enforcement.unprotectedInfo'],
  } as const;
  const cards = status && service && id ? protectedCards(status, service.connections).filter((card) => card.connection.id === id && (card.global || card.project)) : [];
  const credentialStatus = () => {
    if (!saved) return '';
    switch (saved.credential) {
      case 'none': return t('settings.mcp.protectedPage.credentials.none');
      case 'stored': return t('settings.mcp.protectedPage.credentials.stored');
      case 'missing': return t('settings.mcp.protectedPage.credentials.missing', { labels: Object.entries(saved.secrets).filter(([, value]) => !value.set).map(([slot]) => slot).join(', ') });
      case 'authorization_required': return t('settings.mcp.protectedPage.credentials.needsSignIn');
      case 'authorized': return saved.oauth?.expiresAt
        ? t('settings.mcp.protectedPage.credentials.until', { time: new Date(saved.oauth.expiresAt).toLocaleString(locale) })
        : t('settings.mcp.protectedPage.credentials.signedIn');
      default: { const unhandled: never = saved.credential; return unhandled; }
    }
  };
  const outcomeKey = outcome === 'authorized' ? 'settings.mcp.protectedPage.credentials.signedIn' : outcome ? ERROR_KEYS.get(outcome) : null;

  return <SettingsPageLayout title={mode.kind === 'create' ? t('settings.mcp.page.header.newServer') : saved?.name ?? id}
    titleLeading={<SettingsBackButton label={t('settings.mcp.page.back')} onClick={leave} />}
    titleAccessory={<Tooltip><TooltipTrigger asChild><span tabIndex={0}><SettingsCardPill tone={protectionKey === 'protected' ? 'success' : 'warning'}><Icon name="lock" className="inline size-3 me-1" />{t(protectionKeys[protectionKey][0])}</SettingsCardPill></span></TooltipTrigger><TooltipContent side="top" className="max-w-xs">{t(protectionKeys[protectionKey][1])}{service?.administration === 'shared' ? ` ${t('settings.mcp.page.scope.sharedAdministration')}` : ''}</TooltipContent></Tooltip>}
    description={`${t('settings.mcp.page.scope.protected')} · ${t(form.transport === 'stdio' ? 'settings.mcp.page.connection.kindCommand' : 'settings.mcp.page.connection.kindLink')}`}
    onBlurCapture={autosave.onBlurCapture}>
    <div ref={rootRef}>
      {mode.kind === 'edit' && service?.administration === 'shared' ? <p className={`${SETTINGS_HELPER_CLASS} pb-6`}>{t('settings.mcp.page.scope.sharedAdministration')}</p> : null}
      {failure && !failure.field ? <p role="alert" className="typography-meta text-[var(--status-error-text)] pb-4">{failure.message}</p> : null}
      {conflict || (id && !saved && failure) ? <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>{t('settings.mcp.protectedPage.actions.reload')}</Button> : null}
      {id && !saved ? <p className={SETTINGS_HELPER_CLASS}>{failure ? '' : t('settings.mcp.protectedPage.loading')}</p> : <>
        <fieldset disabled={controlsDisabled} className="min-w-0">
          <SettingsSection title={t('settings.mcp.page.server.title')} divider={false} contentClassName="space-y-4"
            // The ordinary form's Import button sets its header height; reserving it keeps Protect credentials under the pointer.
            titleAccessory={mode.kind === 'create' ? <span aria-hidden className="h-6" /> : null}>
            {mode.kind === 'create' ? <div>
              {/* Same name, scope and checkbox rows as the ordinary create form, so toggling protection moves nothing above them. */}
              <div data-protected-field="name">
                <SettingsFieldRow label={t('settings.mcp.page.server.name')} controlClassName="flex-wrap @xl:w-auto @xl:flex-1">
                  <Input value={form.name} onChange={(event) => setForm({ ...form, name: normalizeMcpServerName(event.target.value) })}
                    placeholder={t('settings.mcp.page.server.namePlaceholder')} aria-label={t('settings.mcp.page.server.name')}
                    aria-invalid={matchesField(failure, 'name') || undefined} dir="ltr" className="h-7 w-48 min-w-0 max-w-full shrink font-mono px-2" />
                  <McpScopeSelect value={mode.scope} onChange={mode.onScopeChange} projectLocal={mode.projectLocal} directory={directory} protectedCredentials />
                </SettingsFieldRow>
                {matchesField(failure, 'name') ? <p role="alert" className="typography-meta text-[var(--status-error-text)]">{failure?.message}</p> : null}
              </div>
              {/* The fieldset disables real controls only; this row is a div, so it needs its own disabled while a create runs. */}
              <SettingsCheckboxRow checked onChange={() => mode.onUnprotect(form.name, form.transport)} disabled={controlsDisabled} settingsItem="mcp.protect"
                label={t('settings.mcp.page.server.protect')} ariaLabel={t('settings.mcp.page.server.protect')}
                info={t('settings.mcp.page.scope.protectedInfo')}
                description={service?.administration === 'shared' ? t('settings.mcp.page.scope.sharedAdministration') : undefined} />
            </div> : <>
              <SettingsFieldRow label={t('settings.mcp.protectedPage.enabled')}><Switch checked={form.enabled} aria-label={t('settings.mcp.protectedPage.enabled')} onCheckedChange={(enabled) => { setForm({ ...form, enabled }); autosave.requestSave(); }} /></SettingsFieldRow>
              {cards.map((card) => {
                const liveStatus = runtimeStatus[card.name]?.status.status ?? runtimeDiagnostics[card.name]?.status;
                return <SettingsFieldRow key={card.name} label={t('settings.mcp.protectedPage.usedAs')}>
                  <span dir="ltr" className="truncate font-mono typography-meta" title={card.name}>{card.name}</span><SettingsCardChip>{t(PROTECTED_USE_LABEL_KEYS[card.use])}</SettingsCardChip>
                  {status?.selections?.effective[card.name]?.connection === id && liveStatus ? <SettingsCardPill tone={liveStatus === 'connected' ? 'success' : liveStatus === 'failed' ? 'error' : 'neutral'}>{t(liveStatus === 'connected' ? 'settings.mcp.page.status.label.connected' : liveStatus === 'failed' ? 'settings.mcp.page.status.label.failed' : liveStatus === 'needs_auth' ? 'settings.mcp.page.status.label.needsAuth' : 'settings.mcp.grid.status.pending')}</SettingsCardPill> : null}
                  <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="sm" aria-label={t('settings.mcp.grid.actionsAria', { name: card.name })}><Icon name="more-2" className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
                    {selectionActions(card, directory).map((action) => <DropdownMenuItem key={action.id} variant={action.destructive ? 'destructive' : 'default'} onClick={() => { void protectedMcp.change(action.name, action.request).then(refreshRuntime).catch((error) => { if (!(error instanceof Error)) throw error; toast.error(recordFailure(error)); }); }}><Icon name={action.icon} className="size-4" />{t(action.labelKey)}</DropdownMenuItem>)}
                  </DropdownMenuContent></DropdownMenu>
                </SettingsFieldRow>;
              })}
              {form.transport === 'stdio' && form.command.kind === 'package' ? <p className={SETTINGS_HELPER_CLASS}>{t(saved?.runtime === 'installing' ? 'settings.mcp.protectedPage.runtime.installing' : saved?.runtime === 'ready' ? 'settings.mcp.protectedPage.runtime.ready' : saved?.runtime === 'failed' ? 'settings.mcp.protectedPage.runtime.failed' : 'settings.mcp.protectedPage.runtime.missing')}</p> : null}
            </>}
            <SettingsFieldRow label={t('settings.mcp.protectedPage.type')}><SettingsChipGroup value={form.transport} onChange={(transport) => setForm({ ...form, transport })} options={[
              { value: 'stdio', label: t('settings.mcp.page.connection.kindCommand') }, { value: 'http', label: t('settings.mcp.page.connection.kindLink') },
            ]} /></SettingsFieldRow>
          </SettingsSection>
          <SettingsSection title={t('settings.mcp.page.connection.title')} contentClassName="space-y-4">
            {form.transport === 'stdio' ? <>
              <SettingsFieldRow label={t('settings.mcp.protectedPage.command')}><SettingsChipGroup value={form.command.kind} onChange={(kind) => setForm({ ...form, command: kind === 'path' ? { kind, path: '' } : { kind, package: '', version: '', bin: '' } })} options={[
                { value: 'path', label: t('settings.mcp.protectedPage.executable') }, { value: 'package', label: t('settings.mcp.protectedPage.package') },
              ]} /></SettingsFieldRow>
              {form.command.kind === 'path' ? textField('stdio.command', 'settings.mcp.protectedPage.executable', form.command.path, (path) => setForm({ ...form, command: { kind: 'path', path } }))
                : <>{(['package', 'version', 'bin'] as const).map((key) => textField(`stdio.command.${key}`, key === 'package' ? 'settings.mcp.protectedPage.packageName' : key === 'version' ? 'settings.mcp.protectedPage.version' : 'settings.mcp.protectedPage.bin', form.command.kind === 'package' ? form.command[key] : '', (value) => setForm((current) => current.command.kind === 'package' ? { ...current, command: { ...current.command, [key]: value } } : current)))}</>}
              <Field label={t('settings.mcp.protectedPage.arguments')} path="stdio.args" failure={failure}>
                {form.args.map((arg, index) => <div key={index} className="flex min-w-0 flex-wrap items-center gap-2">
                  {kindSelect(arg.kind, ['text', 'state'], (kind) => setForm({ ...form, args: form.args.map((entry, i) => i === index ? { ...entry, kind } : entry) }))}
                  <Input value={arg.value} aria-label={t('settings.mcp.protectedPage.arguments')} dir="ltr" className="min-w-0 flex-1 font-mono typography-meta" onChange={(event) => setForm({ ...form, args: form.args.map((entry, i) => i === index ? { ...entry, value: event.target.value } : entry) })} />
                  <Button variant="ghost" size="icon" aria-label={t('settings.mcp.protectedPage.actions.remove')} onClick={() => setForm({ ...form, args: form.args.filter((_, i) => i !== index) })}><Icon name="close" className="size-4" /></Button>
                </div>)}
                <Button variant="outline" size="sm" className="self-start" onClick={() => setForm({ ...form, args: [...form.args, { kind: 'text', value: '' }] })}>{t('settings.mcp.protectedPage.actions.add')}</Button>
              </Field>
            </> : <>
              {textField('http.url', 'settings.mcp.protectedPage.url', form.url, (url) => setForm({ ...form, url }))}
              <SettingsFieldRow label="OAuth"><Switch checked={form.oauth.enabled} aria-label="OAuth" onCheckedChange={(enabled) => setForm({ ...form, oauth: { ...form.oauth, enabled } })} /></SettingsFieldRow>
              {form.oauth.enabled ? <>
                <StringRows label="settings.mcp.protectedPage.scopes" path="http.oauth.scopes" values={form.oauth.scopes} failure={failure} onChange={(scopes) => setForm({ ...form, oauth: { ...form.oauth, scopes } })} onCommit={() => {}} />
                {textField('http.oauth.clientId', 'settings.mcp.protectedPage.clientId', form.oauth.clientId, (clientId) => setForm({ ...form, oauth: { ...form.oauth, clientId } }))}
                <Field path="http.oauth.clientSecret" label={t('settings.mcp.protectedPage.clientSecret')} failure={failure}><SecretField key={saved?.revision} input={form.oauth.clientSecret} label={t('settings.mcp.protectedPage.clientSecret')} required={missing.includes('oauth_client_secret')} onChange={(secret) => setForm({ ...form, oauth: { ...form.oauth, clientSecret: { ...form.oauth.clientSecret, secret } } })} /></Field>
                {textField('http.oauth.issuer', 'settings.mcp.protectedPage.issuer', form.oauth.issuer, (issuer) => setForm({ ...form, oauth: { ...form.oauth, issuer } }))}
                {textField('http.oauth.redirectUri', 'settings.mcp.protectedPage.redirect', form.oauth.redirectUri, (redirectUri) => setForm({ ...form, oauth: { ...form.oauth, redirectUri } }), t('settings.mcp.protectedPage.redirectHelp'))}
              </> : null}
            </>}
          </SettingsSection>
          <SettingsSection title={t(form.transport === 'stdio' ? 'settings.mcp.page.env.title' : 'settings.mcp.protectedPage.headers')} contentClassName="space-y-4">
            {form.transport === 'stdio' ? form.env.map((row, index) => <Field key={index} path={`stdio.env.${row.key}`} label={row.key || t('settings.mcp.page.env.key')} failure={failure}>
              <div className="flex min-w-0 flex-wrap items-center gap-2"><Input value={row.key} aria-label={t('settings.mcp.page.env.key')} dir="ltr" className="min-w-0 flex-1 font-mono typography-meta" onChange={(event) => updateEnv(index, { key: event.target.value })} />
                {kindSelect(row.kind, ['text', 'secret', 'secretFile', 'state'], (kind) => updateEnv(index, { kind, secret: '', text: '', stored: false, slot: kind === 'secret' || kind === 'secretFile' ? row.slot : null }))}
                <Button variant="ghost" size="icon" aria-label={t('settings.mcp.protectedPage.actions.remove')} onClick={() => setForm({ ...form, env: form.env.filter((_, i) => i !== index) })}><Icon name="close" className="size-4" /></Button></div>
              {row.kind === 'secret' || row.kind === 'secretFile' ? <SecretField key={`${saved?.revision}:${row.kind}`} input={row} label={row.key || t('settings.mcp.page.env.value')} required={missing.includes(row.key)} multiline={row.kind === 'secretFile'} onChange={(secret) => updateEnv(index, { secret })} />
                : <Input value={row.text} aria-label={row.key || t('settings.mcp.page.env.value')} dir="ltr" className="font-mono typography-meta" onChange={(event) => updateEnv(index, { text: event.target.value })} />}
            </Field>) : form.headers.map((row, index) => <Field key={index} path={`http.headers.${row.name}`} label={row.name || t('settings.mcp.protectedPage.headers')} failure={failure}>
              <div className="flex min-w-0 flex-wrap items-center gap-2"><Input value={row.name} aria-label={t('settings.mcp.protectedPage.headerName')} dir="ltr" className="min-w-0 flex-1 font-mono typography-meta" onChange={(event) => updateHeader(index, { name: event.target.value })} />
                {kindSelect(row.kind, ['text', 'secret'], (kind) => updateHeader(index, { kind, secret: '', text: '', stored: false, slot: null }))}
                <Button variant="ghost" size="icon" aria-label={t('settings.mcp.protectedPage.actions.remove')} onClick={() => setForm({ ...form, headers: form.headers.filter((_, i) => i !== index) })}><Icon name="close" className="size-4" /></Button></div>
              {row.kind === 'secret' ? <><SecretField key={saved?.revision} input={row} label={row.name || t('settings.mcp.page.env.value')} required={missing.includes(row.name)} onChange={(secret) => updateHeader(index, { secret })} /><Input value={row.prefix} aria-label={t('settings.mcp.protectedPage.prefix')} placeholder="Bearer " dir="ltr" className="font-mono typography-meta" onChange={(event) => updateHeader(index, { prefix: event.target.value })} /></>
                : <Input value={row.text} aria-label={row.name || t('settings.mcp.page.env.value')} dir="ltr" className="font-mono typography-meta" onChange={(event) => updateHeader(index, { text: event.target.value })} />}
            </Field>)}
            <Button variant="outline" size="sm" onClick={() => form.transport === 'stdio'
              ? setForm({ ...form, env: [...form.env, { key: '', kind: 'secret', text: '', slot: null, stored: false, secret: '' }] })
              : setForm({ ...form, headers: [...form.headers, { name: '', kind: 'secret', text: '', prefix: '', slot: null, stored: false, secret: '' }] })}>{t(form.transport === 'stdio' ? 'settings.mcp.page.env.addEnvironmentVariable' : 'settings.mcp.protectedPage.addHeader')}</Button>
          </SettingsSection>
          <SettingsSection title={t('settings.mcp.protectedPage.tools')} info={t('settings.mcp.protectedPage.toolHelp')} contentClassName="space-y-4">
            {(['allowTools', 'denyTools'] as const).map((key) => <StringRows key={key} path={`policy.${key}`} label={key === 'allowTools' ? 'settings.mcp.protectedPage.allowedTools' : 'settings.mcp.protectedPage.hiddenTools'} values={form.policy[key]} failure={failure} onChange={(values) => setForm({ ...form, policy: { ...form.policy, [key]: values } })} onCommit={autosave.requestSave} />)}
            <Field path="policy.defaultArguments" label={t('settings.mcp.protectedPage.defaultArguments')} failure={failure}>
              {form.policy.defaultArguments.map((row, index) => <div key={index} className="flex min-w-0 items-center gap-2">
                {(['name', 'value'] as const).map((key) => <Input key={key} value={row[key]} aria-label={t(key === 'name' ? 'settings.mcp.page.env.key' : 'settings.mcp.page.env.value')} dir="ltr" className="font-mono typography-meta" onChange={(event) => setForm({ ...form, policy: { ...form.policy, defaultArguments: form.policy.defaultArguments.map((entry, i) => i === index ? { ...entry, [key]: event.target.value } : entry) } })} />)}
                <Button variant="ghost" size="icon" aria-label={t('settings.mcp.protectedPage.actions.remove')} onClick={() => { setForm({ ...form, policy: { ...form.policy, defaultArguments: form.policy.defaultArguments.filter((_, i) => i !== index) } }); autosave.requestSave(); }}><Icon name="close" className="size-4" /></Button>
              </div>)}
              <Button variant="outline" size="sm" className="self-start" onClick={() => setForm({ ...form, policy: { ...form.policy, defaultArguments: [...form.policy.defaultArguments, { name: '', value: '' }] } })}>{t('settings.mcp.protectedPage.actions.add')}</Button>
            </Field>
          </SettingsSection>
        </fieldset>
        {saved ? <SettingsSection title={t('settings.mcp.protectedPage.credentials.title')} contentClassName="space-y-3">
          <p className={SETTINGS_HELPER_CLASS}>{credentialStatus()}</p>
          {saved.transport === 'http' && formFromConnection(saved).oauth.enabled ? <>
            {flow.kind === 'idle' ? <Button size="sm" onClick={() => void signIn()} disabled={busy || conflict || configurationDirty || typedSecrets}>{t(saved.oauth?.authorized ? 'settings.mcp.protectedPage.actions.signInAgain' : 'settings.mcp.protectedPage.actions.signIn')}</Button> : <>
              {saved.editable.transport === 'http' && saved.editable.http.oauth?.redirectUri ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.mcp.protectedPage.redirectHelp')}</p> : null}
              {flow.kind === 'waiting' || flow.kind === 'finishing' ? <>
                <SettingsStackedField label={t('settings.providers.page.auth.oauth.linkLabel')}>
                  <div className="flex min-w-0 items-center gap-2">
                    <Input value={flow.authorizationUrl} readOnly inputSize="compact" aria-label={t('settings.providers.page.auth.oauth.linkLabel')} dir="ltr" className="min-w-0 flex-1 font-mono typography-meta" />
                    <div className="flex shrink-0 gap-1">
                      <Button variant="outline" size="sm" onClick={() => void openExternalUrl(flow.authorizationUrl)}>{t('settings.providers.page.actions.open')}</Button>
                      <Button variant="outline" size="sm" onClick={async () => {
                        const copied = await copyTextToClipboard(flow.authorizationUrl);
                        if (copied.ok) toast.success(t('settings.providers.page.toast.oauthLinkCopied'));
                        else toast.error(t('settings.providers.page.toast.oauthLinkCopyFailed'));
                      }}>{t('settings.providers.page.actions.copy')}</Button>
                    </div>
                  </div>
                </SettingsStackedField>
                <Field path="oauth.address" label={t('settings.mcp.protectedPage.address')} failure={failure}>
                  <Input value={address} aria-label={t('settings.mcp.protectedPage.address')} dir="ltr" disabled={flow.kind === 'finishing'} onChange={(event) => setAddress(event.target.value)} className="font-mono typography-meta" />
                  <Button size="sm" className="self-start" onClick={() => void paste()} disabled={!address.trim() || flow.kind === 'finishing'}>{t('settings.mcp.protectedPage.actions.finish')}</Button>
                </Field>
              </> : null}
              <div className="flex flex-wrap items-center gap-2"><span className={SETTINGS_HELPER_CLASS}>{t('settings.mcp.protectedPage.waiting')}<BusyDots /></span><Button variant="ghost" size="sm" onClick={() => { flowGeneration.current += 1; setFlow({ kind: 'idle' }); setAddress(''); }}>{t('settings.common.actions.cancel')}</Button></div>
            </>}
            <p aria-live="polite" className={`${SETTINGS_HELPER_CLASS} min-h-5`}>{outcomeKey ? t(outcomeKey) : outcome}</p>
          </> : null}
          <Button variant="outline" size="sm" onClick={() => setConfirm('revoke')} disabled={controlsDisabled || configurationDirty || typedSecrets || conflict}>{t('settings.mcp.protectedPage.actions.forget')}</Button>
        </SettingsSection> : null}
        {saved && (destinationDirty || typedSecrets) ? <div className="space-y-3 pb-6" data-protected-save>
          <p className={SETTINGS_HELPER_CLASS}>{t(destinationDirty ? 'settings.mcp.protectedPage.save.destination' : 'settings.mcp.protectedPage.save.credentials')}</p>
          {renewals.length ? <p className="typography-meta text-[var(--status-warning-text)]">{t('settings.mcp.protectedPage.save.retype', { labels: retypeLabels })}</p> : null}
          {destinationDirty && form.oauth.enabled && form.transport === 'http' ? <p className={SETTINGS_HELPER_CLASS}>{t('settings.mcp.protectedPage.save.signInAgain')}</p> : null}
          <div className="flex items-center gap-2"><Button size="sm" onClick={() => void save()} disabled={!canSave}>{t('settings.mcp.protectedPage.actions.save')}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => { void serialize(async () => {
            const view = savedRef.current;
            if (!view || !alive.current) return;
            setForm((current) => ({ ...formFromConnection(view), enabled: current.enabled, policy: current.policy }));
            setFailure(null);
          }); }}>{t('settings.mcp.protectedPage.actions.discard')}</Button></div>
        </div> : null}
        <div className="flex items-center gap-2 pb-8">
          {mode.kind === 'create' ? <><Button size="sm" onClick={() => void save()} disabled={!canSave || !availability.visible || availability.disabledReason !== null}>{t(busy ? 'settings.common.actions.saving' : 'settings.common.actions.create')}</Button><Button variant="ghost" size="sm" onClick={leave} disabled={busy}>{t('settings.common.actions.cancel')}</Button></>
            : <Button variant="destructive" size="sm" onClick={() => setConfirm('delete')} disabled={controlsDisabled || conflict}>{t('settings.mcp.protectedPage.actions.delete')}</Button>}
        </div>
      </>}
    </div>
    <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open && !busy) setConfirm(null); }}><DialogContent className="max-w-md"><DialogHeader>
      <DialogTitle>{t(confirm === 'delete' ? 'settings.mcp.protected.delete.title' : 'settings.mcp.protectedPage.forget.title', { name: saved?.name ?? '' })}</DialogTitle>
      <DialogDescription>{t(confirm === 'delete' ? 'settings.mcp.protected.delete.description' : 'settings.mcp.protectedPage.forget.description')}</DialogDescription>
    </DialogHeader><DialogFooter><Button variant="outline" disabled={busy} onClick={() => setConfirm(null)}>{t('settings.common.actions.cancel')}</Button><Button variant="destructive" disabled={busy} onClick={() => void confirmAction()}>{t(confirm === 'delete' ? 'settings.common.actions.delete' : 'settings.mcp.protectedPage.actions.forget')}</Button></DialogFooter></DialogContent></Dialog>
  </SettingsPageLayout>;
}
