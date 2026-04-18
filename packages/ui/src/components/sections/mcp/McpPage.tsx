import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { isVSCodeRuntime } from '@/lib/desktop';
import {
  useMcpConfigStore,
  envRecordToArray,
  type McpDraft,
  type McpScope,
} from '@/stores/useMcpConfigStore';
import {
  parseImportedMcpSnippet,
  applyImportedMcpToDraft,
} from './mcpImport';
import { useMcpStore } from '@/stores/useMcpStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  RiAddLine,
  RiArrowDownSLine,
  RiArrowRightSLine,
  RiClipboardLine,
  RiDeleteBinLine,
  RiEyeLine,
  RiEyeOffLine,
  RiExternalLinkLine,
  RiFileCodeLine,
  RiFolderLine,
  RiPlugLine,
  RiUser3Line,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { MCP_OAUTH_CALLBACK_PATH, parseMcpOAuthCallbackContext, parseMcpOAuthCallbackStateKey } from '@/components/sections/mcp/mcpOAuth';
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

// ─────────────────────────────────────────────────────────────
// CommandTextarea  — one arg per line, paste-friendly
// ─────────────────────────────────────────────────────────────
interface CommandTextareaProps {
  value: string[];
  onChange: (v: string[]) => void;
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

const CommandTextarea: React.FC<CommandTextareaProps> = ({ value, onChange }) => {
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
    onChange(lines);
  };

  const handlePasteFromClipboard = async () => {
    try {
      const raw = await navigator.clipboard.readText();
      const trimmed = raw.trim();
      // If it looks like a multi-line list, keep as-is; otherwise parse as shell command
      const lines = trimmed.includes('\n')
        ? trimmed.split('\n').filter((l) => l.trim())
        : parseShellCommand(trimmed);
      setText(lines.join('\n'));
      onChange(lines);
      toast.success(`Pasted ${lines.length} argument${lines.length !== 1 ? 's' : ''}`);
    } catch {
      toast.error('Cannot read clipboard');
    }
  };

  return (
    <div className="space-y-2" data-bwignore="true" data-1p-ignore="true" data-lpignore="true">
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="xs"
          className="!font-normal gap-1 text-muted-foreground"
          onClick={handlePasteFromClipboard}
          type="button"
          title="Paste a local command from clipboard and auto-split"
        >
          <RiClipboardLine className="h-3 w-3" />
          Paste Command
        </Button>
      </div>

      <Textarea
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
        className="font-mono typography-meta resize-y min-h-[80px]"
        spellCheck={false}
      />

      {/* Formatted preview of what will be saved */}
      {value.length > 0 && (
        <details className="group">
          <summary className="typography-micro text-muted-foreground/60 cursor-pointer select-none hover:text-muted-foreground">
            Preview ({value.length} args)
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
        toast.error('No KEY=VALUE pairs found in clipboard');
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
      toast.success(`Imported ${parsed.length} variable${parsed.length !== 1 ? 's' : ''}`);
    } catch {
      toast.error('Cannot read clipboard');
    }
  };

  const hasSensitiveValues = value.some((e) => e.value.length > 0);

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="typography-micro text-muted-foreground w-32 shrink-0">Key</span>
          <span className="typography-micro text-muted-foreground">Value</span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="!font-normal gap-1 text-muted-foreground"
          onClick={handlePasteDotEnv}
          type="button"
          title={pasteTitle}
        >
          <RiClipboardLine className="h-3 w-3" />
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
                placeholder="value"
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
                title={revealedKeys.has(idx) ? 'Hide' : 'Show'}
              >
                {revealedKeys.has(idx)
                  ? <RiEyeOffLine className="h-3.5 w-3.5" />
                  : <RiEyeLine className="h-3.5 w-3.5" />}
              </button>
            </div>
            {/* Remove */}
            <Button size="sm"
              variant="ghost"
              className="h-7 w-7 px-0 shrink-0 text-muted-foreground hover:text-[var(--status-error)]"
              onClick={() => removeRow(idx)}
            >
              <RiDeleteBinLine className="h-3.5 w-3.5" />
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
        <RiAddLine className="h-3.5 w-3.5" />
        Add variable
      </Button>

      {hasSensitiveValues && (
        <p className="typography-micro text-muted-foreground/60">
          ⚠ Values are stored as plain text in opencode.json
        </p>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Status badge
// ─────────────────────────────────────────────────────────────
const STATUS_LABEL: Record<string, string> = {
  connected: 'Connected',
  failed: 'Failed',
  needs_auth: 'Needs auth',
  needs_client_registration: 'Needs registration',
};

const StatusBadge: React.FC<{ status: string | undefined; enabled: boolean; variant?: 'compact' | 'pill' }> = ({ status, enabled, variant = 'compact' }) => {
  if (!enabled) return null;
  if (!status) return null;

  const colorClassMap: Record<string, { text: string; bg: string }> = {
    connected: { text: 'text-[var(--status-success)]', bg: 'bg-[var(--status-success)]/10' },
    failed: { text: 'text-[var(--status-error)]', bg: 'bg-[var(--status-error)]/10' },
    needs_auth: { text: 'text-[var(--status-warning)]', bg: 'bg-[var(--status-warning)]/10' },
    needs_client_registration: { text: 'text-[var(--status-warning)]', bg: 'bg-[var(--status-warning)]/10' },
  };

  const colors = colorClassMap[status] ?? { text: 'text-muted-foreground', bg: '' };

  if (variant === 'pill') {
    return (
      <span className={cn('typography-micro font-medium rounded-full px-2 py-0.5', colors.text, colors.bg)}>
        ● {STATUS_LABEL[status] ?? status}
      </span>
    );
  }

  return (
    <span className={cn('typography-micro font-medium', colors.text)}>
      ● {STATUS_LABEL[status] ?? status}
    </span>
  );
};

const getStatusDescription = (status: string | undefined, error?: string): string => {
  switch (status) {
    case 'connected':
      return 'Connected and ready for OpenCode to discover tools and resources.';
    case 'failed':
      return error?.trim() || 'OpenCode could not reach this MCP server.';
    case 'needs_auth':
      return 'This remote MCP server requires authorization before it can connect.';
    case 'needs_client_registration':
      return error?.trim() || 'This remote MCP server requires client registration before authorization can complete.';
    case 'disabled':
      return 'This MCP server is disabled in configuration.';
    default:
      return 'Refresh or test the connection to load live runtime status.';
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

const buildMcpOAuthRedirectUri = (name?: string | null, directory?: string | null): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const url = new URL(MCP_OAUTH_CALLBACK_PATH, window.location.origin);
  if (typeof name === 'string' && name.trim()) {
    url.searchParams.set('server', name.trim());
  }
  if (typeof directory === 'string' && directory.trim()) {
    url.searchParams.set('directory', directory.trim());
  }
  return url.toString();
};

const queuePendingMcpAuthContext = async (input: {
  state: string;
  name: string;
  directory?: string | null;
}): Promise<void> => {
  const response = await fetch('/api/mcp/auth/pending', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      state: input.state,
      name: input.name,
      directory: typeof input.directory === 'string' && input.directory.trim() ? input.directory.trim() : null,
    }),
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || 'Failed to prepare MCP authorization callback');
  }
};

const getPendingMcpAuthContext = async (stateKey: string): Promise<{ name: string; directory: string | null } | null> => {
  const response = await fetch(`/api/mcp/auth/pending?state=${encodeURIComponent(stateKey)}`);
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

  await fetch(`/api/mcp/auth/pending?state=${encodeURIComponent(stateKey.trim())}`, { method: 'DELETE' }).catch(() => undefined);
};

const normalizeMcpAuthErrorMessage = (error: unknown, fallback: string): string => {
  const message = error instanceof Error ? error.message : fallback;
  if (/oauth state required/i.test(message)) {
    return 'Authorization session expired or was cleared during reload. Click Authorize again.';
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
  const {
    selectedMcpName,
    mcpServers,
    mcpDraft,
    setMcpDraft,
    setSelectedMcp,
    getMcpByName,
    createMcp,
    updateMcp,
    deleteMcp,
  } = useMcpConfigStore();

  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const isVSCodeAuthRuntime = React.useMemo(() => isVSCodeRuntime(), []);
  const mcpStatus = useMcpStore((state) => state.getStatusForDirectory(currentDirectory ?? null));
  const mcpDiagnostics = useMcpStore((state) => state.getDiagnosticForDirectory(currentDirectory ?? null));
  const refreshStatus = useMcpStore((state) => state.refresh);
  const connectMcp = useMcpStore((state) => state.connect);
  const disconnectMcp = useMcpStore((state) => state.disconnect);
  const startAuthMcp = useMcpStore((state) => state.startAuth);
  const completeAuthMcp = useMcpStore((state) => state.completeAuth);
  const clearAuthMcp = useMcpStore((state) => state.clearAuth);
  const testConnectionMcp = useMcpStore((state) => state.testConnection);

  const selectedServer = selectedMcpName ? getMcpByName(selectedMcpName) : null;
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
      toast.error('Cannot read clipboard');
    }
  }, []);

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

    if (next.name && next.name !== draftName && isNewServer) {
      setDraftName(next.name);
    }

    toast.success('MCP configuration imported');
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
      const t = selectedServer.type;
      const cmd = t === 'local' ? ((selectedServer as { command?: string[] }).command ?? []) : [];
      const u = t === 'remote' ? ((selectedServer as { url?: string }).url ?? '') : '';
      const nextTimeout = typeof remoteServer?.timeout === 'number' && Number.isFinite(remoteServer.timeout)
        ? String(remoteServer.timeout)
        : '';
      setMcpType(t);
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
        mcpType: t,
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

  const handleSave = async () => {
    const name = isNewServer ? draftName.trim() : selectedMcpName ?? '';
    if (!name) { toast.error('Name is required'); return; }
    if (isNewServer && mcpServers.some((s) => s.name === name)) {
      toast.error('A server with this name already exists'); return;
    }
    if (mcpType === 'local' && command.filter(Boolean).length === 0) {
      toast.error('Command cannot be empty for a local server'); return;
    }
    if (mcpType === 'remote' && !url.trim()) {
      toast.error('URL cannot be empty for a remote server'); return;
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
      const result = isNewServer ? await createMcp(draft) : await updateMcp(name, draft);
      if (result.ok) {
        await clearPendingMcpAuthContext(authStateKey);
        resetTransientAuthState();
        if (isNewServer) { setMcpDraft(null); setSelectedMcp(name); }
        await refreshStatus({ directory: currentDirectory, silent: true });
        if (result.reloadFailed) {
          toast.warning(result.message || (isNewServer ? 'MCP server created, but OpenCode reload failed.' : 'Saved, but OpenCode reload failed.'), {
            description: result.warning || 'Retry refresh or reopen Settings before authorizing this server.',
          });
        } else {
          toast.success(result.message || (isNewServer ? 'MCP server created. OpenCode reloading…' : 'Saved. OpenCode reloading…'));
        }
      } else {
        toast.error('Failed to save');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedMcpName) return;
    setIsDeleting(true);
    const result = await deleteMcp(selectedMcpName);
    if (result.ok) {
      await clearPendingMcpAuthContext(authStateKey);
      resetTransientAuthState();
      if (result.reloadFailed) {
        toast.warning(result.message || `"${selectedMcpName}" deleted, but OpenCode reload failed`, {
          description: result.warning || 'Refresh the MCP list if the UI looks stale.',
        });
      } else {
        toast.success(result.message || `"${selectedMcpName}" deleted`);
      }
      setShowDeleteConfirm(false);
    } else toast.error('Failed to delete');
    setIsDeleting(false);
  };

  const handleToggleConnect = async () => {
    if (!selectedMcpName) return;
    setIsConnecting(true);
    try {
      const isConnected = mcpStatus[selectedMcpName]?.status === 'connected';
      if (isConnected) {
        await disconnectMcp(selectedMcpName, currentDirectory);
        toast.success('Disconnected');
      } else {
        await connectMcp(selectedMcpName, currentDirectory);
        await refreshStatus({ directory: currentDirectory, silent: true });
        const nextStatus = useMcpStore.getState().getStatusForDirectory(currentDirectory ?? null)[selectedMcpName];
        if (nextStatus?.status === 'connected') {
          toast.success('Connected');
        } else if (nextStatus?.status === 'needs_auth') {
          toast.message('Connection requires authorization');
        } else if (nextStatus?.status === 'needs_client_registration') {
          toast.message('Connection requires client registration');
        } else if (nextStatus?.status === 'failed') {
          toast.error(nextStatus.error || 'Connection failed');
        } else {
          toast.message('Connection attempt finished. Refresh status for details.');
        }
        return;
      }
      await refreshStatus({ directory: currentDirectory, silent: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setIsConnecting(false);
    }
  };

  const requireSavedConfig = React.useCallback((): boolean => {
    if (isNewServer) {
      toast.error('Create the server before running live actions');
      return false;
    }
    if (isDirty) {
      toast.error('Save changes before running live actions');
      return false;
    }
    return true;
  }, [isDirty, isNewServer]);

  const handleRefreshRuntimeStatus = React.useCallback(async (silent = false) => {
    try {
      await refreshStatus({ directory: currentDirectory, silent });
    } catch (err) {
      if (!silent) {
        toast.error(err instanceof Error ? err.message : 'Failed to refresh MCP status');
      }
    }
  }, [currentDirectory, refreshStatus]);

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
      const currentStatus = useMcpStore.getState().getStatusForDirectory(currentDirectory ?? null)[selectedMcpName]?.status;
      authPollStartsFromNeedsAuthRef.current = currentStatus === 'needs_auth' || currentStatus === 'needs_client_registration';

      const redirectUri = buildMcpOAuthRedirectUri(selectedMcpName, currentDirectory);
      if (!redirectUri) {
        throw new Error('Unable to build MCP OAuth redirect URL');
      }

      if (!oauthRedirectUri.trim() && !isVSCodeAuthRuntime) {
        const saved = await updateMcp(selectedMcpName, {
          oauthEnabled,
          oauthClientId,
          oauthClientSecret,
          oauthScope,
          oauthRedirectUri: redirectUri,
        });

        if (!saved.ok) {
          throw new Error('Failed to save the browser callback URL for MCP authorization');
        }

        if (saved.reloadFailed) {
          throw new Error(saved.warning || saved.message || 'OpenCode reload failed after saving the browser callback URL');
        }

        if (runtimeActionKeyRef.current !== actionKey) {
          return;
        }

        setOauthRedirectUri(redirectUri);
        initialRef.current = initialRef.current
          ? { ...initialRef.current, oauthRedirectUri: redirectUri }
          : initialRef.current;
      }

      const nextAuthUrl = await startAuthMcp(selectedMcpName, currentDirectory);
      const stateKey = parseMcpOAuthCallbackStateKey(new URL(nextAuthUrl).searchParams);
      if (stateKey) {
        queuedStateKey = stateKey;
        await queuePendingMcpAuthContext({
          state: stateKey,
          name: selectedMcpName,
          directory: currentDirectory,
        });
      }

      if (runtimeActionKeyRef.current !== actionKey) {
        return;
      }

      setAuthUrl(nextAuthUrl);
      setAuthStateKey(stateKey ?? null);
      setIsAuthPolling(true);
      authPollAttemptsRef.current = 0;

      const opened = await openExternalUrl(nextAuthUrl);
      if (runtimeActionKeyRef.current !== actionKey) {
        return;
      }

      if (opened) {
        toast.message(
          isVSCodeAuthRuntime
            ? 'Complete the MCP authorization flow in your browser, then paste the returned code or callback URL here'
            : 'Complete the MCP authorization flow in your browser',
        );
      } else {
        toast.error('Could not open the authorization URL automatically');
      }
    } catch (err) {
      await clearPendingMcpAuthContext(queuedStateKey);
      if (runtimeActionKeyRef.current === actionKey) {
        toast.error(normalizeMcpAuthErrorMessage(err, 'Failed to start authorization'));
      }
    } finally {
      if (runtimeActionKeyRef.current === actionKey) {
        setIsAuthorizing(false);
      }
    }
  }, [currentDirectory, isVSCodeAuthRuntime, mcpType, oauthClientId, oauthClientSecret, oauthEnabled, oauthRedirectUri, oauthScope, requireSavedConfig, runtimeActionKey, selectedMcpName, startAuthMcp, updateMcp]);

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
      toast.success('Saved MCP authorization was removed');
    } catch (err) {
      if (runtimeActionKeyRef.current === actionKey) {
        toast.error(normalizeMcpAuthErrorMessage(err, 'Failed to clear authorization'));
      }
    } finally {
      if (runtimeActionKeyRef.current === actionKey) {
        setIsClearingAuth(false);
      }
    }
  }, [authStateKey, clearAuthMcp, currentDirectory, requireSavedConfig, runtimeActionKey, selectedMcpName]);

  const handleCopyAuthUrl = React.useCallback(async () => {
    if (!authUrl) return;
    const result = await copyTextToClipboard(authUrl);
    if (result.ok) {
      toast.success('Authorization URL copied');
      return;
    }
    toast.error('Failed to copy authorization URL');
  }, [authUrl]);

  const handleCompleteAuthorization = React.useCallback(async () => {
    const response = extractAuthorizationResponse(authCallbackInput);
    if (!response.code) {
      toast.error('Paste the callback URL or authorization code first');
      return;
    }

    const pendingContext = response.stateKey ? await getPendingMcpAuthContext(response.stateKey) : null;
    const resolvedContext = response.context ?? pendingContext;
    const targetName = resolvedContext?.name ?? selectedMcpName;
    const targetDirectory = resolvedContext?.directory ?? currentDirectory;

    if (!targetName) {
      toast.error('Missing MCP server details. Select the server again or paste the full callback URL.');
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
      toast.success(targetName === selectedMcpName ? 'MCP authorization completed' : `MCP authorization completed for ${targetName}`);
    } catch (err) {
      if (runtimeActionKeyRef.current === actionKey) {
        toast.error(normalizeMcpAuthErrorMessage(err, 'Failed to complete MCP authorization'));
      }
    } finally {
      if (runtimeActionKeyRef.current === actionKey) {
        setIsCompletingAuth(false);
      }
    }
  }, [authCallbackInput, authStateKey, completeAuthMcp, currentDirectory, requireSavedConfig, runtimeActionKey, selectedMcpName]);

  const handleTestConnection = React.useCallback(async () => {
    if (!selectedMcpName || !requireSavedConfig()) return;
    if (!enabled) {
      toast.error('Enable this server before testing the connection');
      return;
    }

    setIsTestingConnection(true);
    try {
      const result = await testConnectionMcp(selectedMcpName, currentDirectory);
      const nextStatus = result.status?.status;

      if (nextStatus === 'connected') {
        toast.success('Connection test succeeded');
      } else if (nextStatus === 'needs_auth') {
        toast.message('Connection requires authorization');
      } else if (nextStatus === 'needs_client_registration') {
        toast.message('Connection requires client registration');
      } else if (nextStatus === 'failed') {
        toast.error(result.status?.error || result.error || 'Connection test failed');
      } else if (result.error) {
        toast.error(result.error);
      } else {
        toast.message('Connection test finished. Refresh status for details.');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setIsTestingConnection(false);
    }
  }, [currentDirectory, enabled, requireSavedConfig, selectedMcpName, testConnectionMcp]);

  React.useEffect(() => {
    if (!isAuthPolling || !selectedMcpName) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void (async () => {
        authPollAttemptsRef.current += 1;
        await refreshStatus({ directory: currentDirectory, silent: true });
        const nextStatus = useMcpStore.getState().getStatusForDirectory(currentDirectory ?? null)[selectedMcpName];

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
            toast.success('MCP authorization completed');
          }
          return;
        }

        if (!authPollStartsFromNeedsAuthRef.current && nextStatus.status === 'failed') {
          setIsAuthPolling(false);
          authPollAttemptsRef.current = 0;
          authPollStartsFromNeedsAuthRef.current = false;
          toast.error(nextStatus.error || 'Authorization failed');
          return;
        }

        if (authPollAttemptsRef.current >= 30) {
          setIsAuthPolling(false);
          authPollAttemptsRef.current = 0;
          authPollStartsFromNeedsAuthRef.current = false;
          toast.message('Authorization is still in progress in your browser. Paste the callback URL or code if needed.');
        }
      })();
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [currentDirectory, isAuthPolling, refreshStatus, selectedMcpName]);

  // ── Empty state ──
  if (!selectedMcpName) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <RiPlugLine className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">Select an MCP server from the sidebar</p>
          <p className="typography-meta mt-1 opacity-75">or add a new one</p>
        </div>
      </div>
    );
  }

  const runtimeStatus = mcpStatus[selectedMcpName];
  const runtimeDiagnostic = selectedMcpName ? mcpDiagnostics[selectedMcpName] : undefined;
  const effectiveRuntimeStatus = runtimeStatus ?? runtimeDiagnostic;
  const isConnected = runtimeStatus?.status === 'connected';
  const needsAuthorization = runtimeStatus?.status === 'needs_auth' || runtimeStatus?.status === 'needs_client_registration';
  const suggestedRedirectUri = isVSCodeAuthRuntime ? null : buildMcpOAuthRedirectUri(selectedMcpName, currentDirectory);
  const runtimeDescription = getStatusDescription(
    effectiveRuntimeStatus?.status,
    effectiveRuntimeStatus && 'error' in effectiveRuntimeStatus ? effectiveRuntimeStatus.error : undefined,
  );

  return (
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4">
          <div className="min-w-0">
            {isNewServer ? (
              <h2 className="typography-ui-header font-semibold text-foreground truncate">New MCP Server</h2>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="typography-ui-header font-semibold text-foreground truncate">{selectedMcpName}</h2>
                <StatusBadge status={effectiveRuntimeStatus?.status} enabled={enabled} variant="pill" />
              </div>
            )}
            <div className="flex items-center gap-2 mt-0.5">
              <p className="typography-meta text-muted-foreground truncate">
                {isNewServer ? 'Configure a new MCP server' : `${mcpType === 'local' ? 'Local · stdio' : 'Remote · SSE'} transport`}
              </p>
              {!isNewServer && (
                <>
                  <Button
                    variant={isConnected ? 'outline' : 'default'}
                    size="xs"
                    className="!font-normal"
                    onClick={handleToggleConnect}
                    disabled={isConnecting || !enabled}
                    >
                      {isConnecting ? 'Working...' : isConnected ? 'Disconnect' : 'Connect'}
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
                        {isAuthorizing ? 'Starting...' : needsAuthorization ? 'Authorize' : 'Reauthorize'}
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        className="!font-normal gap-1 text-muted-foreground"
                        onClick={() => void handleClearAuthorization()}
                        disabled={isClearingAuth || !enabled}
                      >
                        {isClearingAuth ? 'Clearing...' : 'Clear Auth'}
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
                      {isTestingConnection ? 'Testing...' : 'Test'}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Runtime Status - Simplified for connected, expanded for errors */}
        {!isNewServer && shouldShowFullStatusCard(effectiveRuntimeStatus?.status, authUrl, needsAuthorization, isAuthPolling) && (
          <div className="mb-6 px-2">
            <div className={cn('rounded-lg border p-3', statusCardClass(effectiveRuntimeStatus?.status))}>
              <div className="space-y-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="typography-ui-label text-foreground">Runtime Status</span>
                    <StatusBadge status={effectiveRuntimeStatus?.status} enabled={enabled} />
                  </div>
                  <p className="typography-meta text-muted-foreground">{runtimeDescription}</p>
                  <p className="typography-micro text-muted-foreground/80">
                    {draftScope === 'project'
                      ? `Project-scoped to ${currentDirectory ?? 'the active project'}`
                      : 'User-scoped configuration'}
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
                      {isTestingConnection ? 'Testing...' : 'Test Connection'}
                    </Button>
                  )}
                </div>

                {authUrl && (
                  <div className="rounded-md border border-[var(--interactive-border)] bg-[var(--surface-background)] px-3 py-2">
                    <div className="space-y-2">
                      <div className="typography-micro text-muted-foreground">Authorization URL</div>
                      <div className="break-all typography-micro text-foreground font-mono">{authUrl}</div>
                      <div className="flex flex-wrap items-center gap-2">
                        <Button variant="outline" size="xs" className="!font-normal" onClick={() => void openExternalUrl(authUrl)}>
                          <RiExternalLinkLine className="h-3.5 w-3.5" />
                          Open in Browser
                        </Button>
                        <Button variant="outline" size="xs" className="!font-normal" onClick={() => void handleCopyAuthUrl()}>
                          <RiClipboardLine className="h-3.5 w-3.5" />
                          Copy Link
                        </Button>
                      </div>
                    </div>
                  </div>
                )}

                {mcpType === 'remote' && (needsAuthorization || isAuthPolling || authUrl) && (
                  <div className="rounded-md border border-[var(--interactive-border)] bg-[var(--surface-background)] px-3 py-3">
                    <div className="space-y-2">
                      <div>
                        <div className="typography-ui-label text-foreground">Manual Authorization Fallback</div>
                        <p className="mt-1 typography-micro text-muted-foreground">
                          If the browser returns to a different machine or shows a callback URL with a code, paste that full URL or the raw code here.
                        </p>
                      </div>
                      <Textarea
                        value={authCallbackInput}
                        onChange={(event) => setAuthCallbackInput(event.target.value)}
                        placeholder="Paste the callback URL or authorization code"
                        rows={3}
                        className="font-mono typography-meta resize-y"
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
                          {isCompletingAuth ? 'Completing...' : 'Complete Authorization'}
                        </Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {isAuthPolling && (
                <p className="mt-4 typography-micro text-muted-foreground">
                  Waiting for OpenCode to observe the completed browser authorization flow...
                </p>
              )}
            </div>
          </div>
        )}

        {/* Server Identity */}
        <div className="mb-6">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">Server</h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0">

            {isNewServer && (
              <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
                <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                  <span className="typography-ui-label text-foreground">Server Name</span>
                </div>
                <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
                    placeholder="my-mcp-server"
                    className="h-7 w-48 font-mono px-2"
                    autoFocus
                  />
                  <Select value={draftScope} onValueChange={(value) => setDraftScope(value as McpScope)}>
                    <SelectTrigger className="!h-7 !w-7 !min-w-0 !px-0 !py-0 justify-center [&>svg:last-child]:hidden" title={draftScope === 'user' ? 'User scope' : 'Project scope'}>
                      {draftScope === 'user' ? <RiUser3Line className="h-3.5 w-3.5" /> : <RiFolderLine className="h-3.5 w-3.5" />}
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="user">
                        <div className="flex items-center gap-2">
                          <RiUser3Line className="h-3.5 w-3.5" />
                          <span>User</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="project">
                        <div className="flex items-center gap-2">
                          <RiFolderLine className="h-3.5 w-3.5" />
                          <span>Project</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            {/* Import JSON - prominent placement for new servers */}
            {isNewServer && (
              <div className="py-1.5">
                <Button
                  variant="outline"
                  size="xs"
                  className="!font-normal gap-1.5"
                  onClick={handleOpenImportDialog}
                  type="button"
                  title="Import a full MCP server configuration from a JSON snippet"
                >
                  <RiFileCodeLine className="h-3.5 w-3.5" />
                  Import from JSON Snippet
                </Button>
              </div>
            )}

            <div
              className="group flex cursor-pointer items-center gap-2 py-1.5"
              role="button"
              tabIndex={0}
              aria-pressed={enabled}
              onClick={() => setEnabled(!enabled)}
              onKeyDown={(event) => {
                if (event.key === ' ' || event.key === 'Enter') {
                  event.preventDefault();
                  setEnabled(!enabled);
                }
              }}
            >
              <Checkbox
                checked={enabled}
                onChange={setEnabled}
                ariaLabel="Enable server"
              />
              <span className="typography-ui-label text-foreground">Enable Server</span>
            </div>

            <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
              <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                <span className="typography-ui-label text-foreground">Transport Mode</span>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="chip"
                    size="xs"
                    aria-pressed={mcpType === 'local'}
                    onClick={() => setMcpType('local')}
                    className="!font-normal"
                  >
                    Local · stdio
                  </Button>
                  <Button
                    variant="chip"
                    size="xs"
                    aria-pressed={mcpType === 'remote'}
                    onClick={() => setMcpType('remote')}
                    className="!font-normal"
                  >
                    Remote · SSE
                  </Button>
                </div>
              </div>
              </div>
            </div>

          </section>
        </div>

        {/* Connection */}
        <div className="mb-6">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {mcpType === 'local' ? 'Command' : 'Server URL'}
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            {mcpType === 'local' ? (
              <CommandTextarea value={command} onChange={setCommand} />
            ) : (
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                className="font-mono typography-meta"
              />
            )}
          </section>
        </div>

        {mcpType === 'remote' && (
          <div className="mb-6">
            <div className="mb-1 px-1">
              <h3 className="typography-ui-header font-medium text-foreground">Advanced Remote Options</h3>
            </div>

            <section className="px-2 pb-2 pt-0">
              <Collapsible
                open={isAdvancedRemoteOptionsOpen}
                onOpenChange={setIsAdvancedRemoteOptionsOpen}
              >
                <CollapsibleTrigger className="flex w-full items-center justify-between py-0.5 group">
                  <div className="flex items-center gap-1.5 text-left">
                    <span className="typography-ui-label font-normal text-foreground">Configure advanced options</span>
                    <span className="typography-micro text-muted-foreground">
                      ({oauthEnabled ? 'Auto-detect' : 'Custom'} · {headerEntries.length} headers{timeout ? ` · ${timeout}ms` : ''})
                    </span>
                  </div>
                  {isAdvancedRemoteOptionsOpen ? (
                    <RiArrowDownSLine className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  ) : (
                    <RiArrowRightSLine className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  )}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-8">
                        <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                          <span className="typography-ui-label text-foreground">Timeout (ms)</span>
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
                      <p className="typography-micro text-muted-foreground sm:pl-64">
                        Leave blank to use OpenCode&apos;s default MCP timeout.
                      </p>
                    </div>

                    <div>
                      <div className="mb-2 typography-ui-label text-foreground">
                        Request Headers
                        {headerEntries.length > 0 && (
                          <span className="ml-1.5 typography-micro text-muted-foreground font-normal">({headerEntries.length})</span>
                        )}
                      </div>
                      <EnvEditor
                        value={headerEntries}
                        onChange={setHeaderEntries}
                        keyTransform={(value) => value.trimStart()}
                        keyPlaceholder="Header-Name"
                        keyInputClassName="w-36 shrink-0 font-mono typography-meta"
                        pasteLabel="Paste headers"
                        pasteTitle="Paste KEY=VALUE header lines from clipboard"
                      />
                    </div>

                    <div className="space-y-3">
                      <div
                        className="group flex cursor-pointer items-center gap-2 py-1.5"
                        role="button"
                        tabIndex={0}
                        aria-pressed={oauthEnabled}
                        onClick={() => setOauthEnabled(!oauthEnabled)}
                        onKeyDown={(event) => {
                          if (event.key === ' ' || event.key === 'Enter') {
                            event.preventDefault();
                            setOauthEnabled(!oauthEnabled);
                          }
                        }}
                      >
                        <Checkbox checked={oauthEnabled} onChange={setOauthEnabled} ariaLabel="Enable OAuth auto-detection" />
                        <span className="typography-ui-label text-foreground">Enable OAuth auto-detection</span>
                      </div>

                      <div className="grid gap-3 sm:grid-cols-2">
                        <Input
                          value={oauthClientId}
                          onChange={(e) => setOauthClientId(e.target.value)}
                          placeholder="OAuth client ID"
                          className="font-mono typography-meta"
                          disabled={!oauthEnabled}
                          data-bwignore="true"
                          data-1p-ignore="true"
                        />
                        <Input
                          value={oauthClientSecret}
                          onChange={(e) => setOauthClientSecret(e.target.value)}
                          placeholder="OAuth client secret"
                          className="font-mono typography-meta"
                          disabled={!oauthEnabled}
                          data-bwignore="true"
                          data-1p-ignore="true"
                        />
                        <Input
                          value={oauthScope}
                          onChange={(e) => setOauthScope(e.target.value)}
                          placeholder="Scopes (space-delimited)"
                          className="font-mono typography-meta"
                          disabled={!oauthEnabled}
                          data-bwignore="true"
                          data-1p-ignore="true"
                        />
                        <Input
                          value={oauthRedirectUri}
                          onChange={(e) => setOauthRedirectUri(e.target.value)}
                          placeholder="Redirect URI"
                          className="font-mono typography-meta"
                          disabled={!oauthEnabled}
                          data-bwignore="true"
                          data-1p-ignore="true"
                        />
                      </div>

                      <p className="typography-micro text-muted-foreground">
                        Leave these fields blank to let OpenCode infer OAuth settings from the MCP server.
                      </p>
                      {suggestedRedirectUri && (
                        <p className="typography-micro text-muted-foreground">
                          Browser-based MCP authorization uses this callback URL when the redirect URI is blank:
                          <span className="mt-1 block break-all font-mono text-foreground/80">{suggestedRedirectUri}</span>
                        </p>
                      )}
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </section>
          </div>
        )}

        {/* Environment Variables */}
        <div className="mb-2">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              Environment Variables
              {envEntries.length > 0 && (
                <span className="ml-1.5 typography-micro text-muted-foreground font-normal">
                  ({envEntries.length})
                </span>
              )}
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            {envEntries.length === 0 ? (
              <Button
                variant="outline"
                size="xs"
                className="!font-normal gap-1.5"
                onClick={() => setEnvEntries([{ key: '', value: '' }])}
              >
                <RiAddLine className="h-3.5 w-3.5" />
                Add environment variable
              </Button>
            ) : (
              <EnvEditor value={envEntries} onChange={setEnvEntries} />
            )}
          </section>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 px-2 py-1">
          <Button
            onClick={handleSave}
            disabled={isSaving || (!isDirty && !isNewServer)}
            size="xs"
            className="!font-normal"
          >
            {isSaving ? 'Saving...' : isNewServer ? 'Create' : 'Save Changes'}
          </Button>
          {!isNewServer && (
            <Button
              variant="destructive"
              size="xs"
              className="!font-normal"
              onClick={() => setShowDeleteConfirm(true)}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

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
        <DialogContent className="max-w-md" keyboardAvoid>
          <DialogHeader>
            <DialogTitle>Import JSON Snippet</DialogTitle>
            <DialogDescription>
              Paste a full MCP JSON snippet from docs or another config file. The parsed values will populate this form for review before saving.
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
              className="font-mono typography-meta resize-y"
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
                <RiClipboardLine className="h-3.5 w-3.5" />
                Paste JSON from Clipboard
              </Button>
            </div>

            <p className="typography-micro text-muted-foreground">
              Accepts full MCP JSON snippets like <code className="font-mono text-foreground/80">&#123; "mcpServers": &#123; "name": &#123;...&#125; &#125; &#125;</code>,{' '}
              <code className="font-mono text-foreground/80">&#123; "name": &#123;...&#125; &#125;</code>, or bare{' '}
              <code className="font-mono text-foreground/80">&#123; "command": ..., "args": ... &#125;</code>
            </p>
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
              Cancel
            </Button>
            <Button
              onClick={handleImportJson}
              disabled={!importJsonText.trim()}
              size="sm"
            >
              Import
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
            <DialogTitle>Delete "{selectedMcpName}"?</DialogTitle>
            <DialogDescription>
              This removes the server from <code className="text-foreground">opencode.json</code>.
              OpenCode will need to reload.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
              className="text-foreground"
            >
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollableOverlay>
  );
};
