import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

/** The Decline under a page that waits; `usePageDecline` sends it. */
export function DeclinePageButton({ onDecline, disabled }: { onDecline: () => void; disabled: boolean }) {
    const { t } = useI18n();
    return (
        <Button type="button" variant="secondary" className="w-fit" disabled={disabled} onClick={onDecline}>
            {t('chat.htmlRender.decline')}
        </Button>
    );
}
