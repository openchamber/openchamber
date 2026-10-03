import React from 'react';
import { ComposerFloatingPanel } from './composer/ui/ComposerFloatingPanel';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import type { PermissionRequest } from '@/types/permission';
import { useScopedBlockingPermissions } from '@/sync/sync-context';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import {
    PermissionActions,
    PermissionRequestContent,
} from './PermissionCard';
import { getPermissionToolPresentation } from './permissionToolPresentation';
import { usePermissionFromSubagent, usePermissionResponse } from './usePermissionResponse';

/**
 * The agent's permission requests, docked above the composer in the same
 * frame as the form dock. Every pending request for the composer's session
 * (including its subagents') is a step in the header, one dot per request
 * with the current one solid, so a batch of requests raised together reads
 * as one panel to walk through rather than a stack of cards. The dock
 * answers one request at a time; once it is answered the next one takes
 * its place. The BTW sheet keeps the inline `PermissionCard` for its child
 * session's requests.
 */

interface PermissionDockProps {
    sessionId: string | null;
    directory?: string;
    hidden: boolean;
}

export const PermissionDock: React.FC<PermissionDockProps> = ({ sessionId, directory, hidden }) => {
    const permissions = useScopedBlockingPermissions(sessionId, directory);
    if (hidden || permissions.length === 0) return null;
    return <PermissionDockPanel permissions={permissions} />;
};

const PermissionDockPanel: React.FC<{ permissions: PermissionRequest[] }> = ({ permissions }) => {
    const { t } = useI18n();
    const [selectedId, setSelectedId] = React.useState<string | null>(null);
    const [collapsed, setCollapsed] = React.useState(false);
    const bodyRef = React.useRef<HTMLDivElement | null>(null);

    // The chosen request stays current while it is pending; a request that
    // was answered elsewhere (another client, auto-accept) falls back to the
    // oldest one still open.
    const currentIndex = Math.max(0, permissions.findIndex((permission) => permission.id === selectedId));
    const current = permissions[currentIndex];
    const availableMaxHeight = useMobileAutocompleteMaxHeight(bodyRef, !collapsed, 320);

    return (
        <PermissionDockRequest
            key={current.id}
            permission={current}
            permissions={permissions}
            currentIndex={currentIndex}
            collapsed={collapsed}
            onToggleCollapsed={() => setCollapsed((value) => !value)}
            onSelect={(id) => setSelectedId(id)}
            bodyRef={bodyRef}
            availableMaxHeight={availableMaxHeight}
            t={t}
        />
    );
};

const PermissionDockRequest: React.FC<{
    permission: PermissionRequest;
    permissions: PermissionRequest[];
    currentIndex: number;
    collapsed: boolean;
    onToggleCollapsed: () => void;
    onSelect: (id: string) => void;
    bodyRef: React.RefObject<HTMLDivElement | null>;
    availableMaxHeight: number | undefined;
    t: ReturnType<typeof useI18n>['t'];
}> = ({ permission, permissions, currentIndex, collapsed, onToggleCollapsed, onSelect, bodyRef, availableMaxHeight, t }) => {
    const { isResponding, respond } = usePermissionResponse(permission);
    const isFromSubagent = usePermissionFromSubagent(permission);
    const tool = getPermissionToolPresentation(permission);
    const title = t('chat.permissionCard.title');

    return (
        <ComposerFloatingPanel
            role="dialog"
            ariaLabel={title}
            compact={collapsed}
            header={<>
                <button
                    type="button"
                    onClick={onToggleCollapsed}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? t('chat.permissionDock.expandAria') : t('chat.permissionDock.collapseAria')}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-muted-foreground transition-colors hover:text-foreground"
                >
                    <Icon name="question" className="size-3.5 shrink-0 text-[var(--status-warning)]" />
                    <Icon name={collapsed ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" />
                    <span className="typography-ui-label min-w-0 truncate text-foreground">{title}</span>
                    {isFromSubagent ? (
                        <span className="typography-micro shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-muted-foreground">
                            {t('chat.questionCard.fromSubagent')}
                        </span>
                    ) : null}
                    {permissions.length > 1 ? (
                        <span className="typography-micro shrink-0 tabular-nums text-muted-foreground">
                            {t('chat.formDock.progress', { current: String(currentIndex + 1), total: String(permissions.length) })}
                        </span>
                    ) : null}
                </button>
                {/* One dot per pending request, the current one solid. */}
                {!collapsed && permissions.length > 1 ? (
                    <div className="flex shrink-0 items-center gap-1" role="tablist">
                        {permissions.map((entry, index) => {
                            const label = t('chat.permissionDock.stepAria', { index: String(index + 1), tool: getPermissionToolPresentation(entry).name });
                            return (
                                <button
                                    key={entry.id}
                                    type="button"
                                    role="tab"
                                    aria-selected={index === currentIndex}
                                    aria-label={label}
                                    title={label}
                                    onClick={() => onSelect(entry.id)}
                                    className="flex size-4 items-center justify-center"
                                >
                                    <span className={cn('block size-1.5 rounded-full transition-colors', index === currentIndex ? 'bg-primary' : 'bg-foreground/15')} />
                                </button>
                            );
                        })}
                    </div>
                ) : null}
                <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground">
                    {tool.icon}
                    <span className="typography-meta font-medium">{tool.name}</span>
                </span>
            </>}
        >
            {!collapsed ? (
                <div>
                    <div
                        ref={bodyRef}
                        className="max-h-[50vh] overflow-y-auto overscroll-contain px-1.5"
                        style={availableMaxHeight === undefined ? undefined : { maxHeight: Math.max(120, availableMaxHeight - 96) }}
                    >
                        <PermissionRequestContent permission={permission} />
                    </div>
                    <PermissionActions
                        permission={permission}
                        isResponding={isResponding}
                        onRespond={(response) => void respond(response)}
                        variant="dock"
                    />
                </div>
            ) : null}
        </ComposerFloatingPanel>
    );
};
