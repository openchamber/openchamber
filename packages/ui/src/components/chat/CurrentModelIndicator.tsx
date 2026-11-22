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
import { formatModelRef } from '@/lib/opencode/modelRef';
import { applyPoolPick, POOL_PICK_TIMINGS, poolPickMenuFor, type PoolPickTiming } from '@/lib/routing/poolMemberPick';
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
 * While a pool is selected the line opens a menu to pick one of its members
 * directly, now, at the next step or with the next message
 * (`lib/routing/poolMemberPick.ts`); after such a pick it offers the way back
 * to the pool.
 */
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
    const scope = React.useRef({ sessionId, directory });
    scope.current = { sessionId, directory };
    const mounted = React.useRef(false);
    React.useEffect(() => {
        mounted.current = true;
        return () => { mounted.current = false; };
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

    if (!sessionId || !lastAssistantModel) return null;

    const isPool = currentProviderId === MODEL_ROUTE_PROVIDER_ID;
    const realModel = formatModelRef(lastAssistantModel);
    const label = isPool
        ? t('chat.currentModel.labelWithPool', { pool: currentModelId, model: realModel })
        : t('chat.currentModel.label', { model: realModel });
    const turnRunning = status !== undefined && status.type !== 'idle';

    const pick = async (model: ModelSelection) => {
        if (pending) return;
        const runtimeKey = getRuntimeKey();
        const stillHere = () => mounted.current && getRuntimeKey() === runtimeKey
            && scope.current.sessionId === sessionId && scope.current.directory === directory;
        setPending(true);
        try {
            await applyPoolPick(model, timing, turnRunning, {
                isCurrent: stillHere,
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
                        <p className="max-w-80 px-2 py-1 text-xs text-muted-foreground">{t('chat.currentModel.menu.directPickHelp')}</p>
                        <DropdownMenuLabel>{t('chat.currentModel.menu.members', { pool: menu.poolID })}</DropdownMenuLabel>
                        {menu.members.map((member) => {
                            const ref = formatModelRef({ providerID: member.providerID, modelID: member.id, variant: member.variant ?? undefined });
                            return (
                                <DropdownMenuItem
                                    key={ref}
                                    className="whitespace-normal font-mono [overflow-wrap:anywhere]"
                                    data-pool-pick-member={ref}
                                    onClick={() => void pick(member)}
                                >
                                    <span dir="ltr">{ref}</span>
                                </DropdownMenuItem>
                            );
                        })}
                    </>
                ) : (
                    menu.pools.map((poolID) => (
                        <DropdownMenuItem
                            key={poolID}
                            data-pool-pick-return={poolID}
                            onClick={() => void pick({ providerID: MODEL_ROUTE_PROVIDER_ID, id: poolID })}
                        >
                            {t('chat.currentModel.menu.returnToPool', { pool: poolID })}
                        </DropdownMenuItem>
                    ))
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default React.memo(CurrentModelIndicator);
