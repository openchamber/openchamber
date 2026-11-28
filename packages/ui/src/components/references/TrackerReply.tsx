import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { ButtonTooltip, TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { TrackerItem } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import { formatShortcutForDisplay } from '@/lib/shortcuts';

export const TrackerReply: React.FC<{
    item: TrackerItem;
    onRefresh: () => void;
}> = ({ item, onRefresh }) => {
    const { t } = useI18n();
    const { trackers } = useRuntimeAPIs();
    const [text, setText] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const body = text.trim() ? text : null;
    const shortcut = formatShortcutForDisplay('mod+enter');

    const comment = async () => {
        if (!body || busy || !trackers) return;
        setBusy(true);
        try {
            const result = await trackers.commentCreate(item.provider, { identifier: item.identifier, body });
            if (!result.connected || !result.comment) {
                toast.error(t('sourceBoard.reply.toast.commentFailed', { reference: item.identifier }));
                return;
            }
            setText('');
            toast.success(t('sourceBoard.reply.toast.commented', { reference: item.identifier }));
            onRefresh();
        } catch (error) {
            toast.error(t('sourceBoard.reply.toast.commentFailed', { reference: item.identifier }), { description: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(false);
        }
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
        if (isIMECompositionEvent(event)) return;
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void comment();
        }
    };

    return (
        <section className="flex flex-col gap-2 border-t border-edge pt-4" aria-label={t('sourceBoard.reply.label')}>
            <Textarea
                value={text}
                onChange={(event) => setText(event.target.value)}
                onKeyDown={onKeyDown}
                placeholder={t('sourceBoard.reply.placeholder')}
                aria-label={t('sourceBoard.reply.label')}
                disabled={busy}
                rows={3}
            />
            <div className="flex flex-wrap items-center justify-end gap-2">
                <ButtonTooltip label={<TooltipLabelWithShortcut label={t('sourceBoard.reply.comment')} shortcut={shortcut} />}>
                    <Button size="sm" onClick={() => void comment()} disabled={busy || !body}>
                        {busy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="chat-1" className="size-3.5" />}
                        {t('sourceBoard.reply.comment')}
                    </Button>
                </ButtonTooltip>
            </div>
        </section>
    );
};
