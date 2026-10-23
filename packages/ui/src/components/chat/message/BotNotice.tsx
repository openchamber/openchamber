import { useMobileAppActions } from '@/apps/mobileAppContext';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import type { OpenChamberResume } from '@/lib/opencode/openchamber-resume';
import { useUIStore } from '@/stores/useUIStore';
import { ReasoningTimelineBlock } from './parts/ReasoningPart';

type Props = {
    readonly notice: Extract<OpenChamberResume, { kind: 'bot' }>;
    readonly blockId: string;
};

/** Provider text is disclosed through the existing system-row presentation. */
export const BotNotice = ({ notice, blockId }: Props) => {
    const { t } = useI18n();
    const mobile = useMobileAppActions();
    const openItem = () => {
        const ui = useUIStore.getState();
        ui.setBotsPageTarget({ projectId: notice.projectId, itemId: notice.itemId });
        if (mobile) mobile.openBots(); else ui.setBotsPageOpen(true);
    };
    return (
        <ReasoningTimelineBlock
            text={notice.text}
            blockId={blockId}
            presentation={{
                icon: 'information',
                title: t('chat.openchamberResume.bot'),
                expandLabel: t('chat.openchamberResume.show'),
                collapseLabel: t('chat.openchamberResume.hide'),
                markdownVariant: 'assistant',
                maxHeightClassName: 'max-h-[60vh]',
            }}
            actions={isVSCodeRuntime() ? undefined : (
                <Button type="button" variant="ghost" size="xs" onClick={openItem}>
                    <Icon name="external-link" className="size-3.5" />
                    {t('chat.openchamberResume.openBotItem')}
                </Button>
            )}
        />
    );
};
