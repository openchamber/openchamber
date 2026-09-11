import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { isVSCodeRuntime } from '@/lib/desktop';
import {
  selectMcpServersForDirectory,
  useMcpConfigStore,
  envRecordToArray,
  type McpDraft,
  type McpScope,
} from '@/stores/useMcpConfigStore';
import { useShallow } from 'zustand/react/shallow';
import {
  parseImportedMcpSnippet,
  applyImportedMcpToDraft,
} from './mcpImport';
import { useMcpStore } from '@/stores/useMcpStore';
import { usePendingOpenCodeRestartStore } from '@/stores/usePendingOpenCodeRestartStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { cn } from '@/lib/utils';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsGroupTitle,
  SettingsStackedField,
  SETTINGS_SELECT_SIZE,
  SETTINGS_FIELD_LABEL_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { parseMcpOAuthCallbackContext, parseMcpOAuthCallbackStateKey } from '@/components/sections/mcp/mcpOAuth';
import { buildMcpAuthorizationRedirectUri, startMcpAuthorization } from '@/components/sections/mcp/startMcpAuthorization';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select';
import { Icon } from "@/components/icon/Icon";
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { useI18n } from '@/lib/i18n';

// ─────────────────────────────────────────────────────────────
// CommandTextarea  — one arg per line, paste-friendly
// ─────────────────────────────────────────────────────────────
interface CommandTextareaProps {
  value: string[];
  onChange: (v: string[]) => void;
  preview: (count: number) => string;
  /** Called when the text is plainly a link rather than a command. */
  onDetectUrl?: (url: string) => void;
}

/**
 * Splits a shell-like command string into argv array.
 * Handles simple quoted args (single/double) and plain tokens.
 */
function parseShellCommand(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) { inSingle = !inSingle; continue; }
    if (ch === '"' && !inSingle) { inDouble = !inDouble; continue; }
    if ((ch === ' ' || ch === '\t') && !inSingle && !inDouble) {
      if (current) { args.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

function extractAuthorizationResponse(raw: string): {
  code: string | null;
  context: { name: string; directory: string | null } | null;
  stateKey: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { code: null, context: null, stateKey: null };
  }

  try {
    const parsed = new URL(trimmed);
    const code = parsed.searchParams.get('code');
    if (typeof code === 'string' && code.trim()) {
      return {
        code: code.trim(),
        context: parseMcpOAuthCallbackContext(parsed.searchParams),
        stateKey: parseMcpOAuthCallbackStateKey(parsed.searchParams),
      };
    }
  } catch {
    // Fall through to treating the pasted value as a raw authorization code.
  }

  return {
    code: trimmed,
    context: null,
    stateKey: null,
  };
}

const CommandTextarea: React.FC<CommandTextareaProps> = ({
  value,
  onChange,
  preview,
  onDetectUrl,
}) => {
  // Internal: one arg per line
  const [text, setText] = React.useState(() => value.join('\n'));

  // Sync when external value changes (e.g. switching servers)
  const prevValueRef = React.useRef(value);
  React.useEffect(() => {
    if (JSON.stringify(prevValueRef.current) !== JSON.stringify(value)) {
      prevValueRef.current = value;
      setText(value.join('\n'));
    }
  }, [value]);

  const commit = (raw: string) => {
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    // A single line that is nothing but a URL is a hosted server, not a
    // command to run — the page switches kind rather than making the user say.
    if (onDetectUrl && lines.length === 1 && /^https?:\/\/\S+$/i.test(lines[0].trim())) {
      onDetectUrl(lines[0].trim());
      return;
    }
    onChange(lines);
  };

  /**
   * Pasting a whole command line splits it into arguments here, in the field
   * the user pasted into. The old approach — a button that read the clipboard
   * itself — fails outright wherever the runtime denies clipboard reads.
   */
  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const raw = event.clipboardData.getData('text');
    const trimmed = raw.trim();
    // Only take over a paste that replaces the whole field with one command
    // line; anything else is ordinary editing and belongs to the browser.
    if (!trimmed || trimmed.includes('\n') || !/\s/.test(trimmed)) return;
    const target = event.currentTarget;
    if (target.selectionStart !== 0 || target.selectionEnd !== target.value.length) return;
    event.preventDefault();
    const lines = parseShellCommand(trimmed);
    setText(lines.join('\n'));
    onChange(lines);
  };

  return (
    <div className="space-y-2" data-bwignore="true" data-1p-ignore="true" data-lpignore="true">
      <Textarea
        onPaste={handlePaste}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          commit(e.target.value);
        }}
        onBlur={() => {
          // Normalise on blur: strip trailing spaces from each line
          const cleaned = text
            .split('\n')
            .map((l) => l.trimEnd())
            .join('\n');
          setText(cleaned);
          commit(cleaned);
        }}
        placeholder={
          'npx\n-y\n@modelcontextprotocol/server-postgres\npostgresql://user:pass@host/db'
        }
        rows={Math.max(4, value.length + 1)}
        className="font-mono typography-meta min-h-[80px]"
        spellCheck={false}
      />

      {/* Formatted preview of what will be saved */}
      {value.length > 0 && (
        <details className="group">
          <summary className="typography-micro text-muted-foreground/60 cursor-pointer select-none hover:text-muted-foreground">
            {preview(value.length)}
          </summary>
          <div className="mt-1 rounded-md bg-[var(--surface-elevated)] px-3 py-2 overflow-x-auto">
            <code className="typography-micro text-foreground/80 whitespace-pre">
              {value.map((a, i) => (
                <span key={i} className="block">
                  <span className="text-muted-foreground select-none mr-2">[{i}]</span>
                  {a}
                </span>
              ))}
            </code>
          </div>
        </details>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// EnvEditor  — compact rows, wide value, paste .env support
// ─────────────────────────────────────────────────────────────
interface EnvEntry { key: string; value: string; }

interface EnvEditorProps {
  value: EnvEntry[];
  onChange: (v: EnvEntry[]) => void;
  keyTransform?: (value: string) => string;
  keyPlaceholder?: string;
  keyInputClassName?: string;
  pasteLabel?: string;
  pasteTitle?: string;
  noPairsFoundError: string;
  importSuccess: (count: number) => string;
  clipboardReadFailed: string;
  keyLabel: string;
  valueLabel: string;
  valuePlaceholder: string;
  hideValueTitle: string;
  showValueTitle: string;
  addVariable: string;
  plainTextWarning: string;
  removeVariableAria: string;
}

const normalizeEnvKey = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9_]/g, '_');

const EnvEditor: React.FC<EnvEditorProps> = ({
  value,
  onChange,
  keyTransform = normalizeEnvKey,
  keyPlaceholder = 'API_KEY',
  keyInputClassName = 'w-36 shrink-0 font-mono typography-meta uppercase',
  pasteLabel = 'Paste .env',
  pasteTitle = 'Paste KEY=VALUE lines from clipboard',
  noPairsFoundError,
  importSuccess,
  clipboardReadFailed,
  keyLabel,
  valueLabel,
  valuePlaceholder,
  hideValueTitle,
  showValueTitle,
  addVariable,
  plainTextWarning,
  removeVariableAria,
}) => {
  const [revealedKeys, setRevealedKeys] = React.useState<Set<number>>(new Set());

  const addRow = () => onChange([...value, { key: '', value: '' }]);

  const removeRow = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      next.delete(idx);
      return next;
    });
  };

  const updateRow = (idx: number, field: 'key' | 'value', val: string) => {
    const next = [...value];
    next[idx] = { ...next[idx], [field]: val };
    onChange(next);
  };

  const toggleReveal = (idx: number) => {
    setRevealedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx); else next.add(idx);
      return next;
    });
  };

  const handlePasteDotEnv = async () => {
    try {
      const raw = await navigator.clipboard.readText();
      const parsed: EnvEntry[] = [];
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Strip surrounding quotes
        if ((val.startsWith('"') && val.endsWith('"')) ||
            (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (key) parsed.push({ key, value: val });
      }
      if (parsed.length === 0) {
        toast.error(noPairsFoundError);
        return;
      }
      // Merge: update existing keys, append new ones
      const merged = [...value];
      for (const p of parsed) {
        const existing = merged.findIndex((e) => e.key === p.key);
        if (existing !== -1) merged[existing] = p;
        else merged.push(p);
      }
      onChange(merged);
      toast.success(importSuccess(parsed.length));
    } catch {
      toast.error(clipboardReadFailed);
    }
  };

  const hasSensitiveValues = value.some((e) => e.value.length > 0);

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="typography-micro text-muted-foreground w-32 shrink-0">{keyLabel}</span>
          <span className="typography-micro text-muted-foreground">{valueLabel}</span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="!font-normal gap-1 text-muted-foreground"
          onClick={handlePasteDotEnv}
          type="button"
          title={pasteTitle}
        >
          <Icon name="clipboard" className="h-3 w-3" />
          {pasteLabel}
        </Button>
      </div>

      {/* Rows */}
      <div className="space-y-1.5">
        {value.map((entry, idx) => (
          <div key={idx} className="flex items-center gap-2">
            {/* KEY — fixed narrow width */}
            <Input
              value={entry.key}
              onChange={(e) => updateRow(idx, 'key', keyTransform(e.target.value))}
              placeholder={keyPlaceholder}
              className={keyInputClassName}
              data-bwignore="true"
              data-1p-ignore="true"
              data-lpignore="true"
              spellCheck={false}
            />
            {/* VALUE — takes remaining space */}
            <div className="relative flex-1 flex items-center">
              <Input
                type={revealedKeys.has(idx) ? 'text' : 'password'}
                value={entry.value}
                onChange={(e) => updateRow(idx, 'value', e.target.value)}
                placeholder={valuePlaceholder}
                className="font-mono typography-meta pr-8 w-full"
                autoComplete="new-password"
                data-bwignore="true"
                data-1p-ignore="true"
                data-lpignore="true"
                spellCheck={false}
              />
              <button
                type="button"
                onClick={() => toggleReveal(idx)}
                className="absolute right-2 text-muted-foreground/60 hover:text-muted-foreground"
                title={revealedKeys.has(idx) ? hideValueTitle : showValueTitle}
              >
                {revealedKeys.has(idx)
                  ? <Icon name="eye-off" className="h-3.5 w-3.5" />
                  : <Icon name="eye" className="h-3.5 w-3.5" />}
              </button>
            </div>
            {/* Remove */}
            <Button size="sm"
              variant="ghost"
              className="h-7 w-7 px-0 shrink-0 text-muted-foreground hover:text-[var(--status-error)]"
              onClick={() => removeRow(idx)}
              aria-label={removeVariableAria}
            >
              <Icon name="delete-bin" className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <Button
        variant="outline"
        size="xs"
        className="!font-normal gap-1.5"
        onClick={addRow}
        type="button"
      >
        <Icon name="add" className="h-3.5 w-3.5" />
        {addVariable}
      </Button>

      {hasSensitiveValues && (
        <p className="typography-micro text-muted-foreground/60">
          {plainTextWarning}
        </p>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Status badge
// ─────────────────────────────────────────────────────────────
const StatusBadge: React.FC<{
  status: string | undefined;
  enabled: boolean;
  getStatusLabel: (status: string) => string;
  variant?: 'compact' | 'pill'
}> = ({ status, enabled, getStatusLabel, variant = 'compact' }) => {
  if (!enabled) return null;
  if (!status) return null;

  const colorClassMap: Record<string, { text: string; bg: string }> = {
    connected: { text: 'text-[var(--status-success)]', bg: 'bg-[var(--status-success)]/10' },
    failed: { text: 'text-[var(--status-error)]', bg: 'bg-[var(--status-error)]/10' },
    needs_auth: { text: 'text-[var(--status-warning)]', bg: 'bg-[var(--status-warning)]/10' },
    needs_client_registration: { text: 'text-[var(--status-warning)]', bg: 'bg-[var(--status-warning)]/10' },
    awaiting_restart: { text: 'text-[var(--status-warning)]', bg: 'bg-[var(--status-warning)]/10' },
  };

  const colors = colorClassMap[status] ?? { text: 'text-muted-foreground', bg: '' };

  if (variant === 'pill') {
    return (
      <span className={cn('typography-micro font-medium rounded-full px-2 py-0.5', colors.text, colors.bg)}>
        ● {getStatusLabel(status)}
      </span>
    );
  }

  return (
    <span className={cn('typography-micro font-medium', colors.text)}>
      ● {getStatusLabel(status)}
    </span>
  );
};

const getStatusDescription = (
  status: string | undefined,
  t: (key: string, params?: Record<string, unknown>) => string,
  error?: string
): string => {
  switch (status) {
    case 'connected':
      return t('settings.mcp.page.status.description.connected');
    case 'failed':
      return error?.trim() || t('settings.mcp.page.status.description.failedDefault');
    case 'needs_auth':
      return t('settings.mcp.page.status.description.needsAuth');
    case 'needs_client_registration':
      return error?.trim() || t('settings.mcp.page.status.description.needsClientRegistrationDefault');
    case 'disabled':
      return t('settings.mcp.page.status.description.disabled');
    default:
      return t('settings.mcp.page.status.description.default');
  }
};

const statusCardClass = (status: string | undefined): string => {
  switch (status) {
    case 'failed':
      return 'border-[var(--status-error-border)] bg-[var(--status-error-background)]';
    case 'needs_auth':
    case 'needs_client_registration':
      return 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)]';
    default:
      return 'border-[var(--interactive-border)] bg-[var(--surface-elevated)]';
  }
};

const shouldShowFullStatusCard = (status: string | undefined, authUrl: string | null, needsAuthorization: boolean, isAuthPolling: boolean): boolean => {
  // Only show full card for error/warning states or when auth is in progress
  if (status === 'failed' || status === 'needs_auth' || status === 'needs_client_registration') return true;
  if (authUrl) return true;
  if (needsAuthorization || isAuthPolling) return true;
  return false;
};

const getPendingMcpAuthContext = async (stateKey: string): Promise<{ name: string; directory: string | null } | null> => {
  const response = await runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(stateKey)}`);
  if (!response.ok) {
    return null;
  }

  const payload = await response.json().catch(() => null) as { name?: string; directory?: string | null } | null;
  if (!payload?.name?.trim()) {
    return null;
  }

  return {
    name: payload.name.trim(),
    directory: typeof payload.directory === 'string' && payload.directory.trim() ? payload.directory.trim() : null,
  };
};

const clearPendingMcpAuthContext = async (stateKey: string | null | undefined): Promise<void> => {
  if (typeof stateKey !== 'string' || !stateKey.trim()) {
    return;
  }

  await runtimeFetch(`/api/mcp/auth/pending?state=${encodeURIComponent(stateKey.trim())}`, { method: 'DELETE' }).catch(() => undefined);
};

const normalizeMcpAuthErrorMessage = (
  error: unknown,
  fallback: string,
  t: (key: string, params?: Record<string, unknown>) => string
): string => {
  const message = error instanceof Error ? error.message : fallback;
  if (/oauth state required/i.test(message)) {
    return t('settings.mcp.page.toast.authSessionExpired');
  }
  return message;
};

const buildMcpRuntimeActionKey = (name: string | null, directory?: string | null): string => {
  const normalizedDirectory = typeof directory === 'string' && directory.trim()
    ? directory.trim()
    : '__global__';
  return `${name ?? '__none__'}::${normalizedDirectory}`;
};

// ─────────────────────────────────────────────────────────────
// McpPage
// ─────────────────────────────────────────────────────────────
export const McpPage: React.FC = () => {
  const { t } = useI18n();
  const tUnsafe = React.useCallback(
    (key: string, params?: Record<string, unknown>) => t(key as never, params as never),
    [t]
  );
  const {
    selectedMcpName,
    mcpDraft,
    setMcpDraft,
    setSelectedMcp,
    getMcpByName,
    createMcp,
    updateMcp,
    deleteMcp,
  } = useMcpConfigStore(useShallow((s) => ({
    selectedMcpName: s.selectedMcpName,
    mcpDraft: s.mcpDraft,
    setMcpDraft: s.setMcpDraft,
    setSelectedMcp: s.setSelectedMcp,
    getMcpByName: s.getMcpByName,
    createMcp: s.createMcp,
    updateMcp: s.updateMcp,
    deleteMcp: s.deleteMcp,
  })));

  // Settings browses whichever project its own selector points at; the app
  // stays where it is.
  const currentDirectory = useSettingsDirectory();
  const isVSCodeAuthRuntime = React.useMemo(() => isVSCodeRuntime(), []);
  const mcpStatus = useMcpStore((state) => state.getStatusForDirectory(currentDirectory));
  const mcpDiagnostics = useMcpStore((state) => state.getDiagnosticForDirectory(currentDirectory));
  const refreshStatus = useMcpStore((state) => state.refresh);
  const connectMcp = useMcpStore((state) => state.connect);
  const disconnectMcp = useMcpStore((state) => state.disconnect);
  const completeAuthMcp = useMcpStore((state) => state.completeAuth);
  const clearAuthMcp = useMcpStore((state) => state.clearAuth);
  const testConnectionMcp = useMcpStore((state) => state.testConnection);
  const pendingRestartChanges = usePendingOpenCodeRestartStore((state) => state.changes);

  const mcpServers = useMcpConfigStore((state) => selectMcpServersForDirectory(state, currentDirectory));
  const selectedServer = selectedMcpName ? getMcpByName(selectedMcpName, currentDirectory) : null;
  const isNewServer = Boolean(mcpDraft && mcpDraft.name === selectedMcpName && !selectedServer);

  // ── form state ──
  const [draftName, setDraftName] = React.useState('');
  const [draftScope, setDraftScope] = React.useState<McpScope>('user');
  const [mcpType, setMcpType] = React.useState<'local' | 'remote'>('local');
  const [command, setCommand] = React.useState<string[]>([]);
  const [url, setUrl] = React.useState('');
  const [envEntries, setEnvEntries] = React.useState<Array<{ key: string; value: string }>>([]);
  const [headerEntries, setHeaderEntries] = React.useState<Array<{ key: string; value: string }>>([]);
  const [oauthEnabled, setOauthEnabled] = React.useState(true);
  const [oauthClientId, setOauthClientId] = React.useState('');
  const [oauthClientSecret, setOauthClientSecret] = React.useState('');
  const [oauthScope, setOauthScope] = React.useState('');
  const [oauthRedirectUri, setOauthRedirectUri] = React.useState('');
  const [timeout, setTimeoutValue] = React.useState('');
  const [enabled, setEnabled] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isConnecting, setIsConnecting] = React.useState(false);

  const [isAuthorizing, setIsAuthorizing] = React.useState(false);
  const [isClearingAuth, setIsClearingAuth] = React.useState(false);
  const [isTestingConnection, setIsTestingConnection] = React.useState(false);
  const [isCompletingAuth, setIsCompletingAuth] = React.useState(false);
  const [authUrl, setAuthUrl] = React.useState<string | null>(null);
  const [authStateKey, setAuthStateKey] = React.useState<string | null>(null);
  const [authCallbackInput, setAuthCallbackInput] = React.useState('');
  const [isAuthPolling, setIsAuthPolling] = React.useState(false);
  const authPollAttemptsRef = React.useRef(0);
  const authPollStartsFromNeedsAuthRef = React.useRef(false);
  const [isAdvancedRemoteOptionsOpen, setIsAdvancedRemoteOptionsOpen] = React.useState(false);
  const [showImportDialog, setShowImportDialog] = React.useState(false);
  const [importJsonText, setImportJsonText] = React.useState('');
  const [importError, setImportError] = React.useState<string | null>(null);
  const runtimeActionKey = React.useMemo(
    () => buildMcpRuntimeActionKey(selectedMcpName, currentDirectory),
    [currentDirectory, selectedMcpName],
  );
  const runtimeActionKeyRef = React.useRef(runtimeActionKey);

  const initialRef = React.useRef<{
    mcpType: 'local' | 'remote'; command: string[]; url: string;
    envEntries: Array<{ key: string; value: string }>;
    headerEntries: Array<{ key: string; value: string }>;
    oauthEnabled: boolean;
    oauthClientId: string;
    oauthClientSecret: string;
    oauthScope: string;
    oauthRedirectUri: string;
    timeout: string;
    enabled: boolean;
  } | null>(null);

  const resetTransientAuthState = React.useCallback(() => {
    setAuthUrl(null);
    setAuthStateKey(null);
    setAuthCallbackInput('');
    setIsAuthPolling(false);
    authPollAttemptsRef.current = 0;
    setIsCompletingAuth(false);
    setIsAuthorizing(false);
    setIsClearingAuth(false);
    authPollStartsFromNeedsAuthRef.current = false;
  }, []);

  const handleOpenImportDialog = React.useCallback(() => {
    setImportJsonText('');
    setImportError(null);
    setShowImportDialog(true);
  }, []);

  const handlePasteImportClipboard = React.useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setImportJsonText(text);
      setImportError(null);
    } catch {
      toast.error(t('settings.mcp.page.toast.clipboardReadFailed'));
    }
  }, [t]);

  const handleImportJson = React.useCallback(() => {
    const outcome = parseImportedMcpSnippet(importJsonText, { fallbackName: draftName });
    if (!outcome.ok) {
      setImportError(outcome.error);
      return;
    }

    const partial = {
      name: draftName,
      scope: draftScope,
      type: mcpType,
      command,
      url,
      environment: envEntries,
      headers: headerEntries,
      oauthEnabled,
      oauthClientId,
      oauthClientSecret,
      oauthScope,
      oauthRedirectUri,
      timeout,
      enabled,
    };

    const next = applyImportedMcpToDraft(outcome, partial, { isNewServer });

    setDraftName(next.name);
    setMcpType(next.type as 'local' | 'remote');
    setCommand(next.command ?? []);
    setUrl(next.url ?? '');
    setEnvEntries(next.environment ?? []);
    setHeaderEntries(next.headers ?? []);
    setOauthEnabled(next.oauthEnabled ?? false);
    setOauthClientId(next.oauthClientId ?? '');
    setOauthClientSecret(next.oauthClientSecret ?? '');
    setOauthScope(next.oauthScope ?? '');
    setOauthRedirectUri(next.oauthRedirectUri ?? '');
    setTimeoutValue(next.timeout ?? '');
    setEnabled(next.enabled ?? true);

    setShowImportDialog(false);
    setImportJsonText('');
    setImportError(null);

    toast.success(t('settings.mcp.page.toast.configImported'));
  }, [
    importJsonText,
    draftName,
    draftScope,
    mcpType,
    command,
    url,
    envEntries,
    headerEntries,
    oauthEnabled,
    oauthClientId,
    oauthClientSecret,
    oauthScope,
    oauthRedirectUri,
    timeout,
    enabled,
    isNewServer,
    t,
  ]);

  // Populate form when selection changes
  React.useEffect(() => {
    if (isNewServer && mcpDraft) {
      setDraftName(mcpDraft.name);
      setDraftScope(mcpDraft.scope || 'user');
      setMcpType(mcpDraft.type);
      setCommand(mcpDraft.command);
      setUrl(mcpDraft.url);
      setEnvEntries(mcpDraft.environment);
      setHeaderEntries(mcpDraft.headers);
      setOauthEnabled(mcpDraft.oauthEnabled);
      setOauthClientId(mcpDraft.oauthClientId);
      setOauthClientSecret(mcpDraft.oauthClientSecret);
      setOauthScope(mcpDraft.oauthScope);
      setOauthRedirectUri(mcpDraft.oauthRedirectUri);
      setTimeoutValue(mcpDraft.timeout);
      setEnabled(mcpDraft.enabled);
      setIsAdvancedRemoteOptionsOpen(false);
      initialRef.current = {
        mcpType: mcpDraft.type, command: mcpDraft.command,
        url: mcpDraft.url,
        envEntries: mcpDraft.environment,
        headerEntries: mcpDraft.headers,
        oauthEnabled: mcpDraft.oauthEnabled,
        oauthClientId: mcpDraft.oauthClientId,
        oauthClientSecret: mcpDraft.oauthClientSecret,
        oauthScope: mcpDraft.oauthScope,
        oauthRedirectUri: mcpDraft.oauthRedirectUri,
        timeout: mcpDraft.timeout,
        enabled: mcpDraft.enabled,
      };
      return;
    }
    if (selectedServer) {
      setDraftScope(selectedServer.scope === 'project' ? 'project' : 'user');
      const envArr = envRecordToArray(selectedServer.environment);
      const remoteServer = selectedServer.type === 'remote'
        ? selectedServer as typeof selectedServer & {
            headers?: Record<string, string>;
            oauth?: {
              clientId?: string;
              clientSecret?: string;
              scope?: string;
              redirectUri?: string;
            } | false;
            timeout?: number;
          }
        : null;
      const headersArr = envRecordToArray(remoteServer?.headers);
      const oauth = remoteServer?.oauth;
      const oauthConfig = oauth && typeof oauth === 'object' ? oauth : null;
      const nextOauthEnabled = oauth !== false;
      const serverType = selectedServer.type;
      const cmd = serverType === 'local' ? ((selectedServer as { command?: string[] }).command ?? []) : [];
      const u = serverType === 'remote' ? ((selectedServer as { url?: string }).url ?? '') : '';
      const nextTimeout = typeof remoteServer?.timeout === 'number' && Number.isFinite(remoteServer.timeout)
        ? String(remoteServer.timeout)
        : '';
      setMcpType(serverType);
      setCommand(cmd);
      setUrl(u);
      setEnvEntries(envArr);
      setHeaderEntries(headersArr);
      setOauthEnabled(nextOauthEnabled);
      setOauthClientId(nextOauthEnabled ? (oauthConfig?.clientId ?? '') : '');
      setOauthClientSecret(nextOauthEnabled ? (oauthConfig?.clientSecret ?? '') : '');
      setOauthScope(nextOauthEnabled ? (oauthConfig?.scope ?? '') : '');
      setOauthRedirectUri(nextOauthEnabled ? (oauthConfig?.redirectUri ?? '') : '');
      setTimeoutValue(nextTimeout);
      setEnabled(selectedServer.enabled);
      setIsAdvancedRemoteOptionsOpen(false);
      initialRef.current = {
        mcpType: serverType,
        command: cmd,
        url: u,
        envEntries: envArr,
        headerEntries: headersArr,
        oauthEnabled: nextOauthEnabled,
        oauthClientId: nextOauthEnabled ? (oauthConfig?.clientId ?? '') : '',
        oauthClientSecret: nextOauthEnabled ? (oauthConfig?.clientSecret ?? '') : '',
        oauthScope: nextOauthEnabled ? (oauthConfig?.scope ?? '') : '',
        oauthRedirectUri: nextOauthEnabled ? (oauthConfig?.redirectUri ?? '') : '',
        timeout: nextTimeout,
        enabled: selectedServer.enabled,
      };
    }
  }, [selectedServer, isNewServer, mcpDraft]);

  const isDirty = React.useMemo(() => {
    const init = initialRef.current;
    if (!init) return false;
    return (
      mcpType !== init.mcpType ||
      enabled !== init.enabled ||
      JSON.stringify(command) !== JSON.stringify(init.command) ||
      url !== init.url ||
      JSON.stringify(envEntries) !== JSON.stringify(init.envEntries) ||
      JSON.stringify(headerEntries) !== JSON.stringify(init.headerEntries) ||
      oauthEnabled !== init.oauthEnabled ||
      oauthClientId !== init.oauthClientId ||
      oauthClientSecret !== init.oauthClientSecret ||
      oauthScope !== init.oauthScope ||
      oauthRedirectUri !== init.oauthRedirectUri ||
      timeout !== init.timeout
    );
  }, [mcpType, command, url, envEntries, headerEntries, oauthEnabled, oauthClientId, oauthClientSecret, oauthScope, oauthRedirectUri, timeout, enabled]);

  // What the user has is either a command they were given or a link. Which of
  // the two decides the transport, so the page reads it off the text instead of
  // asking — and lets them correct it when the text alone cannot say.
  const connectionKindTabs = React.useMemo<SortableTabsStripItem[]>(() => [
    {
      id: 'local',
      label: t('settings.mcp.page.connection.kindCommand'),
      icon: <Icon name="terminal" className="h-3.5 w-3.5" />,
    },
    {
      id: 'remote',
      label: t('settings.mcp.page.connection.kindLink'),
      icon: <Icon name="global" className="h-3.5 w-3.5" />,
    },
  ], [t]);

  const handleDetectedUrl = React.useCallback((candidate: string) => {
    setMcpType('remote');
    setUrl(candidate);
    setCommand([]);
  }, []);

  const handleUrlChange = React.useCallback((next: string) => {
    setUrl(next);
    // A command pasted into the link field is still a command.
    const trimmed = next.trim();
    if (trimmed && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) && /\s/.test(trimmed)) {
      setMcpType('local');
      setCommand(parseShellCommand(trimmed));
      setUrl('');
    }
  }, []);

  const handleSave = async () => {
    const name = isNewServer ? draftName.trim() : selectedMcpName ?? '';
    if (!name) { toast.error(t('settings.mcp.page.toast.nameRequired')); return; }
    if (isNewServer && mcpServers.some((s) => s.name === name)) {
      toast.error(t('settings.mcp.page.toast.serverNameExists')); return;
    }
    if (mcpType === 'local' && command.filter(Boolean).length === 0) {
      toast.error(t('settings.mcp.page.toast.localCommandRequired')); return;
    }
    if (mcpType === 'remote' && !url.trim()) {
      toast.error(t('settings.mcp.page.toast.remoteUrlRequired')); return;
    }

    const draft: McpDraft = {
      name,
      scope: draftScope,
      type: mcpType,
      command,
      url,
      environment: envEntries,
      headers: headerEntries,
      oauthEnabled,
      oauthClientId,
      oauthClientSecret,
      oauthScope,
      oauthRedirectUri,
      timeout,
      enabled,
    };
    setIsSaving(true);
    try {
      const result = isNewServer ? await createMcp(draft, currentDirectory) : await updateMcp(name, draft, currentDirectory);
      if (result.ok) {
        await clearPendingMcpAuthContext(authStateKey);
        resetTransientAuthState();
        if (isNewServer) { setMcpDraft(null); setSelectedMcp(name); }
        await refreshStatus({ directory: currentDirectory, silent: true });
        if (result.reloadFailed) {
          toast.warning(result.message || (isNewServer
            ? t('settings.mcp.page.toast.serverCreatedReloadFailed')
            : t('settings.mcp.page.toast.savedReloadFailed')), {
            description: result.warning || t('settings.mcp.page.toast.retryRefreshHint'),
          });
        } else if (result.restartDeferred) {
          toast.success(t('settings.view.pendingRestart.saved'));
        } else {
          toast.success(result.message || (isNewServer
            ? t('settings.mcp.page.toast.serverCreatedReloading')
            : t('settings.mcp.page.toast.savedReloading')));
        }
      } else {
        toast.error(t('settings.mcp.page.toast.saveFailed'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.mcp.page.toast.unexpectedError'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedMcpName) return;
    setIsDeleting(true);
    const result = await deleteMcp(selectedMcpName, currentDirectory);
    if (result.ok) {
      await clearPendingMcpAuthContext(authStateKey);
      resetTransientAuthState();
      if (result.reloadFailed) {
        toast.warning(result.message || t('settings.mcp.page.toast.serverDeletedReloadFailed', { name: selectedMcpName }), {
          description: result.warning || t('settings.mcp.page.toast.refreshListIfStale'),
        });
      } else {
        toast.success(result.message || t('settings.mcp.page.toast.serverDeleted', { name: selectedMcpName }));
      }
      setShowDeleteConfirm(false);
    } else toast.error(t('settings.mcp.page.toast.deleteFailed'));
    setIsDeleting(false);
  };

  const handleToggleConnect = async () => {
    if (!selectedMcpName) return;
    setIsConnecting(true);
    try {
      const isConnected = mcpStatus[selectedMcpName]?.status === 'connected';
      if (isConnected) {
        await disconnectMcp(selectedMcpName, currentDirectory);
        toast.success(t('settings.mcp.page.toast.disconnected'));
      } else {
        await connectMcp(selectedMcpName, currentDirectory);
        await refreshStatus({ directory: currentDirectory, silent: true });
        const nextStatus = useMcpStore.getState().getStatusForDirectory(currentDirectory)[selectedMcpName];
        if (nextStatus?.status === 'connected') {
          toast.success(t('settings.mcp.page.toast.connected'));
        } else if (nextStatus?.status === 'needs_auth') {
          toast.message(t('settings.mcp.page.toast.connectionNeedsAuthorization'));
        } else if (nextStatus?.status === 'needs_client_registration') {
          toast.message(t('settings.mcp.page.toast.connectionNeedsClientRegistration'));
        } else if (nextStatus?.status === 'failed') {
          toast.error(nextStatus.error || t('settings.mcp.page.toast.connectionFailed'));
        } else {
          toast.message(t('settings.mcp.page.toast.connectionAttemptFinished'));
        }
        return;
      }
      await refreshStatus({ directory: currentDirectory, silent: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.mcp.page.toast.connectionFailed'));
    } finally {
      setIsConnecting(false);
    }
  };

  const requireSavedConfig = React.useCallback((): boolean => {
    if (isNewServer) {
      toast.error(t('settings.mcp.page.toast.createServerBeforeLiveActions'));
      return false;
    }
    if (isDirty) {
      toast.error(t('settings.mcp.page.toast.saveBeforeLiveActions'));
      return false;
    }
    return true;
  }, [isDirty, isNewServer, t]);

  const handleRefreshRuntimeStatus = React.useCallback(async (silent = false) => {
    try {
      await refreshStatus({ directory: currentDirectory, silent });
    } catch (err) {
      if (!silent) {
        toast.error(err instanceof Error ? err.message : t('settings.mcp.page.toast.refreshStatusFailed'));
      }
    }
  }, [currentDirectory, refreshStatus, t]);

  React.useEffect(() => {
    void handleRefreshRuntimeStatus(true);
  }, [handleRefreshRuntimeStatus]);

  React.useEffect(() => {
    runtimeActionKeyRef.current = runtimeActionKey;
    setIsConnecting(false);
    setIsTestingConnection(false);
    resetTransientAuthState();
  }, [resetTransientAuthState, runtimeActionKey]);

  const handleStartAuthorization = React.useCallback(async () => {
    if (!selectedMcpName || mcpType !== 'remote' || !requireSavedConfig()) return;

    setIsAuthorizing(true);
    const actionKey = runtimeActionKey;
    let queuedStateKey: string | null = null;
    try {
      const currentStatus = useMcpStore.getState().getStatusForDirectory(currentDirectory)[selectedMcpName]?.status;
      authPollStartsFromNeedsAuthRef.current = currentStatus === 'needs_auth' || currentStatus === 'needs_client_registration';

      // One implementation for every surface that can authorise; the page
      // used to own this flow while the dropdown and the work-status panel
      // called plain `connect`, which cannot start OAuth at all.
      const { authorizationUrl: nextAuthUrl, opened, nativeFlow, completion } = await startMcpAuthorization({
        name: selectedMcpName,
        directory: currentDirectory,
      });

      if (nativeFlow) {
        // OpenCode opened the browser and completes the flow itself; there is
        // no URL or state to track. The completion promise is the authoritative
        // end signal — status polling alone cannot tell a finished
        // reauthorization from the still-connected state it started in.
        if (runtimeActionKeyRef.current !== actionKey) return;
        setAuthUrl(null);
        setAuthStateKey(null);
        setIsAuthPolling(true);
        authPollAttemptsRef.current = 0;
        toast.message(t('settings.mcp.page.toast.completeAuthorizationInBrowser'));
        completion
          ?.then(() => {
            if (runtimeActionKeyRef.current !== actionKey) return;
            setIsAuthPolling(false);
            authPollAttemptsRef.current = 0;
            authPollStartsFromNeedsAuthRef.current = false;
            toast.success(t('settings.mcp.page.toast.authorizationCompleted'));
          })
          .catch((completionError) => {
            if (runtimeActionKeyRef.current !== actionKey) return;
            setIsAuthPolling(false);
            authPollAttemptsRef.current = 0;
            authPollStartsFromNeedsAuthRef.current = false;
            toast.error(normalizeMcpAuthErrorMessage(completionError, t('settings.mcp.page.toast.authorizationFailed'), tUnsafe));
          });
        return;
      }

      const stateKey = parseMcpOAuthCallbackStateKey(new URL(nextAuthUrl).searchParams);
      queuedStateKey = stateKey;

      if (runtimeActionKeyRef.current !== actionKey) {
        return;
      }

      setAuthUrl(nextAuthUrl);
      setAuthStateKey(stateKey ?? null);
      setIsAuthPolling(true);
      authPollAttemptsRef.current = 0;

      if (runtimeActionKeyRef.current !== actionKey) {
        return;
      }

      if (opened) {
        toast.message(
          isVSCodeAuthRuntime
            ? t('settings.mcp.page.toast.completeAuthorizationInBrowserWithPaste')
            : t('settings.mcp.page.toast.completeAuthorizationInBrowser'),
        );
      } else {
        toast.error(t('settings.mcp.page.toast.openAuthorizationUrlFailed'));
      }
    } catch (err) {
      await clearPendingMcpAuthContext(queuedStateKey);
      if (runtimeActionKeyRef.current === actionKey) {
        toast.error(normalizeMcpAuthErrorMessage(err, t('settings.mcp.page.toast.authorizationStartFailed'), tUnsafe));
      }
    } finally {
      if (runtimeActionKeyRef.current === actionKey) {
        setIsAuthorizing(false);
      }
    }
  }, [currentDirectory, isVSCodeAuthRuntime, mcpType, requireSavedConfig, runtimeActionKey, selectedMcpName, t, tUnsafe]);

  const handleClearAuthorization = React.useCallback(async () => {
    if (!selectedMcpName || !requireSavedConfig()) return;

    setIsClearingAuth(true);
    const actionKey = runtimeActionKey;
    try {
      await clearAuthMcp(selectedMcpName, currentDirectory);

      if (runtimeActionKeyRef.current !== actionKey) {
        return;
      }

      setAuthUrl(null);
      setAuthStateKey(null);
      setAuthCallbackInput('');
      setIsAuthPolling(false);
      authPollAttemptsRef.current = 0;
      await clearPendingMcpAuthContext(authStateKey);
      toast.success(t('settings.mcp.page.toast.savedAuthorizationRemoved'));
    } catch (err) {
      if (runtimeActionKeyRef.current === actionKey) {
        toast.error(normalizeMcpAuthErrorMessage(err, t('settings.mcp.page.toast.clearAuthorizationFailed'), tUnsafe));
      }
    } finally {
      if (runtimeActionKeyRef.current === actionKey) {
        setIsClearingAuth(false);
      }
    }
  }, [authStateKey, clearAuthMcp, currentDirectory, requireSavedConfig, runtimeActionKey, selectedMcpName, t, tUnsafe]);

  const handleCopyAuthUrl = React.useCallback(async () => {
    if (!authUrl) return;
    const result = await copyTextToClipboard(authUrl);
    if (result.ok) {
      toast.success(t('settings.mcp.page.toast.authorizationUrlCopied'));
      return;
    }
    toast.error(t('settings.mcp.page.toast.authorizationUrlCopyFailed'));
  }, [authUrl, t]);

  const handleCompleteAuthorization = React.useCallback(async () => {
    const response = extractAuthorizationResponse(authCallbackInput);
    if (!response.code) {
      toast.error(t('settings.mcp.page.toast.pasteCallbackOrCodeFirst'));
      return;
    }

    const pendingContext = response.stateKey ? await getPendingMcpAuthContext(response.stateKey) : null;
    const resolvedContext = response.context ?? pendingContext;
    const targetName = resolvedContext?.name ?? selectedMcpName;
    const targetDirectory = resolvedContext?.directory ?? currentDirectory;

    if (!targetName) {
      toast.error(t('settings.mcp.page.toast.missingServerDetails'));
      return;
    }

    if (!resolvedContext && !requireSavedConfig()) return;

    setIsCompletingAuth(true);
    const actionKey = runtimeActionKey;
    try {
      await completeAuthMcp(targetName, response.code, targetDirectory);
      await clearPendingMcpAuthContext(response.stateKey ?? authStateKey);

      if (runtimeActionKeyRef.current !== actionKey) {
        return;
      }

      setAuthCallbackInput('');
      setAuthUrl(null);
      setAuthStateKey(null);
      setIsAuthPolling(false);
      authPollAttemptsRef.current = 0;
      toast.success(targetName === selectedMcpName
        ? t('settings.mcp.page.toast.authorizationCompleted')
        : t('settings.mcp.page.toast.authorizationCompletedFor', { name: targetName }));
    } catch (err) {
      if (runtimeActionKeyRef.current === actionKey) {
        toast.error(normalizeMcpAuthErrorMessage(err, t('settings.mcp.page.toast.authorizationCompleteFailed'), tUnsafe));
      }
    } finally {
      if (runtimeActionKeyRef.current === actionKey) {
        setIsCompletingAuth(false);
      }
    }
  }, [authCallbackInput, authStateKey, completeAuthMcp, currentDirectory, requireSavedConfig, runtimeActionKey, selectedMcpName, t, tUnsafe]);

  const handleTestConnection = React.useCallback(async () => {
    if (!selectedMcpName || !requireSavedConfig()) return;
    if (!enabled) {
      toast.error(t('settings.mcp.page.toast.enableServerBeforeTest'));
      return;
    }

    setIsTestingConnection(true);
    try {
      const result = await testConnectionMcp(selectedMcpName, currentDirectory);
      const nextStatus = result.status?.status;

      if (result.warning) {
        toast.warning(result.warning);
      } else if (nextStatus === 'connected') {
        toast.success(t('settings.mcp.page.toast.connectionTestSucceeded'));
      } else if (nextStatus === 'needs_auth') {
        toast.message(t('settings.mcp.page.toast.connectionNeedsAuthorization'));
      } else if (nextStatus === 'needs_client_registration') {
        toast.message(t('settings.mcp.page.toast.connectionNeedsClientRegistration'));
      } else if (nextStatus === 'failed') {
        toast.error(result.status?.error || result.error || t('settings.mcp.page.toast.connectionTestFailed'));
      } else if (result.error) {
        toast.error(result.error);
      } else {
        toast.message(t('settings.mcp.page.toast.connectionTestFinished'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.mcp.page.toast.connectionTestFailed'));
    } finally {
      setIsTestingConnection(false);
    }
  }, [currentDirectory, enabled, requireSavedConfig, selectedMcpName, t, testConnectionMcp]);

  React.useEffect(() => {
    if (!isAuthPolling || !selectedMcpName) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void (async () => {
        authPollAttemptsRef.current += 1;
        await refreshStatus({ directory: currentDirectory, silent: true });
        const nextStatus = useMcpStore.getState().getStatusForDirectory(currentDirectory)[selectedMcpName];

        if (!nextStatus) {
          return;
        }

        if (
          authPollStartsFromNeedsAuthRef.current
          && nextStatus.status !== 'needs_auth'
          && nextStatus.status !== 'needs_client_registration'
        ) {
          setIsAuthPolling(false);
          authPollAttemptsRef.current = 0;
          authPollStartsFromNeedsAuthRef.current = false;
          setAuthUrl(null);
          setAuthCallbackInput('');
          if (nextStatus.status === 'connected') {
            toast.success(t('settings.mcp.page.toast.authorizationCompleted'));
          }
          return;
        }

        if (!authPollStartsFromNeedsAuthRef.current && nextStatus.status === 'failed') {
          setIsAuthPolling(false);
          authPollAttemptsRef.current = 0;
          authPollStartsFromNeedsAuthRef.current = false;
          toast.error(nextStatus.error || t('settings.mcp.page.toast.authorizationFailed'));
          return;
        }

        if (authPollAttemptsRef.current >= 30) {
          setIsAuthPolling(false);
          authPollAttemptsRef.current = 0;
          authPollStartsFromNeedsAuthRef.current = false;
          toast.message(t('settings.mcp.page.toast.authorizationStillInProgress'));
        }
      })();
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [currentDirectory, isAuthPolling, refreshStatus, selectedMcpName, t]);

  // ── Empty state ──
  if (!selectedMcpName) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="plug" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.mcp.page.empty.selectServer')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.mcp.page.empty.addNewOne')}</p>
        </div>
      </div>
    );
  }

  const runtimeStatus = mcpStatus[selectedMcpName];
  const runtimeDiagnostic = selectedMcpName ? mcpDiagnostics[selectedMcpName] : undefined;
  const effectiveRuntimeStatus = runtimeStatus ?? runtimeDiagnostic;
  // Saved into the config but queued behind Apply & Restart: OpenCode does not
  // know this server yet, so every runtime action (connect, authorize, clear
  // auth) can only fail with "server not found". The page says that instead of
  // offering the buttons.
  const isAwaitingRestart = !isNewServer && !effectiveRuntimeStatus
    && pendingRestartChanges.some((change) => change.scope === 'mcp' && change.id.startsWith(`mcp:${selectedMcpName}:`));
  const isConnected = runtimeStatus?.status === 'connected';
  const needsAuthorization = runtimeStatus?.status === 'needs_auth' || runtimeStatus?.status === 'needs_client_registration';
  // Must be the very URI `startMcpAuthorization` writes into the config, not a
  // second construction of it. The page used to suggest a directory-bearing
  // address while the flow sent a directory-less one, so a provider enforcing
  // exact redirect matching rejected a registration copied from right here.
  const suggestedRedirectUri = isVSCodeAuthRuntime || !selectedMcpName
    ? null
    : buildMcpAuthorizationRedirectUri(selectedMcpName);

  const handleCopyRedirectUri = async () => {
    if (!suggestedRedirectUri) return;
    try {
      await navigator.clipboard.writeText(suggestedRedirectUri);
      toast.success(t('settings.mcp.page.toast.copiedCallbackUrl'));
    } catch {
      toast.error(t('settings.mcp.page.toast.clipboardWriteFailed'));
    }
  };


  const runtimeDescription = getStatusDescription(
    effectiveRuntimeStatus?.status,
    tUnsafe,
    effectiveRuntimeStatus && 'error' in effectiveRuntimeStatus ? effectiveRuntimeStatus.error : undefined,
  );
  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'connected':
        return t('settings.mcp.page.status.label.connected');
      case 'failed':
        return t('settings.mcp.page.status.label.failed');
      case 'needs_auth':
        return t('settings.mcp.page.status.label.needsAuth');
      case 'needs_client_registration':
        return t('settings.mcp.page.status.label.needsRegistration');
      case 'awaiting_restart':
        return t('settings.mcp.page.status.label.awaitingRestart');
      default:
        return status;
    }
  };

  return (
    <>
      <SettingsPageLayout
        title={isNewServer ? t('settings.mcp.page.header.newServer') : selectedMcpName}
        titleAccessory={!isNewServer ? (
          <StatusBadge
            status={isAwaitingRestart ? 'awaiting_restart' : effectiveRuntimeStatus?.status}
            enabled={enabled}
            getStatusLabel={getStatusLabel}
            variant="pill"
          />
        ) : undefined}
        description={isNewServer
          ? t('settings.mcp.page.header.configureNewServer')
          : t('settings.mcp.page.header.transport', { type: mcpType === 'local' ? t('settings.mcp.page.transport.local') : t('settings.mcp.page.transport.remote') })}
        headerEnd={!isNewServer && !isAwaitingRestart ? (
          <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={isConnected ? 'outline' : 'default'}
            size="xs"
            className="!font-normal"
            onClick={handleToggleConnect}
            disabled={isConnecting || !enabled}
          >
            {isConnecting ? t('settings.mcp.page.actions.working') : isConnected ? t('settings.mcp.page.actions.disconnect') : t('settings.mcp.page.actions.connect')}
          </Button>
          {mcpType === 'remote' && (
            <>
              <Button
                variant={needsAuthorization ? 'default' : 'outline'}
                size="xs"
                className="!font-normal"
                onClick={() => void handleStartAuthorization()}
                disabled={isAuthorizing || !enabled}
              >
                {/* "Reauthorize" only once a working authorization exists (the
                    server is connected); every other state — needs_auth,
                    failed, still unknown — reads "Authorize" so the label does
                    not imply stored credentials that may not be there. */}
                {isAuthorizing
                  ? t('settings.mcp.page.actions.starting')
                  : isConnected
                    ? t('settings.mcp.page.actions.reauthorize')
                    : t('settings.mcp.page.actions.authorize')}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="!font-normal gap-1 text-muted-foreground"
                onClick={() => void handleClearAuthorization()}
                disabled={isClearingAuth || !enabled}
              >
                {isClearingAuth ? t('settings.mcp.page.actions.clearing') : t('settings.mcp.page.actions.clearAuth')}
              </Button>
            </>
          )}
          {isConnected && (
            <Button
              variant="ghost"
              size="xs"
              className="!font-normal gap-1 text-muted-foreground"
              onClick={() => void handleTestConnection()}
              disabled={isTestingConnection || !enabled}
            >
              {isTestingConnection ? t('settings.mcp.page.actions.testing') : t('settings.mcp.page.actions.test')}
            </Button>
          )}
        </div>
      ) : undefined}
      showSaveStatus={false}
    >



        {/* Saved but queued behind Apply & Restart: dynamic status the user
            must see, or the missing action buttons read as a broken page. */}
        {isAwaitingRestart && (
          <SettingsSection divider={false}>
            <div className="rounded-lg border p-3 border-[var(--status-warning-border)] bg-[var(--status-warning-background)]">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.mcp.page.status.runtimeStatus')}</span>
                  <StatusBadge status="awaiting_restart" enabled={enabled} getStatusLabel={getStatusLabel} />
                </div>
                <p className="typography-meta text-muted-foreground">
                  {t('settings.mcp.page.status.description.awaitingRestart')}
                </p>
              </div>
            </div>
          </SettingsSection>
        )}

        {/* Runtime Status - Simplified for connected, expanded for errors */}
        {!isNewServer && !isAwaitingRestart && shouldShowFullStatusCard(effectiveRuntimeStatus?.status, authUrl, needsAuthorization, isAuthPolling) && (
          <SettingsSection divider={false}>
            <div className={cn('rounded-lg border p-3', statusCardClass(effectiveRuntimeStatus?.status))}>
              <div className="space-y-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.mcp.page.status.runtimeStatus')}</span>
                    <StatusBadge status={effectiveRuntimeStatus?.status} enabled={enabled} getStatusLabel={getStatusLabel} />
                  </div>
                  <p className="typography-meta text-muted-foreground">{runtimeDescription}</p>
                  <p className="typography-micro text-muted-foreground/80">
                    {draftScope === 'project'
                      ? t('settings.mcp.page.status.projectScopedTo', { directory: currentDirectory ?? t('settings.mcp.page.status.activeProject') })
                      : t('settings.mcp.page.status.userScoped')}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {!isConnected && (
                    <Button
                      variant="outline"
                      size="xs"
                      className="!font-normal"
                      onClick={() => void handleTestConnection()}
                      disabled={isTestingConnection || !enabled}
                    >
                      {isTestingConnection ? t('settings.mcp.page.actions.testing') : t('settings.mcp.page.actions.testConnection')}
                    </Button>
                  )}
                </div>

                {/* Client credentials appear only when the server has said it
                    needs them. Kept as a permanent four-field form, they made
                    the rarest case the most prominent thing on the page and
                    told nobody what to put there. */}
                {effectiveRuntimeStatus?.status === 'needs_client_registration' && (
                  <div className="space-y-3 rounded-md border border-[var(--interactive-border)] bg-[var(--surface-background)] px-3 py-3">
                    <div>
                      <SettingsGroupTitle as="div">{t('settings.mcp.page.registration.title')}</SettingsGroupTitle>
                      <p className="mt-1 typography-micro text-muted-foreground">
                        {t('settings.mcp.page.registration.description')}
                      </p>
                    </div>

                    {suggestedRedirectUri && (
                      <div>
                        <div className="typography-micro text-muted-foreground">
                          {t('settings.mcp.page.registration.callbackLabel')}
                        </div>
                        <div className="mt-1 flex items-start gap-2">
                          <span className="min-w-0 flex-1 break-all font-mono typography-micro text-foreground/80">
                            {suggestedRedirectUri}
                          </span>
                          <Button
                            variant="outline"
                            size="xs"
                            className="!font-normal"
                            onClick={() => void handleCopyRedirectUri()}
                          >
                            <Icon name="clipboard" className="h-3.5 w-3.5" />
                            {t('settings.mcp.page.actions.copyLink')}
                          </Button>
                        </div>
                      </div>
                    )}

                    <div className="grid gap-3 @xl:grid-cols-2">
                      <SettingsStackedField label={t('settings.mcp.page.registration.clientId')}>
                        <Input
                          value={oauthClientId}
                          onChange={(e) => { setOauthClientId(e.target.value); setOauthEnabled(true); }}
                          className="font-mono typography-meta"
                          data-bwignore="true"
                          data-1p-ignore="true"
                        />
                      </SettingsStackedField>
                      <SettingsStackedField label={t('settings.mcp.page.registration.clientSecret')}>
                        <Input
                          type="password"
                          value={oauthClientSecret}
                          onChange={(e) => { setOauthClientSecret(e.target.value); setOauthEnabled(true); }}
                          className="font-mono typography-meta"
                          data-bwignore="true"
                          data-1p-ignore="true"
                        />
                      </SettingsStackedField>
                    </div>

                    <p className="typography-micro text-muted-foreground">
                      {t('settings.mcp.page.registration.afterSaving')}
                    </p>
                  </div>
                )}

                {authUrl && (
                  <div className="rounded-md border border-[var(--interactive-border)] bg-[var(--surface-background)] px-3 py-2">
                    <div className="space-y-2">
                      <div className="typography-micro text-muted-foreground">{t('settings.mcp.page.auth.authorizationUrl')}</div>
                      <div className="break-all typography-micro text-foreground font-mono">{authUrl}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="xs" className="!font-normal" onClick={() => void openExternalUrl(authUrl)}>
                          <Icon name="external-link" className="h-3.5 w-3.5" />
                          {t('settings.mcp.page.actions.openInBrowser')}
                        </Button>
                        <Button variant="outline" size="xs" className="!font-normal" onClick={() => void handleCopyAuthUrl()}>
                          <Icon name="clipboard" className="h-3.5 w-3.5" />
                          {t('settings.mcp.page.actions.copyLink')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {/* VS Code only. Everywhere else the callback returns into the
                    app on its own, so the paste box was a second, confusing way
                    to do what already happened. VS Code cannot receive that
                    redirect, so there it remains the only way to finish. */}
                {isVSCodeAuthRuntime && mcpType === 'remote' && (needsAuthorization || isAuthPolling || authUrl) && (
                  <div className="rounded-md border border-[var(--interactive-border)] bg-[var(--surface-background)] px-3 py-3">
                    <div className="space-y-2">
                      <div>
                        <SettingsGroupTitle as="div">{t('settings.mcp.page.auth.manualFallbackTitle')}</SettingsGroupTitle>
                        <p className="mt-1 typography-micro text-muted-foreground">
                          {t('settings.mcp.page.auth.manualFallbackDescription')}
                        </p>
                      </div>
                      <Textarea
                        value={authCallbackInput}
                        onChange={(event) => setAuthCallbackInput(event.target.value)}
                        placeholder={t('settings.mcp.page.auth.callbackInputPlaceholder')}
                        rows={3}
                        className="font-mono typography-meta"
                        data-bwignore="true"
                        data-1p-ignore="true"
                        spellCheck={false}
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          variant="outline"
                          size="xs"
                          className="!font-normal"
                          onClick={() => void handleCompleteAuthorization()}
                          disabled={isCompletingAuth}
                        >
                          {isCompletingAuth ? t('settings.mcp.page.actions.completing') : t('settings.mcp.page.actions.completeAuthorization')}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {isAuthPolling && (
                <p className="mt-4 typography-micro text-muted-foreground">
                  {t('settings.mcp.page.auth.waitingForOpenCode')}
                </p>
              )}
            </div>
          </SettingsSection>
        )}

        <SettingsSection
          title={t('settings.mcp.page.server.title')}
          divider={false}
          settingsItem="mcp.server"
          contentClassName="space-y-0"
          titleAccessory={isNewServer ? (
            <Button
              variant="ghost"
              size="xs"
              className="!font-normal gap-1.5 text-muted-foreground"
              onClick={handleOpenImportDialog}
              type="button"
              title={t('settings.mcp.page.server.importJsonTitle')}
            >
              <Icon name="file-code" className="h-3.5 w-3.5" />
              {t('settings.mcp.page.server.importJson')}
            </Button>
          ) : null}
        >

            {isNewServer && (
              <SettingsFieldRow
                label={t('settings.mcp.page.server.name')}
                // The scope select carries words now, not a lone icon, so the
                // control cluster has to be allowed to bound itself and wrap.
                // Left at its default (fit-width, no shrink) the pair ran past
                // the edge of the settings pane in a narrow dialog.
                controlClassName="flex-wrap @xl:w-auto @xl:flex-1"
              >
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
                    placeholder={t('settings.mcp.page.server.namePlaceholder')}
                    className="h-7 w-48 min-w-0 max-w-full shrink font-mono px-2"
                    autoFocus
                  />
                  <Select value={draftScope} onValueChange={(value) => setDraftScope(value as McpScope)}>
                    <SelectTrigger size={SETTINGS_SELECT_SIZE} className="!h-7 min-w-0 max-w-full gap-1.5 px-2">
                      <Icon
                        name={draftScope === 'user' ? 'user-3' : 'folder'}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span className="truncate">
                        {draftScope === 'user'
                          ? t('settings.mcp.page.scope.everywhere')
                          : t('settings.mcp.page.scope.thisProject')}
                      </span>
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="user">
                        <div className="flex items-center gap-2">
                          <Icon name="user-3" className="h-3.5 w-3.5" />
                          <span>{t('settings.mcp.page.scope.everywhere')}</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="project">
                        <div className="flex items-center gap-2">
                          <Icon name="folder" className="h-3.5 w-3.5" />
                          <span>{t('settings.mcp.page.scope.thisProject')}</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
              </SettingsFieldRow>
            )}

            <SettingsCheckboxRow
              checked={enabled}
              onChange={setEnabled}
              label={t('settings.mcp.page.server.enable')}
              ariaLabel={t('settings.mcp.page.server.enableAria')}
            />

        </SettingsSection>

        <SettingsSection
          title={t('settings.mcp.page.connection.title')}
          description={t('settings.mcp.page.connection.description')}
          settingsItem="mcp.command"
          // The section's content wrapper carries no spacing of its own, so the
          // kind tabs, the field and its hint would otherwise sit flush.
          contentClassName="space-y-2"
        >
            {/* Pasting a link or a command still flips this for you, but the
                choice is a control you can see and press. As one sentence with
                an inline link it was, in practice, undiscoverable. */}
            <SortableTabsStrip
              items={connectionKindTabs}
              activeId={mcpType}
              onSelect={(id) => setMcpType(id as 'local' | 'remote')}
              layoutMode="fit"
              variant="active-pill"
              activePillLowercase={false}
              className="h-10"
            />

            {mcpType === 'local' ? (
              <CommandTextarea
                value={command}
                onChange={setCommand}
                preview={(count) => t('settings.mcp.page.connection.previewArgs', { count })}
                onDetectUrl={handleDetectedUrl}
              />
            ) : (
              <Input
                value={url}
                onChange={(e) => handleUrlChange(e.target.value)}
                placeholder={t('settings.mcp.page.connection.serverUrlPlaceholder')}
                className="font-mono typography-meta"
              />
            )}

            <p className="typography-micro text-muted-foreground">
              {mcpType === 'local'
                ? t('settings.mcp.page.connection.hintCommand')
                : t('settings.mcp.page.connection.hintLink')}
            </p>
        </SettingsSection>

        {mcpType === 'remote' && (
          <SettingsSection
            title={t('settings.mcp.page.advanced.title')}
            settingsItem="mcp.advanced"
          >
              <Collapsible
                open={isAdvancedRemoteOptionsOpen}
                onOpenChange={setIsAdvancedRemoteOptionsOpen}
              >
                <CollapsibleTrigger className="flex w-full items-center justify-between py-0.5 group">
                  <div className="flex items-center gap-1.5 text-left">
                    <span className="typography-ui-label font-normal text-foreground">{t('settings.mcp.page.advanced.configure')}</span>
                    <span className="typography-micro text-muted-foreground">
                      {/* OAuth left the form, so the summary stops reporting a
                          setting the user can no longer see. */}
                      ({headerEntries.length} {t('settings.mcp.page.advanced.headers')}{timeout ? ` · ${timeout}ms` : ''})
                    </span>
                  </div>
                  {isAdvancedRemoteOptionsOpen ? (
                    <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  ) : (
                    <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  )}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:gap-8">
                        <div className="flex min-w-0 flex-row items-center gap-1 @xl:w-56 shrink-0">
                          <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.mcp.page.advanced.timeoutMs')}</span>
                          <SettingsInfoHint>{t('settings.mcp.page.advanced.timeoutHint')}</SettingsInfoHint>
                        </div>
                        <div className="flex items-center gap-2">
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            value={timeout}
                            onChange={(e) => setTimeoutValue(e.target.value)}
                            placeholder="5000"
                            className="h-7 w-32 font-mono px-2"
                            data-bwignore="true"
                            data-1p-ignore="true"
                          />
                        </div>
                      </div>
                    </div>

                    <div>
                      <SettingsGroupTitle as="div" className="mb-2">
                        {t('settings.mcp.page.advanced.requestHeaders')}
                        {headerEntries.length > 0 && (
                          <span className="ml-1.5 typography-micro text-muted-foreground font-normal">({headerEntries.length})</span>
                        )}
                      </SettingsGroupTitle>
                      <EnvEditor
                        value={headerEntries}
                        onChange={setHeaderEntries}
                        keyTransform={(value) => value.trimStart()}
                        keyPlaceholder={t('settings.mcp.page.advanced.headerNamePlaceholder')}
                        keyInputClassName="w-36 shrink-0 font-mono typography-meta"
                        pasteLabel={t('settings.mcp.page.advanced.pasteHeaders')}
                        pasteTitle={t('settings.mcp.page.advanced.pasteHeadersTitle')}
                        noPairsFoundError={t('settings.mcp.page.toast.noKeyValuePairsFound')}
                        importSuccess={(count) => t('settings.mcp.page.toast.importedVariablesCount', { count })}
                        clipboardReadFailed={t('settings.mcp.page.toast.clipboardReadFailed')}
                        keyLabel={t('settings.mcp.page.env.key')}
                        valueLabel={t('settings.mcp.page.env.value')}
                        valuePlaceholder={t('settings.mcp.page.env.valuePlaceholder')}
                        hideValueTitle={t('settings.mcp.page.env.hide')}
                        showValueTitle={t('settings.mcp.page.env.show')}
                        addVariable={t('settings.mcp.page.env.addVariable')}
                        plainTextWarning={t('settings.mcp.page.env.plainTextWarning')}
                        removeVariableAria={t('settings.mcp.page.env.removeVariableAria')}
                      />
                    </div>

                  </div>
                </CollapsibleContent>
              </Collapsible>
          </SettingsSection>
        )}

        <SettingsSection
          title={t('settings.mcp.page.env.title')}
          description={t('settings.mcp.page.env.description')}
          titleAccessory={
            envEntries.length > 0 ? (
              <span className="typography-micro text-muted-foreground font-normal">
                ({envEntries.length})
              </span>
            ) : null
          }
          settingsItem="mcp.environment"
        >
            {envEntries.length === 0 ? (
              <Button
                variant="outline"
                size="xs"
                className="!font-normal gap-1.5"
                onClick={() => setEnvEntries([{ key: '', value: '' }])}
              >
                <Icon name="add" className="h-3.5 w-3.5" />
                {t('settings.mcp.page.env.addEnvironmentVariable')}
              </Button>
            ) : (
              <EnvEditor
                value={envEntries}
                onChange={setEnvEntries}
                keyPlaceholder={t('settings.mcp.page.env.keyPlaceholder')}
                pasteLabel={t('settings.mcp.page.env.pasteEnv')}
                pasteTitle={t('settings.mcp.page.env.pasteEnvTitle')}
                noPairsFoundError={t('settings.mcp.page.toast.noKeyValuePairsFound')}
                importSuccess={(count) => t('settings.mcp.page.toast.importedVariablesCount', { count })}
                clipboardReadFailed={t('settings.mcp.page.toast.clipboardReadFailed')}
                keyLabel={t('settings.mcp.page.env.key')}
                valueLabel={t('settings.mcp.page.env.value')}
                valuePlaceholder={t('settings.mcp.page.env.valuePlaceholder')}
                hideValueTitle={t('settings.mcp.page.env.hide')}
                showValueTitle={t('settings.mcp.page.env.show')}
                addVariable={t('settings.mcp.page.env.addVariable')}
                plainTextWarning={t('settings.mcp.page.env.plainTextWarning')}
                removeVariableAria={t('settings.mcp.page.env.removeVariableAria')}
              />
            )}
        </SettingsSection>

        <div className="flex items-center gap-2 pb-8">
          <Button
            onClick={handleSave}
            disabled={isSaving || (!isDirty && !isNewServer)}
            size="xs"
            className="!font-normal"
          >
            {isSaving ? t('settings.common.actions.saving') : isNewServer ? t('settings.common.actions.create') : t('settings.common.actions.saveChanges')}
          </Button>
          {!isNewServer && (
            <Button
              variant="destructive"
              size="xs"
              className="!font-normal"
              onClick={() => setShowDeleteConfirm(true)}
            >
              {t('settings.common.actions.delete')}
            </Button>
          )}
        </div>      </SettingsPageLayout>


      {/* Import JSON dialog */}
      <Dialog
        open={showImportDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowImportDialog(false);
            setImportJsonText('');
            setImportError(null);
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.mcp.page.importDialog.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.mcp.page.importDialog.description')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <Textarea
              value={importJsonText}
              onChange={(e) => {
                setImportJsonText(e.target.value);
                setImportError(null);
              }}
              placeholder={'{\n  "mcpServers": {\n    "postgres": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-postgres"]\n    }\n  }\n}'}
              rows={8}
              className="font-mono typography-meta"
              spellCheck={false}
              data-bwignore="true"
              data-1p-ignore="true"
            />

            {importError && (
              <p className="typography-micro text-[var(--status-error)]">{importError}</p>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                className="!font-normal gap-1"
                onClick={handlePasteImportClipboard}
                type="button"
              >
                <Icon name="clipboard" className="h-3.5 w-3.5" />
                {t('settings.mcp.page.importDialog.pasteFromClipboard')}
              </Button>
            </div>

          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setShowImportDialog(false);
                setImportJsonText('');
                setImportError(null);
              }}
              className="text-foreground"
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button
              onClick={handleImportJson}
              disabled={!importJsonText.trim()}
              size="sm"
            >
              {t('settings.common.actions.import')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog
        open={showDeleteConfirm}
        onOpenChange={(open) => { if (!open && !isDeleting) setShowDeleteConfirm(false); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.mcp.page.deleteDialog.title', { name: selectedMcpName ?? '' })}</DialogTitle>
            <DialogDescription>
              {t('settings.mcp.page.deleteDialog.descriptionPrefix')}{' '}
              <code className="text-foreground">opencode.json</code>.
              {' '}
              {t('settings.mcp.page.deleteDialog.descriptionSuffix')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
              className="text-foreground"
            >
              {t('settings.common.actions.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? t('settings.mcp.page.actions.deleting') : t('settings.common.actions.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
};
