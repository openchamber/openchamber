import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { suggestPlanTitleFromText } from '@/lib/messages/messageText';
import { useProjectContextStore } from '@/stores/useProjectContextStore';

type PlanProjectRef = Parameters<ReturnType<typeof useProjectContextStore.getState>['createPlan']>[0];

export const useAssistantPlanActions = ({
    assistantPlanText,
    currentProjectRef,
}: {
    assistantPlanText: string;
    currentProjectRef: PlanProjectRef | null;
}) => {
    const { t } = useI18n();
    const [isPlanDialogOpen, setIsPlanDialogOpen] = React.useState(false);
    const [isPlanDialogMounted, setIsPlanDialogMounted] = React.useState(false);
    const suggestedPlanTitle = React.useMemo(
        () => (isPlanDialogMounted ? suggestPlanTitleFromText(assistantPlanText) : ''),
        [assistantPlanText, isPlanDialogMounted],
    );
    const [isSavingPlan, setIsSavingPlan] = React.useState(false);

    const handleSaveAsPlanClick = React.useCallback(
        (event?: React.MouseEvent<HTMLButtonElement>) => {
            event?.stopPropagation();
            event?.preventDefault();
            if (!assistantPlanText.trim()) {
                return;
            }
            setIsPlanDialogMounted(true);
            setIsPlanDialogOpen(true);
        },
        [assistantPlanText]
    );

    const handleConfirmSaveAsPlan = React.useCallback(
        async (title: string) => {
            if (!assistantPlanText.trim()) {
                return;
            }
            if (!currentProjectRef) {
                toast.error(t('chat.messageBody.toast.noProject'));
                return;
            }

            setIsSavingPlan(true);
            try {
                const created = await useProjectContextStore.getState().createPlan(currentProjectRef, {
                    title,
                    body: assistantPlanText,
                });
                if (!created) {
                    toast.error(t('chat.messageBody.toast.savePlanFailed'));
                    return;
                }
                setIsPlanDialogOpen(false);
                toast.success(t('chat.messageBody.toast.planSaved'));
            } finally {
                setIsSavingPlan(false);
            }
        },
        [assistantPlanText, currentProjectRef, t]
    );

    return {
        isPlanDialogOpen,
        setIsPlanDialogOpen,
        isPlanDialogMounted,
        suggestedPlanTitle,
        isSavingPlan,
        handleSaveAsPlanClick,
        handleConfirmSaveAsPlan,
    };
};
