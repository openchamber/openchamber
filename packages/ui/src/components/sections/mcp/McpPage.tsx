import React from 'react';
import { Button } from '@/components/ui/button';
import { ButtonLarge } from '@/components/ui/button-large';
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
  RiSaveLine,
  RiUser3Line,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ButtonSmall } from '@/components/ui/button-small';
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
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="typography-micro text-muted-foreground">
          One argument per line. Blank lines are ignored.
        </p>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1 px-2 typography-micro text-muted-foreground"
          onClick={handlePasteFromClipboard}
          type="button"
          title="Paste full command from clipboard and auto-split"
        >
          <RiClipboardLine className="h-3 w-3" />
          Paste command
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
          size="sm"
          className="h-6 gap-1 px-2 typography-micro text-muted-foreground"
          onClick={handlePasteDotEnv}
          type="button"
          title="Paste KEY=VALUE lines from clipboard"
        >
          <RiClipboardLine className="h-3 w-3" />
          Paste .env
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
              placeholder="API_KEY"
              className="w-36 shrink-0 font-mono typography-meta uppercase"
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
            <Button
              size="icon"
              variant="ghost"
              className="h-8 w-7 shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() => removeRow(idx)}
            >
              <RiDeleteBinLine className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <Button
        variant="outline"
        size="sm"
        className="gap-1.5 h-7 typography-meta"
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

const StatusBadge: React.FC<{ status: string | undefined; enabled: boolean }> = ({ status, enabled }) => {
  if (!enabled) {
    return <span className="typography-micro text-muted-foreground/50">Disabled</span>;
  }
  if (!status) return null;

  const colorMap: Record<string, string> = {
    connected: 'text-green-600 dark:text-green-400',
    failed: 'text-destructive',
    needs_auth: 'text-yellow-600 dark:text-yellow-400',
    needs_client_registration: 'text-yellow-600 dark:text-yellow-400',
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

    const draft: McpDraft = { name, scope: draftScope, type: mcpType, command, url, environment: envEntries, enabled };
    setIsSaving(true);
    try {
      const success = isNewServer ? await createMcp(draft) : await updateMcp(name, draft);
      if (success) {
        if (isNewServer) { setMcpDraft(null); setSelectedMcp(name); }
        toast.success(isNewServer ? 'MCP server created. OpenCode reloading…' : 'Saved. OpenCode reloading…');
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
    const ok = await deleteMcp(selectedMcpName);
    if (ok) { toast.success(`"${selectedMcpName}" deleted`); setShowDeleteConfirm(false); }
    else toast.error('Failed to delete');
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
        toast.success('Connected');
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
          <p className="typography-body">Select an MCP server from the sidebar</p>
          <p className="typography-meta mt-1 opacity-75">or add a new one</p>
        </div>
      </div>
    );
  }

  const runtimeStatus = mcpStatus[selectedMcpName];
  const isConnected = runtimeStatus?.status === 'connected';

  return (
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full">
      <div className="mx-auto max-w-2xl space-y-5 p-6">

        {/* ── Header card: name + status + enabled + connect ── */}
        <div className="rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-4 py-3 space-y-3">

          {/* Row 1: name + connect button */}
          <div className="flex items-center justify-between gap-3 min-w-0">
            <div className="min-w-0">
              {isNewServer ? (
                <Input
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '-'))}
                  placeholder="my-mcp-server"
                  className="font-mono text-base h-8 w-64"
                  autoFocus
                />
              ) : (
                <h1 className="typography-ui-header font-semibold truncate">{selectedMcpName}</h1>
              )}
              {isNewServer && (
                <p className="typography-micro text-muted-foreground mt-0.5">
                  Lowercase, numbers, hyphens and underscores only
                </p>
              )}
            </div>

            {isNewServer && (
              <Select value={draftScope} onValueChange={(value) => setDraftScope(value as McpScope)}>
                <SelectTrigger className="!h-8 w-auto gap-1.5">
                  {draftScope === 'user' ? (
                    <RiUser3Line className="h-4 w-4" />
                  ) : (
                    <RiFolderLine className="h-4 w-4" />
                  )}
                  <span className="capitalize">{draftScope}</span>
                </SelectTrigger>
                <SelectContent align="end">
                  <SelectItem value="user" className="pr-2 [&>span:first-child]:hidden">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <RiUser3Line className="h-4 w-4" />
                        <span>User</span>
                      </div>
                      <span className="typography-micro text-muted-foreground ml-6">Available in all projects</span>
                    </div>
                  </SelectItem>
                  <SelectItem value="project" className="pr-2 [&>span:first-child]:hidden">
                    <div className="flex flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <RiFolderLine className="h-4 w-4" />
                        <span>Project</span>
                      </div>
                      <span className="typography-micro text-muted-foreground ml-6">Only in current project</span>
                    </div>
                  </SelectItem>
                </SelectContent>
              </Select>
            )}

            {!isNewServer && (
              <Button
                size="sm"
                variant={isConnected ? 'outline' : 'default'}
                onClick={handleToggleConnect}
                disabled={isConnecting || !enabled}
                className="h-7 shrink-0"
              >
                {isConnecting ? 'Working…' : isConnected ? 'Disconnect' : 'Connect'}
              </Button>
            )}
          </div>

          {/* Row 2: status + type badge + enabled toggle */}
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <StatusBadge status={runtimeStatus?.status} enabled={enabled} />
              <span className="typography-micro text-muted-foreground/40">·</span>
              <span className="typography-micro text-muted-foreground bg-muted px-1.5 py-0.5 rounded border border-border/50">
                {mcpType === 'local' ? 'stdio' : 'remote'}
              </span>
            </div>

            {/* Enabled toggle */}
            <div className="flex items-center gap-2">
              <span className={cn('typography-micro', enabled ? 'text-foreground' : 'text-muted-foreground/60')}>
                {enabled ? 'Enabled' : 'Disabled'}
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled(!enabled)}
                className={cn(
                  'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                  enabled ? 'bg-primary' : 'bg-muted',
                )}
              >
                <span className={cn(
                  'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
                  enabled ? 'translate-x-4' : 'translate-x-0',
                )} />
              </button>
            </div>
          </div>

          {/* Row 3: type selector — always visible so user can switch type */}
          <div className="flex gap-1 pt-1 border-t border-[var(--interactive-border)]">
              <ButtonSmall
                variant={mcpType === 'local' ? 'default' : 'outline'}
                onClick={() => setMcpType('local')}
                className={cn(mcpType !== 'local' && 'text-foreground')}
              >
                Local · stdio
              </ButtonSmall>
              <ButtonSmall
                variant={mcpType === 'remote' ? 'default' : 'outline'}
                onClick={() => setMcpType('remote')}
                className={cn(mcpType !== 'remote' && 'text-foreground')}
              >
                Remote · SSE
              </ButtonSmall>
            </div>
        </div>

        {/* ── Connection ── */}
        <div className="space-y-2">
          {mcpType === 'local' ? (
            <>
              <label className="typography-ui-label font-medium text-foreground">
                Command
              </label>
              <CommandTextarea value={command} onChange={setCommand} />
            </>
          ) : (
            <>
              <label className="typography-ui-label font-medium text-foreground">
                Server URL
              </label>
              <Input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                className="font-mono typography-meta"
              />
              <p className="typography-micro text-muted-foreground">
                SSE endpoint URL of the remote MCP server
              </p>
            </>
          )}
        </div>

        {/* ── Environment Variables ── */}
        <div className="space-y-2">
          <div className="flex items-baseline justify-between">
            <label className="typography-ui-label font-medium text-foreground">
              Environment Variables
              {envEntries.length > 0 && (
                <span className="ml-1.5 typography-micro text-muted-foreground font-normal">
                  ({envEntries.length})
                </span>
              )}
            </label>
          </div>
          <EnvEditor value={envEntries} onChange={setEnvEntries} />
        </div>

        {/* ── Actions ── */}
        <div className="flex items-center justify-between border-t border-[var(--interactive-border)] pt-4 gap-4">
          {!isNewServer ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setShowDeleteConfirm(true)}
              className="h-7 gap-1.5 typography-meta text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <RiDeleteBinLine className="h-3.5 w-3.5" />
              Delete
            </Button>
          ) : <div />}

          <Button
            size="sm"
            onClick={handleSave}
            disabled={isSaving || (!isDirty && !isNewServer)}
            className="h-7 gap-1.5 typography-meta"
          >
            <RiSaveLine className="h-3.5 w-3.5" />
            {isSaving ? 'Saving…' : isNewServer ? 'Create' : 'Save changes'}
          </Button>
        </div>
      </div>

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
              variant="ghost"
              onClick={() => setShowDeleteConfirm(false)}
              disabled={isDeleting}
              className="text-foreground hover:bg-interactive-hover hover:text-foreground"
            >
              Cancel
            </Button>
            <ButtonLarge onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? 'Deleting…' : 'Delete'}
            </ButtonLarge>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ScrollableOverlay>
  );
};
