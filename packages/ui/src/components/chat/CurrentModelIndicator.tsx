import React from 'react';

import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import type { ModelSelection } from '@/lib/opencode/model';
import type { SessionRouteTarget } from '@/lib/opencode/client';
import { formatModelRef } from '@/lib/opencode/modelRef';
import { applyPoolPick, isPinnedMember, POOL_PICK_TIMINGS, poolPickMenuFor, type PoolPick, type PoolPickTiming } from '@/lib/routing/poolMemberPick';
import { MODEL_ROUTE_PROVIDER_ID } from '@/lib/sessionErrorRecovery';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionMessages, useSessionStatus } from '@/sync/sync-context';

interface CurrentModelIndicatorProps {
    sessionId: string | null | undefined;
    directory?: string;
    className?: string;
}

const TIMING_LABEL_KEYS = {
    immediately: 'chat.currentModel.timing.immediately',
    'next-step': 'chat.currentModel.timing.nextStep',
    'next-input': 'chat.currentModel.timing.nextInput',
} as const satisfies Record<PoolPickTiming, string>;

/**
 * Persistent `provider/model#variant` of the turn that is streaming, or the
 * last one otherwise — the real model, never only the pool name the picker
 * shows. When the current selection is a pool, both show: `pool · real`.
 * Reads the session's own messages, so desktop and mobile composers mount
 * the same component without either threading messages through its parent.
 * Long references wrap instead of truncating, so the full id stays readable.
 *
 * While a pool is selected the line opens a menu to pin one of its members
 * for this session, now, at the next step or with the next message
 * (`lib/routing/poolMemberPick.ts`). The session stays on the pool, so it
 * still fails over; the line names the pinned member. A session switched to a
 * single member directly is offered the way back to the pool.
 */
const POOL_CHOICE = '';

const CurrentModelIndicator: React.FC<CurrentModelIndicatorProps> = ({ sessionId, directory, className }) => {
    const { t } = useI18n();
    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const providers = useConfigStore((state) => selectProvidersForDirectory(state, directory));
    const messages = useSessionMessages(sessionId ?? '', directory);
    const status = useSessionStatus(sessionId ?? '', directory);
    const [timing, setTiming] = React.useState<PoolPickTiming>('next-input');
    const [pending, setPending] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    // The session's pins as OpenCode reported them; undefined while unknown
    // (not read yet, or the read failed), which shows no pin rather than "none".
    const [pins, setPins] = React.useState<SessionRouteTarget[] | undefined>(undefined);
    const scope = React.useRef({ sessionId, directory });
    scope.current = { sessionId, directory };
    const mounted = React.useRef(false);
    const idleWaiters = React.useRef<Array<(idle: boolean) => void>>([]);
    React.useEffect(() => {
        mounted.current = true;
        const waiters = idleWaiters.current;
        return () => {
            mounted.current = false;
            for (const resolve of waiters.splice(0)) resolve(false);
        };
    }, []);

    const lastAssistantModel = React.useMemo(() => {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
            const message = messages[index];
            if (!message || message.role !== 'assistant') continue;
            if (!message.providerID || !message.modelID) continue;
            return message;
        }
        return undefined;
    }, [messages]);
    const menu = React.useMemo(
        () => poolPickMenuFor(providers, currentProviderId, currentModelId),
        [currentModelId, currentProviderId, providers],
    );
    const turnRunning = status !== undefined && status.type !== 'idle';
    React.useEffect(() => {
        if (turnRunning) return;
        for (const resolve of idleWaiters.current.splice(0)) resolve(true);
    }, [turnRunning]);
    const isPool = currentProviderId === MODEL_ROUTE_PROVIDER_ID;
    React.useEffect(() => {
        setPins(undefined);
        if (!sessionId || !isPool) return;
        let cancelled = false;
        void (async () => {
            const { opencodeClient } = await import('@/lib/opencode/client');
            try {
                const next = await opencodeClient.getSessionRouteTargets(sessionId, directory);
                if (!cancelled) setPins(next);
            } catch (error) {
                console.warn('[current-model] reading the pinned pool member failed:', error);
            }
        })();
        return () => { cancelled = true; };
    }, [directory, isPool, sessionId]);

    if (!sessionId || !lastAssistantModel) return null;

    const pinned = isPool ? pins?.find((entry) => entry.routeID === currentModelId)?.target : undefined;
    const realModel = formatModelRef(lastAssistantModel);
    const label = !isPool
        ? t('chat.currentModel.label', { model: realModel })
        : pinned
            ? t('chat.currentModel.labelWithPin', {
                pool: currentModelId,
                model: realModel,
                pinned: formatModelRef({ providerID: pinned.providerID, modelID: pinned.id, variant: pinned.variant ?? undefined }),
            })
            : t('chat.currentModel.labelWithPool', { pool: currentModelId, model: realModel });

    const pick = async (choice: PoolPick) => {
        if (pending) return;
        const runtimeKey = getRuntimeKey();
        const stillHere = () => mounted.current && getRuntimeKey() === runtimeKey
            && scope.current.sessionId === sessionId && scope.current.directory === directory;
        setPending(true);
        try {
            await applyPoolPick(choice, timing, turnRunning, {
                isCurrent: stillHere,
                whenIdle: () => new Promise<boolean>((resolve) => { idleWaiters.current.push(resolve); }),
                setPin: async (poolID, member) => {
                    const { opencodeClient } = await import('@/lib/opencode/client');
                    if (!stillHere()) return;
                    const next = await opencodeClient.setSessionRouteTarget(sessionId, poolID, member, directory);
                    if (stillHere()) setPins(next);
                },
                switchSessionModel: async (next) => {
                    const { opencodeClient } = await import('@/lib/opencode/client');
                    if (!stillHere()) return;
                    await opencodeClient.switchSessionModel(sessionId, next, directory);
                },
                restartTurn: async (next) => {
                    const { useSessionUIStore } = await import('@/sync/session-ui-store');
                    if (!stillHere()) return;
                    await useSessionUIStore.getState().retryMessage(sessionId, null, next);
                },
                selectComposerModel: (next) => {
                    if (!stillHere()) return;
                    const config = useConfigStore.getState();
                    if ((config.currentProviderId !== currentProviderId || config.currentModelId !== currentModelId)
                        && (config.currentProviderId !== next.providerID || config.currentModelId !== next.id)) return;
                    config.setProvider(next.providerID);
                    config.setModel(next.id);
                    config.setCurrentVariant(next.variant ?? undefined);
                    useSelectionStore.getState().saveSessionModelSelection(sessionId, next.providerID, next.id);
                    const agent = useSelectionStore.getState().getSessionAgentSelection(sessionId) ?? config.currentAgentName;
                    if (agent) useSelectionStore.getState().saveAgentModelVariantForSession(sessionId, agent, next.providerID, next.id, next.variant ?? null);
                },
            });
        } catch (error) {
            console.error('[current-model] switching the model failed:', error);
            toast.error(t('chat.currentModel.toast.failed'));
        } finally {
            setPending(false);
        }
    };

    const content = <span className="min-w-0 select-text whitespace-normal [overflow-wrap:anywhere]" dir="auto">{label}</span>;
    const rowClass = `flex min-w-0 flex-wrap items-center gap-x-1.5 px-1 font-mono text-xs text-muted-foreground ${className ?? ''}`;

    if (menu.kind === 'none') {
        return (
            <div className={rowClass} data-current-model-indicator="true" role="status" aria-label={label} title={label}>
                {content}
            </div>
        );
    }

    return (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={`${rowClass} h-auto max-w-full shrink text-start whitespace-normal font-normal`}
                    data-current-model-indicator="true"
                    aria-label={`${label}. ${t('chat.currentModel.menu.openHint')}`}
                    title={`${label}. ${t('chat.currentModel.menu.openHint')}`}
                    disabled={pending}
                    aria-pressed={menuOpen}
                >
                    {content}
                    <Icon name="arrow-down-s" className="size-3.5" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-w-[min(32rem,calc(100vw-2rem))]">
                <DropdownMenuLabel>{t('chat.currentModel.menu.timing')}</DropdownMenuLabel>
                <DropdownMenuRadioGroup value={timing} onValueChange={(value) => {
                    const next = POOL_PICK_TIMINGS.find((option) => option === value);
                    if (next) setTiming(next);
                }}>
                    {POOL_PICK_TIMINGS.map((option) => (
                        <DropdownMenuRadioItem key={option} value={option} data-pool-pick-timing={option}>
                            {t(TIMING_LABEL_KEYS[option])}
                        </DropdownMenuRadioItem>
                    ))}
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                {menu.kind === 'members' ? (
                    <>
                        <p className="max-w-80 px-2 py-1 text-xs text-muted-foreground">{t('chat.currentModel.menu.pinHelp')}</p>
                        <DropdownMenuLabel>{t('chat.currentModel.menu.members', { pool: menu.poolID })}</DropdownMenuLabel>
                        <DropdownMenuRadioGroup
                            value={menu.members.find((member) => isPinnedMember(pinned, member)) ? memberRef(pinned) : POOL_CHOICE}
                            onValueChange={(value) => {
                                const member = menu.members.find((candidate) => memberRef(candidate) === value) ?? null;
                                void pick({ kind: 'pin', poolID: menu.poolID, member });
                            }}
                        >
                            <DropdownMenuRadioItem value={POOL_CHOICE} data-pool-pick-member="">
                                {t('chat.currentModel.menu.anyMember')}
                            </DropdownMenuRadioItem>
                            {menu.members.map((member) => {
                                const ref = memberRef(member);
                                return (
                                    <DropdownMenuRadioItem
                                        key={ref}
                                        value={ref}
                                        className="whitespace-normal font-mono [overflow-wrap:anywhere]"
                                        data-pool-pick-member={ref}
                                    >
                                        <span dir="ltr">{ref}</span>
                                    </DropdownMenuRadioItem>
                                );
                            })}
                        </DropdownMenuRadioGroup>
                    </>
                ) : (
                    menu.pools.map((poolID) => (
                        <DropdownMenuItem
                            key={poolID}
                            data-pool-pick-return={poolID}
                            onClick={() => void pick({ kind: 'return', poolID })}
                        >
                            {t('chat.currentModel.menu.returnToPool', { pool: poolID })}
                        </DropdownMenuItem>
                    ))
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

const memberRef = (member: ModelSelection | undefined): string =>
    member ? formatModelRef({ providerID: member.providerID, modelID: member.id, variant: member.variant ?? undefined }) : POOL_CHOICE;

export default React.memo(CurrentModelIndicator);
