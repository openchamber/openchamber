import { toast } from '@/components/ui';
import type { useI18n } from '@/lib/i18n';
import { AUTO_PROVIDER_ID } from '@/lib/routing/autoModel';
import { spaceModelRefusal, type StoppedSpace } from '@/lib/spaces/space-model-access';
import type { SpaceTarget } from '@/lib/spaces/space-model-offer';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useConfigStore } from '@/stores/useConfigStore';

type Translate = ReturnType<typeof useI18n>['t'];

export const stoppedSpaceText = (t: Translate, reason: StoppedSpace['reason']): string =>
    t(reason === 'gone' ? 'spaces.draft.spaceGone' : reason === 'unreachable' ? 'spaces.draft.spaceUnreachable' : 'spaces.draft.spaceStopped');

export const refuseSpaceModel = (t: Translate, target: SpaceTarget, providerId: string): boolean => {
    const refusal = spaceModelRefusal(target, providerId);
    if (!refusal) return false;
    const isAuto = refusal.providerId === AUTO_PROVIDER_ID;
    const provider = isAuto
        ? t('chat.modelControls.autoModel')
        : useConfigStore.getState().providers.find((entry) => entry.id === refusal.providerId)?.name ?? refusal.providerId;
    toast.error(refusal.reason === 'opencode'
        ? t('spaces.draft.modelOpenCode')
        : t(refusal.reason === 'needs_again' ? 'spaces.draft.modelNeedsKeyAgain' : 'spaces.draft.modelNotGranted', { provider }), {
        action: {
            label: t('spaces.group.access.give'),
            onClick: () => useSpacesStore.getState().openAccessDialog(refusal.spaceId, refusal.reason === 'opencode' || isAuto ? null : refusal.providerId),
        },
    });
    return true;
};
