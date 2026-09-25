import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import {
  selectMcpServersForDirectory,
  useMcpConfigStore,
  envRecordToArray,
  MCP_PROTOCOLS,
  MCP_CODEMODE_CHOICES,
  codemodeChoiceOf,
  type McpCodemodeChoice,
  type McpDraft,
  type McpProtocol,
  type McpScope,
} from '@/stores/useMcpConfigStore';
import { useShallow } from 'zustand/react/shallow';
import {
  parseImportedMcpSnippet,
  applyImportedMcpToDraft,
} from './mcpImport';
import { useMcpStore } from '@/stores/useMcpStore';
import { McpOAuthSignIn } from './McpOAuthSignIn';
import { MCP_DRAFT_OAUTH_UNSET, readCarriedOAuth, type McpOAuthCarried } from './mcpDraft';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { cn } from '@/lib/utils';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsLegacyFormatNote } from '@/components/sections/shared/SettingsLegacyFormatNote';
import {
  useAutosave,
  AUTOSAVE_SAVED,
  AUTOSAVE_UNCHANGED,
  autosaveFailed,
  type AutosaveResult,
} from '@/components/sections/shared/SettingsAutosave';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsGroupTitle,
  SETTINGS_SELECT_SIZE,
  SETTINGS_FIELD_LABEL_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
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
import type { McpServerStatus } from '@/lib/opencode/model';

/** A stored millisecond value as the form shows it; empty means "not set". */
const msField = (value: number | undefined): string =>
  value === undefined ? '' : String(value);

/**
 * A timeout field as the collapsed summary shows it: whole seconds read better
 * than four digits of milliseconds, anything else stays exact.
 */
const formatDuration = (value: string): string | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const ms = Number(trimmed);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return ms % 1000 === 0 ? `${ms / 1000}s` : `${ms}ms`;
};

/** Message keys for the protocol options; the raw values are config spellings. */
const MCP_PROTOCOL_LABEL_KEYS = {
  legacy: 'settings.mcp.page.advanced.protocolOption.legacy',
  auto: 'settings.mcp.page.advanced.protocolOption.auto',
  '2026-07-28': 'settings.mcp.page.advanced.protocolOption.revision20260728',
} as const satisfies Record<McpProtocol, string>;

/** Message keys for the Code Mode choices. */
const MCP_CODEMODE_LABEL_KEYS = {
  default: 'settings.mcp.page.advanced.codemodeOption.default',
  on: 'settings.mcp.page.advanced.codemodeOption.on',
  off: 'settings.mcp.page.advanced.codemodeOption.off',
} as const satisfies Record<McpCodemodeChoice, string>;

/**
 * The authorization-server metadata document has to be fetchable, so anything
 * that is not an absolute http(s) address is rejected before it is saved.
 */
const isAbsoluteHttpUrl = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
};

/** A v2 MCP server reports its state as a nested discriminated union. */
const readMcpStatusName = (server: McpServerStatus | undefined): string | undefined => server?.status.status;

const readMcpStatusError = (server: McpServerStatus | undefined): string | undefined =>
  server?.status.status === 'failed' || server?.status.status === 'needs_auth' ? server.status.error : undefined;

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
  /**
   * Called for edits that have no field to leave — removing a row, importing a
   * clipboard block — so the page can write them straight away.
   */
  onCommit?: () => void;
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
  onCommit,
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
    onCommit?.();
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
      onCommit?.();
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
      return error?.trim() || t('settings.mcp.page.status.description.needsAuth');
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
      return 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)]';
    default:
      return 'border-[var(--interactive-border)] bg-[var(--surface-elevated)]';
  }
};

// Only error/warning states get the full card; a healthy server needs no
// explanation beyond the badge next to its name.
const shouldShowFullStatusCard = (status: string | undefined): boolean =>
  status === 'failed' || status === 'needs_auth';

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
  const mcpStatus = useMcpStore((state) => state.getStatusForDirectory(currentDirectory));
  const mcpDiagnostics = useMcpStore((state) => state.getDiagnosticForDirectory(currentDirectory));
  const refreshStatus = useMcpStore((state) => state.refresh);
  const connectMcp = useMcpStore((state) => state.connect);
  const disconnectMcp = useMcpStore((state) => state.disconnect);
  const testConnectionMcp = useMcpStore((state) => state.testConnection);

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
  const [timeoutStartup, setTimeoutStartup] = React.useState('');
  const [timeoutCatalog, setTimeoutCatalog] = React.useState('');
  const [timeoutExecution, setTimeoutExecution] = React.useState('');
  const [codemode, setCodemode] = React.useState<McpCodemodeChoice>('default');
  const [protocol, setProtocol] = React.useState<McpProtocol>('legacy');
  const [oauthAuthServerMetadataUrl, setOauthAuthServerMetadataUrl] = React.useState('');
  const [carriedOAuth, setCarriedOAuth] = React.useState<McpOAuthCarried>(MCP_DRAFT_OAUTH_UNSET);
  const [enabled, setEnabled] = React.useState(true);
  const [isCreating, setIsCreating] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isConnecting, setIsConnecting] = React.useState(false);

  const [isTestingConnection, setIsTestingConnection] = React.useState(false);
  const [isAdvancedRemoteOptionsOpen, setIsAdvancedRemoteOptionsOpen] = React.useState(false);
  const [showImportDialog, setShowImportDialog] = React.useState(false);
  const [importJsonText, setImportJsonText] = React.useState('');
  const [importError, setImportError] = React.useState<string | null>(null);
  const runtimeActionKey = React.useMemo(
    () => buildMcpRuntimeActionKey(selectedMcpName, currentDirectory),
    [currentDirectory, selectedMcpName],
  );
  const runtimeActionKeyRef = React.useRef(runtimeActionKey);

  // What the server's config entry currently holds; a save writes only the
  // difference, and the form only follows the store when the server moved away
  // from it.
  const savedRef = React.useRef<{
    mcpType: 'local' | 'remote'; command: string[]; url: string;
    envEntries: Array<{ key: string; value: string }>;
    headerEntries: Array<{ key: string; value: string }>;
    timeoutStartup: string;
    timeoutCatalog: string;
    timeoutExecution: string;
    codemode: McpCodemodeChoice;
    protocol: McpProtocol;
    oauthAuthServerMetadataUrl: string;
    enabled: boolean;
  } | null>(null);

  const selectionKey = JSON.stringify([selectedMcpName, currentDirectory, isNewServer]);
  const selectionRef = React.useRef(selectionKey);
  selectionRef.current = selectionKey;
  const hydratedSelectionRef = React.useRef<string | null>(null);
  const currentForm = {
    mcpType, command, url, envEntries, headerEntries, timeoutStartup, timeoutCatalog,
    timeoutExecution, codemode, protocol,
    oauthAuthServerMetadataUrl: mcpType === 'remote' ? oauthAuthServerMetadataUrl : '', enabled,
  };
  const currentFormRef = React.useRef(currentForm);
  currentFormRef.current = currentForm;

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
      timeoutStartup,
      timeoutCatalog,
      timeoutExecution,
      codemode,
      disabled: !enabled,
      protocol,
      oauthAuthServerMetadataUrl,
    };

    const next = applyImportedMcpToDraft(outcome, partial, { isNewServer });

    setDraftName(next.name);
    // SAFETY: the importer only ever reports one of the two transports.
    setMcpType(next.type as 'local' | 'remote');
    setCommand(next.command ?? []);
    setUrl(next.url ?? '');
    setEnvEntries(next.environment ?? []);
    setHeaderEntries(next.headers ?? []);
    setTimeoutStartup(next.timeoutStartup ?? '');
    setTimeoutCatalog(next.timeoutCatalog ?? '');
    setTimeoutExecution(next.timeoutExecution ?? '');
    setCodemode(next.codemode ?? 'default');
    setEnabled(next.disabled !== true);
    setProtocol(next.protocol ?? 'legacy');
    setOauthAuthServerMetadataUrl(next.oauthAuthServerMetadataUrl ?? '');

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
    protocol,
    oauthAuthServerMetadataUrl,
    timeoutStartup,
    timeoutCatalog,
    timeoutExecution,
    codemode,
    enabled,
    isNewServer,
    t,
  ]);

  // Populate form when selection changes
  React.useEffect(() => {
    if (isNewServer && mcpDraft) {
      hydratedSelectionRef.current = null;
      setDraftName(mcpDraft.name);
      setDraftScope(mcpDraft.scope || 'user');
      setMcpType(mcpDraft.type);
      setCommand(mcpDraft.command);
      setUrl(mcpDraft.url);
      setEnvEntries(mcpDraft.environment);
      setHeaderEntries(mcpDraft.headers);
      setTimeoutStartup(mcpDraft.timeoutStartup);
      setTimeoutCatalog(mcpDraft.timeoutCatalog);
      setTimeoutExecution(mcpDraft.timeoutExecution);
      setCodemode(mcpDraft.codemode);
      setProtocol(mcpDraft.protocol);
      setOauthAuthServerMetadataUrl(mcpDraft.oauthAuthServerMetadataUrl);
      setCarriedOAuth({
        oauthEnabled: mcpDraft.oauthEnabled,
        oauthClientId: mcpDraft.oauthClientId,
        oauthClientSecret: mcpDraft.oauthClientSecret,
        oauthScope: mcpDraft.oauthScope,
        oauthRedirectUri: mcpDraft.oauthRedirectUri,
        oauthCallbackPort: mcpDraft.oauthCallbackPort,
      });
      setEnabled(!mcpDraft.disabled);
      setIsAdvancedRemoteOptionsOpen(false);
      savedRef.current = {
        mcpType: mcpDraft.type, command: mcpDraft.command,
        url: mcpDraft.url,
        envEntries: mcpDraft.environment,
        headerEntries: mcpDraft.headers,
        timeoutStartup: mcpDraft.timeoutStartup,
        timeoutCatalog: mcpDraft.timeoutCatalog,
        timeoutExecution: mcpDraft.timeoutExecution,
        codemode: mcpDraft.codemode,
        protocol: mcpDraft.protocol,
        oauthAuthServerMetadataUrl: mcpDraft.oauthAuthServerMetadataUrl,
        enabled: !mcpDraft.disabled,
      };
      return;
    }
    if (selectedServer) {
      setDraftScope(selectedServer.scope === 'project' ? 'project' : 'user');
      const envArr = envRecordToArray(selectedServer.environment);
      // SAFETY: `type` discriminates the union the MCP route answers with.
      const remoteServer = selectedServer.type === 'remote' ? selectedServer : null;
      const headersArr = envRecordToArray(remoteServer?.headers);
      const serverType = selectedServer.type;
      const cmd = serverType === 'local' ? (selectedServer.command ?? []) : [];
      const u = remoteServer?.url ?? '';
      const nextStartup = msField(selectedServer.timeout?.startup);
      const nextCatalog = msField(selectedServer.timeout?.catalog);
      const nextExecution = msField(selectedServer.timeout?.execution);
      const nextCodemode = codemodeChoiceOf(selectedServer.codemode);
      // An entry without the key is what OpenCode calls `legacy`.
      const nextProtocol = selectedServer.protocol ?? 'legacy';
      const nextCarriedOAuth = readCarriedOAuth(remoteServer?.oauth);
      const nextAuthServerMetadataUrl = remoteServer && remoteServer.oauth
        ? remoteServer.oauth.auth_server_metadata_url ?? ''
        : '';
      const nextEnabled = selectedServer.disabled !== true;
      setCarriedOAuth(nextCarriedOAuth);
      // Keep local edits when a completed write refreshes the same server.
      const dirty = savedRef.current !== null && JSON.stringify(savedRef.current) !== JSON.stringify(currentFormRef.current);
      if (hydratedSelectionRef.current === selectionKey && dirty) return;
      hydratedSelectionRef.current = selectionKey;

      setMcpType(serverType);
      setCommand(cmd);
      setUrl(u);
      setEnvEntries(envArr);
      setHeaderEntries(headersArr);
      setTimeoutStartup(nextStartup);
      setTimeoutCatalog(nextCatalog);
      setTimeoutExecution(nextExecution);
      setCodemode(nextCodemode);
      setProtocol(nextProtocol);
      setOauthAuthServerMetadataUrl(nextAuthServerMetadataUrl);
      setEnabled(nextEnabled);
      setIsAdvancedRemoteOptionsOpen(false);
      savedRef.current = {
        mcpType: serverType,
        command: cmd,
        url: u,
        envEntries: envArr,
        headerEntries: headersArr,
        timeoutStartup: nextStartup,
        timeoutCatalog: nextCatalog,
        timeoutExecution: nextExecution,
        codemode: nextCodemode,
        protocol: nextProtocol,
        oauthAuthServerMetadataUrl: nextAuthServerMetadataUrl,
        enabled: nextEnabled,
      };
    }
  }, [selectedServer, selectedMcpName, currentDirectory, isNewServer, mcpDraft, selectionKey]);

  /** Empty is fine — the field is optional; anything else must be fetchable. */
  const authServerMetadataUrlError = React.useMemo(() => {
    const trimmed = oauthAuthServerMetadataUrl.trim();
    if (!trimmed || isAbsoluteHttpUrl(trimmed)) return null;
    return t('settings.mcp.page.advanced.oauthMetadataUrlInvalid');
  }, [oauthAuthServerMetadataUrl, t]);

  const advancedSummary = React.useMemo(() => {
    const parts: string[] = [];
    if (mcpType === 'remote' && headerEntries.length > 0) {
      parts.push(`${headerEntries.length} ${t('settings.mcp.page.advanced.headers')}`);
    }
    const startup = mcpType === 'local' ? formatDuration(timeoutStartup) : null;
    if (startup) parts.push(t('settings.mcp.page.advanced.summary.startup', { value: startup }));
    const catalog = formatDuration(timeoutCatalog);
    if (catalog) parts.push(t('settings.mcp.page.advanced.summary.catalog', { value: catalog }));
    const execution = formatDuration(timeoutExecution);
    if (execution) parts.push(t('settings.mcp.page.advanced.summary.execution', { value: execution }));
    // `default` leaves the choice to OpenCode, so naming it here would be noise.
    if (codemode === 'on') parts.push(t('settings.mcp.page.advanced.summary.codemodeOn'));
    if (codemode === 'off') parts.push(t('settings.mcp.page.advanced.summary.codemodeOff'));
    // `legacy` is the default, so naming it here would be noise.
    if (protocol !== 'legacy') parts.push(t(MCP_PROTOCOL_LABEL_KEYS[protocol]));
    return parts.join(' · ');
  }, [codemode, headerEntries.length, mcpType, protocol, t, timeoutCatalog, timeoutExecution, timeoutStartup]);

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

  // The OAuth credentials the page cannot edit ride along untouched: the store
  // rebuilds the whole `oauth` block from the draft on every save.
  const buildDraft = (name: string): McpDraft => ({
    name,
    scope: draftScope,
    type: mcpType,
    command,
    url,
    environment: envEntries,
    headers: headerEntries,
    ...carriedOAuth,
    oauthAuthServerMetadataUrl: mcpType === 'remote' ? oauthAuthServerMetadataUrl : '',
    protocol,
    timeoutStartup,
    timeoutCatalog,
    timeoutExecution,
    codemode,
    disabled: !enabled,
  });

  // An existing server writes itself; a new one is only created once the user
  // confirms it, so an abandoned draft never reaches disk.
  const save = async (): Promise<AutosaveResult> => {
    const saved = savedRef.current;
    if (isNewServer || !saved || !selectedMcpName) return AUTOSAVE_UNCHANGED;
    if (JSON.stringify(saved) === JSON.stringify({
      mcpType, command, url, envEntries, headerEntries, timeoutStartup, timeoutCatalog,
      timeoutExecution, codemode, protocol,
      oauthAuthServerMetadataUrl: mcpType === 'remote' ? oauthAuthServerMetadataUrl : '', enabled,
    })) return AUTOSAVE_UNCHANGED;

    if (mcpType === 'local' && command.filter(Boolean).length === 0) {
      return autosaveFailed(t('settings.mcp.page.toast.localCommandRequired'));
    }
    if (mcpType === 'remote' && !url.trim()) {
      return autosaveFailed(t('settings.mcp.page.toast.remoteUrlRequired'));
    }
    if (mcpType === 'remote' && authServerMetadataUrlError) {
      return autosaveFailed(authServerMetadataUrlError);
    }

    const result = await updateMcp(selectedMcpName, buildDraft(selectedMcpName), currentDirectory);
    if (!result.ok) return autosaveFailed(t('settings.mcp.page.toast.saveFailed'));
    if (selectionRef.current !== selectionKey) return AUTOSAVE_SAVED;

    savedRef.current = {
      mcpType, command, url, envEntries, headerEntries,
      timeoutStartup, timeoutCatalog, timeoutExecution, codemode, protocol,
      oauthAuthServerMetadataUrl: mcpType === 'remote' ? oauthAuthServerMetadataUrl : '',
      enabled,
    };
    await refreshStatus({ directory: currentDirectory, silent: true });
    if (result.reloadFailed) {
      return autosaveFailed(result.warning || result.message || t('settings.mcp.page.toast.savedReloadFailed'));
    }
    return AUTOSAVE_SAVED;
  };

  const autosave = useAutosave(save);
  const { requestSave } = autosave;

  const handleCreate = async () => {
    const name = draftName.trim();
    if (!name) { toast.error(t('settings.mcp.page.toast.nameRequired')); return; }
    if (mcpServers.some((s) => s.name === name)) {
      toast.error(t('settings.mcp.page.toast.serverNameExists')); return;
    }
    if (mcpType === 'local' && command.filter(Boolean).length === 0) {
      toast.error(t('settings.mcp.page.toast.localCommandRequired')); return;
    }
    if (mcpType === 'remote' && !url.trim()) {
      toast.error(t('settings.mcp.page.toast.remoteUrlRequired')); return;
    }
    if (mcpType === 'remote' && authServerMetadataUrlError) {
      toast.error(authServerMetadataUrlError); return;
    }

    setIsCreating(true);
    try {
      const result = await createMcp(buildDraft(name), currentDirectory);
      if (result.ok) {
        setMcpDraft(null);
        setSelectedMcp(name);
        await refreshStatus({ directory: currentDirectory, silent: true });
        if (result.reloadFailed) {
          toast.warning(result.message || t('settings.mcp.page.toast.serverCreatedReloadFailed'), {
            description: result.warning || t('settings.mcp.page.toast.retryRefreshHint'),
          });
        } else {
          toast.success(result.message || t('settings.mcp.page.toast.serverCreatedReloading'));
        }
      } else {
        toast.error(t('settings.mcp.page.toast.saveFailed'));
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('settings.mcp.page.toast.unexpectedError'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleCancelCreate = () => {
    setMcpDraft(null);
    setSelectedMcp(null);
  };

  const handleDelete = async () => {
    if (!selectedMcpName) return;
    setIsDeleting(true);
    const result = await deleteMcp(selectedMcpName, currentDirectory);
    if (result.ok) {
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

  /**
   * OpenCode has stored the OAuth credential; the server itself is still in
   * `needs_auth` until it is connected again with that credential.
   */
  const handleOAuthConnected = async () => {
    if (!selectedMcpName) return;
    try {
      await connectMcp(selectedMcpName, currentDirectory);
      toast.success(t('settings.mcp.page.toast.connected'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('settings.mcp.page.toast.connectionTestFailed'));
    }
  };

  const handleToggleConnect = async () => {
    if (!selectedMcpName) return;
    setIsConnecting(true);
    try {
      const isConnected = readMcpStatusName(mcpStatus[selectedMcpName]) === 'connected';
      if (isConnected) {
        await disconnectMcp(selectedMcpName, currentDirectory);
        toast.success(t('settings.mcp.page.toast.disconnected'));
      } else {
        await connectMcp(selectedMcpName, currentDirectory);
        await refreshStatus({ directory: currentDirectory, silent: true });
        const nextStatus = useMcpStore.getState().getStatusForDirectory(currentDirectory)[selectedMcpName];
        const nextStatusName = readMcpStatusName(nextStatus);
        if (nextStatusName === 'connected') {
          toast.success(t('settings.mcp.page.toast.connected'));
        } else if (nextStatusName === 'needs_auth') {
          toast.message(t('settings.mcp.page.toast.connectionNeedsAuthorization'));
        } else if (nextStatusName === 'failed') {
          toast.error(readMcpStatusError(nextStatus) || t('settings.mcp.page.toast.connectionFailed'));
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
    return true;
  }, [isNewServer, t]);

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
  }, [runtimeActionKey]);

  const handleTestConnection = React.useCallback(async () => {
    if (!selectedMcpName || !requireSavedConfig()) return;
    if (!enabled) {
      toast.error(t('settings.mcp.page.toast.enableServerBeforeTest'));
      return;
    }

    setIsTestingConnection(true);
    try {
      const result = await testConnectionMcp(selectedMcpName, currentDirectory);
      const nextStatusName = readMcpStatusName(result.status);

      if (result.warning) {
        toast.warning(result.warning);
      } else if (nextStatusName === 'connected') {
        toast.success(t('settings.mcp.page.toast.connectionTestSucceeded'));
      } else if (nextStatusName === 'needs_auth') {
        toast.message(t('settings.mcp.page.toast.connectionNeedsAuthorization'));
      } else if (nextStatusName === 'failed') {
        toast.error(readMcpStatusError(result.status) || result.error || t('settings.mcp.page.toast.connectionTestFailed'));
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
  // The runtime's own report wins; the store's diagnostic is the fallback for a
  // server OpenCode never reported on.
  const effectiveStatusName = runtimeStatus ? readMcpStatusName(runtimeStatus) : runtimeDiagnostic?.status;
  const effectiveStatusError = runtimeStatus ? readMcpStatusError(runtimeStatus) : runtimeDiagnostic?.error;
  const isConnected = readMcpStatusName(runtimeStatus) === 'connected';

  const runtimeDescription = getStatusDescription(effectiveStatusName, tUnsafe, effectiveStatusError);
  const getStatusLabel = (status: string) => {
    switch (status) {
      case 'connected':
        return t('settings.mcp.page.status.label.connected');
      case 'failed':
        return t('settings.mcp.page.status.label.failed');
      case 'needs_auth':
        return t('settings.mcp.page.status.label.needsAuth');
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
            status={effectiveStatusName}
            enabled={enabled}
            getStatusLabel={getStatusLabel}
            variant="pill"
          />
        ) : undefined}
        description={isNewServer
          ? t('settings.mcp.page.header.configureNewServer')
          : t('settings.mcp.page.header.transport', { type: mcpType === 'local' ? t('settings.mcp.page.transport.local') : t('settings.mcp.page.transport.remote') })}
        headerEnd={!isNewServer ? (
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
      onBlurCapture={autosave.onBlurCapture}
    >



        {!isNewServer && selectedServer && (
          <SettingsLegacyFormatNote legacy={selectedServer.legacy === true} path={selectedServer.path} />
        )}

        {/* Runtime Status - Simplified for connected, expanded for errors */}
        {!isNewServer && shouldShowFullStatusCard(effectiveStatusName) && (
          <SettingsSection divider={false}>
            <div className={cn('rounded-lg border p-3', statusCardClass(effectiveStatusName))}>
              <div className="space-y-4">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.mcp.page.status.runtimeStatus')}</span>
                    <StatusBadge status={effectiveStatusName} enabled={enabled} getStatusLabel={getStatusLabel} />
                  </div>
                  <p className="typography-meta text-muted-foreground">{runtimeDescription}</p>
                  <p className="typography-micro text-muted-foreground/80">
                    {draftScope === 'project'
                      ? t('settings.mcp.page.status.projectScopedTo', { directory: currentDirectory ?? t('settings.mcp.page.status.activeProject') })
                      : t('settings.mcp.page.status.userScoped')}
                  </p>
                </div>

                {effectiveStatusName === 'needs_auth' && selectedMcpName && (
                  <McpOAuthSignIn
                    serverName={selectedMcpName}
                    directory={currentDirectory}
                    onConnected={handleOAuthConnected}
                  />
                )}

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

              </div>
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
              onChange={(next) => {
                setEnabled(next);
                requestSave();
              }}
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
              onSelect={(id) => {
                setMcpType(id as 'local' | 'remote');
                requestSave();
              }}
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
                    {/* What is actually set, so a collapsed section is never a
                        blank promise. Everything at its default says nothing. */}
                    {advancedSummary && (
                      <span className="typography-micro text-muted-foreground">
                        ({advancedSummary})
                      </span>
                    )}
                  </div>
                  {isAdvancedRemoteOptionsOpen ? (
                    <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  ) : (
                    <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                  )}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-2">
                  <div className="space-y-4">
                    <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:gap-8">
                      <div className="flex min-w-0 flex-row items-center gap-1 @xl:w-56 shrink-0">
                        <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.mcp.page.advanced.protocol')}</span>
                        <SettingsInfoHint>{t('settings.mcp.page.advanced.protocolHint')}</SettingsInfoHint>
                      </div>
                      <Select
                        value={protocol}
                        onValueChange={(value) => {
                          const next = MCP_PROTOCOLS.find((option) => option === value);
                          if (!next) return;
                          setProtocol(next);
                          requestSave();
                        }}
                      >
                        <SelectTrigger
                          size={SETTINGS_SELECT_SIZE}
                          className="!h-7 w-full max-w-[16rem] px-2"
                          aria-label={t('settings.mcp.page.advanced.protocol')}
                        >
                          <span className="truncate">{t(MCP_PROTOCOL_LABEL_KEYS[protocol])}</span>
                        </SelectTrigger>
                        <SelectContent>
                          {MCP_PROTOCOLS.map((option) => (
                            <SelectItem key={option} value={option}>
                              {t(MCP_PROTOCOL_LABEL_KEYS[option])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      {mcpType === 'local' && (
                        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:gap-8">
                          <div className="flex min-w-0 flex-row items-center gap-1 @xl:w-56 shrink-0">
                            <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.mcp.page.advanced.timeoutStartupMs')}</span>
                            <SettingsInfoHint>{t('settings.mcp.page.advanced.timeoutStartupHint')}</SettingsInfoHint>
                          </div>
                          <Input
                            type="number"
                            min="1"
                            step="1"
                            value={timeoutStartup}
                            onChange={(e) => setTimeoutStartup(e.target.value)}
                            placeholder="5000"
                            className="h-7 w-32 font-mono px-2"
                            data-bwignore="true"
                            data-1p-ignore="true"
                          />
                        </div>
                      )}

                      <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:gap-8">
                        <div className="flex min-w-0 flex-row items-center gap-1 @xl:w-56 shrink-0">
                          <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.mcp.page.advanced.timeoutCatalogMs')}</span>
                          <SettingsInfoHint>{t('settings.mcp.page.advanced.timeoutCatalogHint')}</SettingsInfoHint>
                        </div>
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          value={timeoutCatalog}
                          onChange={(e) => setTimeoutCatalog(e.target.value)}
                          placeholder="30000"
                          className="h-7 w-32 font-mono px-2"
                          data-bwignore="true"
                          data-1p-ignore="true"
                        />
                      </div>

                      <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:gap-8">
                        <div className="flex min-w-0 flex-row items-center gap-1 @xl:w-56 shrink-0">
                          <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.mcp.page.advanced.timeoutExecutionMs')}</span>
                          <SettingsInfoHint>{t('settings.mcp.page.advanced.timeoutExecutionHint')}</SettingsInfoHint>
                        </div>
                        <Input
                          type="number"
                          min="1"
                          step="1"
                          value={timeoutExecution}
                          onChange={(e) => setTimeoutExecution(e.target.value)}
                          placeholder="30000"
                          className="h-7 w-32 font-mono px-2"
                          data-bwignore="true"
                          data-1p-ignore="true"
                        />
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:gap-8">
                      <div className="flex min-w-0 flex-row items-center gap-1 @xl:w-56 shrink-0">
                        <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.mcp.page.advanced.codemode')}</span>
                        <SettingsInfoHint>
                          {t('settings.mcp.page.advanced.codemodeHint')}
                          {' '}
                          {t('settings.mcp.page.advanced.codemodeDefaultHint')}
                        </SettingsInfoHint>
                      </div>
                      <Select
                        value={codemode}
                        onValueChange={(value) => {
                          const next = MCP_CODEMODE_CHOICES.find((option) => option === value);
                          if (!next) return;
                          setCodemode(next);
                          requestSave();
                        }}
                      >
                        <SelectTrigger
                          size={SETTINGS_SELECT_SIZE}
                          className="!h-7 w-full max-w-[16rem] px-2"
                          aria-label={t('settings.mcp.page.advanced.codemode')}
                        >
                          <span className="truncate">{t(MCP_CODEMODE_LABEL_KEYS[codemode])}</span>
                        </SelectTrigger>
                        <SelectContent>
                          {MCP_CODEMODE_CHOICES.map((option) => (
                            <SelectItem key={option} value={option}>
                              {t(MCP_CODEMODE_LABEL_KEYS[option])}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {mcpType === 'remote' && (
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
                        onCommit={requestSave}
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
                    )}

                    {mcpType === 'remote' && (
                    <div>
                      <SettingsGroupTitle as="div" className="mb-2">
                        {t('settings.mcp.page.advanced.oauth')}
                      </SettingsGroupTitle>
                      <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:gap-8">
                        <div className="flex min-w-0 flex-row items-center gap-1 @xl:w-56 shrink-0">
                          <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.mcp.page.advanced.oauthMetadataUrl')}</span>
                          <SettingsInfoHint>{t('settings.mcp.page.advanced.oauthMetadataUrlHint')}</SettingsInfoHint>
                        </div>
                        <div className="min-w-0 flex-1 space-y-1">
                          <Input
                            type="url"
                            value={oauthAuthServerMetadataUrl}
                            onChange={(e) => setOauthAuthServerMetadataUrl(e.target.value)}
                            placeholder={t('settings.mcp.page.advanced.oauthMetadataUrlPlaceholder')}
                            aria-label={t('settings.mcp.page.advanced.oauthMetadataUrl')}
                            aria-invalid={authServerMetadataUrlError ? true : undefined}
                            className="h-7 w-full max-w-[24rem] font-mono typography-meta px-2"
                            data-bwignore="true"
                            data-1p-ignore="true"
                          />
                          {/* A validation error has to stay readable while the
                              field is being corrected, so it is not behind the hint. */}
                          {authServerMetadataUrlError && (
                            <p className="typography-micro text-[var(--status-error)]">{authServerMetadataUrlError}</p>
                          )}
                        </div>
                      </div>
                    </div>
                    )}

                  </div>
                </CollapsibleContent>
              </Collapsible>
        </SettingsSection>

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
                onCommit={requestSave}
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
          {isNewServer && (
            <>
              <Button
                onClick={() => void handleCreate()}
                disabled={isCreating || !draftName.trim()}
                size="xs"
                className="!font-normal"
              >
                {isCreating ? t('settings.common.actions.saving') : t('settings.common.actions.create')}
              </Button>
              <Button
                variant="ghost"
                onClick={handleCancelCreate}
                disabled={isCreating}
                size="xs"
                className="!font-normal"
              >
                {t('settings.common.actions.cancel')}
              </Button>
            </>
          )}
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
