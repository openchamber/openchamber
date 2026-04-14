import React from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import {
  useMcpConfigStore,
  envRecordToArray,
  type McpDraft,
  type McpScope,
} from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import {
  RiAddLine,
  RiClipboardLine,
  RiDeleteBinLine,
  RiEyeLine,
  RiEyeOffLine,
  RiFolderLine,
  RiPlugLine,
  RiUser3Line,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
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
import { m } from '@/lib/i18n/messages';

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
      toast.error(m.mcpToastClipboardFailed());
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-end gap-2">
        <Button
          variant="ghost"
          size="xs"
          className="!font-normal gap-1 text-muted-foreground"
          onClick={handlePasteFromClipboard}
          type="button"
          title={m.mcpPasteCommandTitle()}
        >
          <RiClipboardLine className="h-3 w-3" />
          {m.mcpPasteCommand()}
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
}

const EnvEditor: React.FC<EnvEditorProps> = ({ value, onChange }) => {
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
        toast.error(m.mcpToastNoEnvPairs());
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
      toast.error(m.mcpToastClipboardFailed());
    }
  };

  const hasSensitiveValues = value.some((e) => e.value.length > 0);

  return (
    <div className="space-y-2">
      {/* Header row */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="typography-micro text-muted-foreground w-32 shrink-0">{m.mcpKey()}</span>
          <span className="typography-micro text-muted-foreground">{m.mcpValue()}</span>
        </div>
        <Button
          variant="ghost"
          size="xs"
          className="!font-normal gap-1 text-muted-foreground"
          onClick={handlePasteDotEnv}
          type="button"
          title={m.mcpPasteEnvTitle()}
        >
          <RiClipboardLine className="h-3 w-3" />
          {m.mcpPasteEnv()}
        </Button>
      </div>

      {/* Rows */}
      <div className="space-y-1.5">
        {value.map((entry, idx) => (
          <div key={idx} className="flex items-center gap-2">
            {/* KEY — fixed narrow width */}
            <Input
              value={entry.key}
              onChange={(e) => updateRow(idx, 'key', e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
              placeholder={m.mcpKeyPlaceholder()}
              className="w-36 shrink-0 font-mono typography-meta uppercase"
              spellCheck={false}
            />
            {/* VALUE — takes remaining space */}
            <div className="relative flex-1 flex items-center">
              <Input
                type={revealedKeys.has(idx) ? 'text' : 'password'}
                value={entry.value}
                onChange={(e) => updateRow(idx, 'value', e.target.value)}
                placeholder={m.mcpValuePlaceholder()}
                className="font-mono typography-meta pr-8 w-full"
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
        {m.mcpAddVariable()}
      </Button>

      {hasSensitiveValues && (
        <p className="typography-micro text-muted-foreground/60">
          {m.mcpValuesPlaintext()}
        </p>
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────
// Status badge
// ─────────────────────────────────────────────────────────────
const StatusBadge: React.FC<{ status: string | undefined; enabled: boolean }> = ({ status, enabled }) => {
  if (!enabled) return null;
  if (!status) return null;

  const STATUS_LABEL: Record<string, string> = {
    connected: m.mcpConnected(),
    failed: m.mcpFailed(),
    needs_auth: m.mcpNeedsAuth(),
    needs_client_registration: m.mcpNeedsRegistration(),
  };

  const colorMap: Record<string, string> = {
    connected: 'text-[var(--status-success)]',
    failed: 'text-[var(--status-error)]',
    needs_auth: 'text-[var(--status-warning)]',
    needs_client_registration: 'text-[var(--status-warning)]',
  };

  return (
    <span className={cn('typography-micro font-medium', colorMap[status] ?? 'text-muted-foreground')}>
      ● {STATUS_LABEL[status] ?? status}
    </span>
  );
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
  const mcpStatus = useMcpStore((state) => state.getStatusForDirectory(currentDirectory ?? null));
  const refreshStatus = useMcpStore((state) => state.refresh);
  const connectMcp = useMcpStore((state) => state.connect);
  const disconnectMcp = useMcpStore((state) => state.disconnect);

  const selectedServer = selectedMcpName ? getMcpByName(selectedMcpName) : null;
  const isNewServer = Boolean(mcpDraft && mcpDraft.name === selectedMcpName && !selectedServer);

  // ── form state ──
  const [draftName, setDraftName] = React.useState('');
  const [draftScope, setDraftScope] = React.useState<McpScope>('user');
  const [mcpType, setMcpType] = React.useState<'local' | 'remote'>('local');
  const [command, setCommand] = React.useState<string[]>([]);
  const [url, setUrl] = React.useState('');
  const [envEntries, setEnvEntries] = React.useState<Array<{ key: string; value: string }>>([]);
  const [enabled, setEnabled] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = React.useState(false);
  const [isDeleting, setIsDeleting] = React.useState(false);
  const [isConnecting, setIsConnecting] = React.useState(false);

  const initialRef = React.useRef<{
    mcpType: 'local' | 'remote'; command: string[]; url: string;
    envEntries: Array<{ key: string; value: string }>; enabled: boolean;
  } | null>(null);

  // Populate form when selection changes
  React.useEffect(() => {
    if (isNewServer && mcpDraft) {
      setDraftName(mcpDraft.name);
      setDraftScope(mcpDraft.scope || 'user');
      setMcpType(mcpDraft.type);
      setCommand(mcpDraft.command);
      setUrl(mcpDraft.url);
      setEnvEntries(mcpDraft.environment);
      setEnabled(mcpDraft.enabled);
      initialRef.current = {
        mcpType: mcpDraft.type, command: mcpDraft.command,
        url: mcpDraft.url, envEntries: mcpDraft.environment, enabled: mcpDraft.enabled,
      };
      return;
    }
    if (selectedServer) {
      setDraftScope(selectedServer.scope === 'project' ? 'project' : 'user');
      const envArr = envRecordToArray(selectedServer.environment);
      const t = selectedServer.type;
      const cmd = t === 'local' ? ((selectedServer as { command?: string[] }).command ?? []) : [];
      const u = t === 'remote' ? ((selectedServer as { url?: string }).url ?? '') : '';
      setMcpType(t); setCommand(cmd); setUrl(u); setEnvEntries(envArr); setEnabled(selectedServer.enabled);
      initialRef.current = { mcpType: t, command: cmd, url: u, envEntries: envArr, enabled: selectedServer.enabled };
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
      JSON.stringify(envEntries) !== JSON.stringify(init.envEntries)
    );
  }, [mcpType, command, url, envEntries, enabled]);

  const handleSave = async () => {
    const name = isNewServer ? draftName.trim() : selectedMcpName ?? '';
    if (!name) { toast.error(m.mcpToastNameRequired()); return; }
    if (isNewServer && mcpServers.some((s) => s.name === name)) {
      toast.error(m.mcpToastDuplicateName()); return;
    }
    if (mcpType === 'local' && command.filter(Boolean).length === 0) {
      toast.error(m.mcpToastCommandEmpty()); return;
    }
    if (mcpType === 'remote' && !url.trim()) {
      toast.error(m.mcpToastUrlEmpty()); return;
    }

    const draft: McpDraft = { name, scope: draftScope, type: mcpType, command, url, environment: envEntries, enabled };
    setIsSaving(true);
    try {
      const success = isNewServer ? await createMcp(draft) : await updateMcp(name, draft);
      if (success) {
        if (isNewServer) { setMcpDraft(null); setSelectedMcp(name); }
        toast.success(isNewServer ? m.mcpToastCreated() : m.mcpToastSaved());
      } else {
        toast.error(m.mcpToastSaveFailed());
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
    const ok = await deleteMcp(selectedMcpName);
    if (ok) { toast.success(`"${selectedMcpName}" deleted`); setShowDeleteConfirm(false); }
    else toast.error(m.mcpToastDeleteFailed());
    setIsDeleting(false);
  };

  const handleToggleConnect = async () => {
    if (!selectedMcpName) return;
    setIsConnecting(true);
    try {
      const isConnected = mcpStatus[selectedMcpName]?.status === 'connected';
      if (isConnected) {
        await disconnectMcp(selectedMcpName, currentDirectory);
        toast.success(m.mcpToastDisconnected());
      } else {
        await connectMcp(selectedMcpName, currentDirectory);
        toast.success(m.mcpToastConnected());
      }
      await refreshStatus({ directory: currentDirectory, silent: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setIsConnecting(false);
    }
  };

  // ── Empty state ──
  if (!selectedMcpName) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <RiPlugLine className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{m.mcpSelectFromSidebar()}</p>
          <p className="typography-meta mt-1 opacity-75">{m.mcpOrCreateNew()}</p>
        </div>
      </div>
    );
  }

  const runtimeStatus = mcpStatus[selectedMcpName];
  const isConnected = runtimeStatus?.status === 'connected';

  return (
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4">
          <div className="min-w-0">
            {isNewServer ? (
              <h2 className="typography-ui-header font-semibold text-foreground truncate">{m.mcpNewServer()}</h2>
            ) : (
              <div className="flex items-center gap-2 min-w-0">
                <h2 className="typography-ui-header font-semibold text-foreground truncate">{selectedMcpName}</h2>
                <StatusBadge status={runtimeStatus?.status} enabled={enabled} />
              </div>
            )}
            <div className="flex items-center gap-2 mt-0.5">
              <p className="typography-meta text-muted-foreground truncate">
                {isNewServer ? m.mcpNewServerDesc() : `${mcpType === 'local' ? m.mcpLocalStdio() : m.mcpRemoteSse()} transport`}
              </p>
              {!isNewServer && (
                <Button
                  variant={isConnected ? 'outline' : 'default'}
                  size="xs"
                  className="!font-normal"
                  onClick={handleToggleConnect}
                  disabled={isConnecting || !enabled}
                >
                  {isConnecting ? m.mcpWorking() : isConnected ? m.mcpDisconnect() : m.mcpConnect()}
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Server Identity */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">{m.mcpServer()}</h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0">

            {isNewServer && (
              <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
                <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                  <span className="typography-ui-label text-foreground">{m.mcpServerName()}</span>
                </div>
                <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                  <Input
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
                    placeholder={m.mcpNamePlaceholder()}
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
                          <span>{m.mcpUser()}</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="project">
                        <div className="flex items-center gap-2">
                          <RiFolderLine className="h-3.5 w-3.5" />
                          <span>{m.mcpProject()}</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
              <span className="typography-ui-label text-foreground">{m.mcpEnableServer()}</span>
            </div>

            <div className="pb-1.5 pt-0.5">
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="typography-ui-label text-foreground">{m.mcpTransportMode()}</span>
                <div className="flex flex-wrap items-center gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setMcpType('local')}
                    className={cn(
                      '!font-normal',
                      mcpType === 'local'
                        ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                        : 'text-foreground'
                    )}
                  >
                    {m.mcpLocalStdio()}
                  </Button>
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => setMcpType('remote')}
                    className={cn(
                      '!font-normal',
                      mcpType === 'remote'
                        ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10 hover:text-[var(--primary-base)]'
                        : 'text-foreground'
                    )}
                  >
                    {m.mcpRemoteSse()}
                  </Button>
                </div>
              </div>
            </div>

          </section>
        </div>

        {/* Connection */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {mcpType === 'local' ? m.mcpCommand() : m.mcpServerUrl()}
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            {mcpType === 'local' ? (
              <CommandTextarea value={command} onChange={setCommand} />
            ) : (
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={m.mcpUrlPlaceholder()}
                className="font-mono typography-meta"
              />
            )}
          </section>
        </div>

        {/* Environment Variables */}
        <div className="mb-2">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {m.mcpEnvVariables()}
              {envEntries.length > 0 && (
                <span className="ml-1.5 typography-micro text-muted-foreground font-normal">
                  ({envEntries.length})
                </span>
              )}
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            <EnvEditor value={envEntries} onChange={setEnvEntries} />
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
            {isSaving ? m.mcpSaving() : isNewServer ? m.mcpCreate() : m.mcpSaveChanges()}
          </Button>
          {!isNewServer && (
            <Button
              variant="ghost"
              size="xs"
              className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
              onClick={() => setShowDeleteConfirm(true)}
            >
              {m.mcpDelete()}
            </Button>
          )}
        </div>
      </div>

      {/* Delete confirm */}
      <Dialog
        open={showDeleteConfirm}
        onOpenChange={(open) => { if (!open && !isDeleting) setShowDeleteConfirm(false); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{m.mcpDeleteTitle().replace('{name}', selectedMcpName)}</DialogTitle>
            <DialogDescription>
              {m.mcpDeleteDesc()}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
              className="text-foreground hover:bg-interactive-hover hover:text-foreground"
            >
              {m.mcpCancel()}
            </Button>
            <Button size="sm" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? m.mcpDeleting() : m.mcpDelete()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollableOverlay>
  );
};
