import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionsStore, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

interface SessionPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export const SessionPickerDialog: React.FC<SessionPickerDialogProps> = ({
  open,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const tUnsafe = React.useCallback((key: string) => t(key as Parameters<typeof t>[0]), [t]);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const projects = useProjectsStore((state) => state.projects);

  const [searchQuery, setSearchQuery] = React.useState('');
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  const sessions = React.useMemo(() => {
    return activeSessions
      .filter((s) => !s.time?.archived)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0));
  }, [activeSessions]);

  const filtered = React.useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter((s) => {
      const title = (s.title ?? '').toLowerCase();
      return title.includes(q);
    });
  }, [sessions, searchQuery]);

  React.useEffect(() => {
    if (open) {
      setSearchQuery('');
      setSelectedIndex(0);
    }
  }, [open]);

  React.useEffect(() => {
    if (selectedIndex >= filtered.length) {
      setSelectedIndex(0);
    }
  }, [filtered.length, selectedIndex]);

  React.useEffect(() => {
    const el = itemRefs.current[selectedIndex];
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [selectedIndex]);

  const handleSelect = React.useCallback((sessionId: string) => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    const directory = resolveGlobalSessionDirectory(session);
    setCurrentSession(sessionId, directory);
    onOpenChange(false);
  }, [sessions, setCurrentSession, onOpenChange]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || (e.key === 'j' && e.ctrlKey)) {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp' || (e.key === 'k' && e.ctrlKey)) {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filtered[selectedIndex];
      if (selected) {
        handleSelect(selected.id);
      }
    }
  };

  const formatRelativeTime = (timestamp: number | undefined): string => {
    if (!timestamp) return '';
    const diff = Date.now() - timestamp;
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  };

  const getProjectLabel = (session: Session): string | null => {
    const directory = resolveGlobalSessionDirectory(session);
    if (!directory) return null;
    const project = projects.find((p) => {
      const pPath = p.path.replace(/\\/g, '/');
      return directory.replace(/\\/g, '/').startsWith(pPath);
    });
    if (project?.label) return project.label;
    if (project?.path) {
      const segments = project.path.split(/[\\/]/).filter(Boolean);
      return segments[segments.length - 1] ?? null;
    }
    const segments = directory.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? null;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 gap-0 max-w-[560px] max-h-[480px] overflow-hidden flex flex-col">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="text-base">
            {tUnsafe('sessions.picker.title') !== 'sessions.picker.title'
              ? tUnsafe('sessions.picker.title')
              : 'Switch Session'}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {tUnsafe('sessions.picker.description') !== 'sessions.picker.description'
              ? tUnsafe('sessions.picker.description')
              : 'Search and select a session to switch to'}
          </DialogDescription>
        </DialogHeader>
        <div className="px-4 pb-2">
          <Input
            autoFocus
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search sessions..."
            className="h-8"
          />
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {filtered.length === 0 ? (
            <div className="text-center text-muted-foreground py-8 text-sm">
              {searchQuery.trim() ? 'No matching sessions' : 'No sessions available'}
            </div>
          ) : (
            <div className="space-y-0.5">
              {filtered.map((session, index) => {
                const isActive = session.id === currentSessionId;
                const isSelected = index === selectedIndex;
                const projectLabel = getProjectLabel(session);
                return (
                  <div
                    key={session.id}
                    ref={(el) => { itemRefs.current[index] = el; }}
                    onClick={() => handleSelect(session.id)}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer text-sm',
                      isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                    )}
                  >
                    <span className="flex-1 truncate font-medium">
                      {session.title || 'Untitled session'}
                    </span>
                    {projectLabel && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {projectLabel}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground shrink-0">
                      {formatRelativeTime(session.time?.updated)}
                    </span>
                    {isActive && (
                      <span className="text-xs text-primary shrink-0">●</span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
