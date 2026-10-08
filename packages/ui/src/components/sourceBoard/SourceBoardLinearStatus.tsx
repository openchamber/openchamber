import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { StatePill } from '@/components/references/ReferencePreview';
import { linearStateLook, linearStateTypeLook } from '@/components/references/referencePickerItems';
import { toast } from '@/components/ui';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuRadioGroup,
    DropdownMenuRadioItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { LinearIssueSummary, LinearWorkflowState } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

// Linear's own order: triage, backlog, todo, in progress, done, canceled.
const WORKFLOW_TYPE_RANK = new Map<string, number>([
    ['triage', 0],
    ['backlog', 1],
    ['unstarted', 2],
    ['started', 3],
    ['completed', 4],
    ['canceled', 5],
]);

const compareStates = (left: LinearWorkflowState, right: LinearWorkflowState): number => {
    const rank = (state: LinearWorkflowState) => (state.type ? WORKFLOW_TYPE_RANK.get(state.type) ?? 99 : 99);
    return rank(left) - rank(right) || left.position - right.position || left.name.localeCompare(right.name);
};

/** The workflow states of a team, read once per team while the preview shows. */
function useTeamStates(teamId: string | null): LinearWorkflowState[] {
    const { linear } = useRuntimeAPIs();
    const [loaded, setLoaded] = React.useState<{ teamId: string; states: LinearWorkflowState[] } | null>(null);
    React.useEffect(() => {
        if (!teamId || !linear?.issueStates) return;
        let cancelled = false;
        void linear.issueStates(teamId)
            .then((result) => {
                if (!cancelled && result.connected !== false) setLoaded({ teamId, states: [...(result.states ?? [])].sort(compareStates) });
            })
            .catch(() => undefined);
        return () => { cancelled = true; };
    }, [linear, teamId]);
    return loaded && loaded.teamId === teamId ? loaded.states : [];
}

/**
 * A Linear issue's state pill that moves the issue to another state of its
 * team. Until the states arrive, or where they cannot change, it stays a
 * plain pill. The list reads again afterwards, so the row shows the change.
 */
export const SourceBoardLinearStatus: React.FC<{ issue: LinearIssueSummary; onChanged: () => void }> = ({ issue, onChanged }) => {
    const { t } = useI18n();
    const { linear } = useRuntimeAPIs();
    const states = useTeamStates(issue.team?.id ?? null);
    const [updating, setUpdating] = React.useState(false);
    const currentId = issue.state?.id ?? null;
    const look = linearStateLook(issue);
    const label = issue.state?.name ?? '';

    if (!label) return null;
    if (!linear?.issueUpdate || states.length === 0 || !currentId) {
        return <StatePill icon={look.icon} color={look.color} label={label} />;
    }

    const update = async (stateId: string) => {
        if (stateId === currentId || updating || !linear.issueUpdate) return;
        setUpdating(true);
        try {
            const result = await linear.issueUpdate({ id: issue.id, stateId });
            if (result.connected === false || !result.issue) {
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
                    aria-label={t('sourceBoard.linear.statusAria', { status: label })}
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
                        const stateLook = linearStateTypeLook(state.type);
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
