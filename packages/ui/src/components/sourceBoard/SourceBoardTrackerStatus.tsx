import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { StatePill } from '@/components/references/ReferencePreview';
import { toast } from '@/components/ui';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { TrackerItemSummary, TrackerWorkflowState } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { useTrackerDescriptor } from '@/lib/trackers/registry';
import { trackerStateCategoryRank, trackerStateGlyph } from '@/lib/trackers/stateLook';

// The workflow's own order: triage, backlog, to do, in progress, done, canceled; then position and name.
const compareStates = (left: TrackerWorkflowState, right: TrackerWorkflowState): number => (
    trackerStateCategoryRank(left.category) - trackerStateCategoryRank(right.category)
    || left.position - right.position
    || left.name.localeCompare(right.name)
);

/** The workflow states of an item's container, read once per container while the preview shows. */
function useContainerStates(provider: string, containerId: string | null, enabled: boolean): TrackerWorkflowState[] {
    const { trackers } = useRuntimeAPIs();
    const [loaded, setLoaded] = React.useState<{ key: string; states: TrackerWorkflowState[] } | null>(null);
    const key = `${provider}:${containerId ?? ''}`;
    React.useEffect(() => {
        if (!enabled || !containerId || !trackers) return;
        let cancelled = false;
        void trackers.states(provider, containerId)
            .then((result) => {
                if (!cancelled && result.connected) setLoaded({ key, states: [...result.states].sort(compareStates) });
            })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [containerId, enabled, key, provider, trackers]);
    return loaded && loaded.key === key ? loaded.states : [];
}

/**
 * A tracker item's state pill that moves the item to another state of its
 * container, where the tracker can change states (`stateUpdate`). Until the
 * states arrive, or where they cannot change, it stays a plain pill. The list
 * reads again afterwards, so the row shows the change.
 */
export const SourceBoardTrackerStatus: React.FC<{ item: TrackerItemSummary; onChanged: () => void }> = ({ item, onChanged }) => {
    const { t } = useI18n();
    const { trackers } = useRuntimeAPIs();
    const canUpdate = useTrackerDescriptor(item.provider).capabilities.stateUpdate;
    const states = useContainerStates(item.provider, item.container?.id ?? null, canUpdate);
    const [updating, setUpdating] = React.useState(false);
    const currentId = item.state?.id ?? null;
    const look = trackerStateGlyph(item.state?.category);
    const label = item.state?.name ?? '';

    if (!label) return null;
    if (!trackers || !canUpdate || states.length === 0 || !currentId) {
        return <StatePill icon={look.icon} color={look.color} label={label} />;
    }

    const update = async (stateId: string) => {
        if (stateId === currentId || updating) return;
        setUpdating(true);
        try {
            const result = await trackers.updateState(item.provider, { id: item.id, stateId });
            if (!result.connected || !result.item) {
                toast.error(t('sourceBoard.toast.statusUpdateFailed'));
                return;
            }
            toast.success(t('sourceBoard.toast.statusUpdated'));
            onChanged();
        } catch (error) {
            toast.error(t('sourceBoard.toast.statusUpdateFailed'), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setUpdating(false);
        }
    };

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    disabled={updating}
                    aria-label={t('sourceBoard.tracker.statusAria', { status: label })}
                    className="shrink-0 rounded-full outline-none transition-opacity hover:opacity-85 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                    <StatePill
                        icon={look.icon}
                        color={look.color}
                        label={label}
                        trailing={<Icon name={updating ? 'loader-4' : 'arrow-down-s'} className={updating ? 'size-3.5 animate-spin' : 'size-3.5 opacity-70'} />}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuRadioGroup value={currentId} onValueChange={(value) => void update(String(value))}>
                    {states.map((state) => {
                        const stateLook = trackerStateGlyph(state.category);
                        return (
                            <DropdownMenuRadioItem key={state.id} value={state.id}>
                                <Icon name={stateLook.icon} className="mt-0.5 size-3.5" style={{ color: stateLook.color }} />
                                {state.name}
                            </DropdownMenuRadioItem>
                        );
                    })}
                </DropdownMenuRadioGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};
