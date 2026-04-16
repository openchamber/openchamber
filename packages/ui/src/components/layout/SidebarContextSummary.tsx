import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { cn } from '@/lib/utils';
import {
  ctxSummarySession,
  ctxSummaryNoActiveSession,
  ctxSummaryUntitledSession,
} from '@/lib/i18n/messages';

interface SidebarContextSummaryProps {
    className?: string;
}

const formatSessionTitle = (title?: string | null) => {
    if (!title) {
        return ctxSummaryUntitledSession();
    }
    const trimmed = title.trim();
    return trimmed.length > 0 ? trimmed : ctxSummaryUntitledSession();
};

const formatDirectoryPath = (path?: string) => {
    if (!path || path.length === 0) {
        return '/';
    }
    return path;
};

export const SidebarContextSummary: React.FC<SidebarContextSummaryProps> = ({ className }) => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const sessions = useSessions();
    const { currentDirectory } = useDirectoryStore();

    const activeSessionTitle = React.useMemo(() => {
        if (!currentSessionId) {
            return ctxSummaryNoActiveSession();
        }
        const session = sessions.find((item) => item.id === currentSessionId);
        return session ? formatSessionTitle(session.title) : ctxSummaryNoActiveSession();
    }, [currentSessionId, sessions]);

    const directoryFull = React.useMemo(() => {
        return formatDirectoryPath(currentDirectory);
    }, [currentDirectory]);

    const directoryDisplay = React.useMemo(() => {
        if (!directoryFull || directoryFull === '/') {
            return directoryFull;
        }
        const segments = directoryFull.split('/').filter(Boolean);
        return segments.length ? segments[segments.length - 1] : directoryFull;
    }, [directoryFull]);

    return (
        <div className={cn('hidden min-h-[48px] flex-col justify-center gap-0.5 border-b bg-sidebar px-3 py-2 md:flex md:pb-2', className)}>
            <span className="typography-meta text-muted-foreground">{ctxSummarySession()}</span>
            <span className="typography-ui-label font-semibold text-foreground truncate" title={activeSessionTitle}>
                {activeSessionTitle}
            </span>
            <span className="typography-meta text-muted-foreground truncate" title={directoryFull}>
                {directoryDisplay}
            </span>
        </div>
    );
};
