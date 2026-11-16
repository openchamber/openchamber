import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { Icon } from '@/components/icon/Icon';
import { HoverTooltip } from '@/components/ui/row-tooltip';
import { useI18n } from '@/lib/i18n';

/** Copies a tool's whole output as plain text; shown on JSON and shell output. */
export const CopyToolOutputButton: React.FC<{ output: string }> = ({ output }) => {
    const { t } = useI18n();
    const [copied, setCopied] = React.useState(false);

    React.useEffect(() => {
        setCopied(false);
    }, [output]);

    const handleCopy = React.useCallback(async (event: React.MouseEvent<HTMLButtonElement>) => {
        event.stopPropagation();
        const result = await copyTextToClipboard(output);
        if (!result.ok) {
            toast.error(t('chat.toolPart.copyOutputFailed'));
            return;
        }
        setCopied(true);
        if (typeof window !== 'undefined') {
            window.setTimeout(() => setCopied(false), 1200);
        }
    }, [output, t]);

    return (
        <HoverTooltip label={copied ? t('chat.toolPart.copiedOutput') : t('chat.toolPart.copyOutput')}>
            <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-md bg-[var(--surface-elevated)]/80 text-muted-foreground hover:text-foreground"
                onClick={handleCopy}
                onPointerDown={(event) => event.stopPropagation()}
                aria-label={copied ? t('chat.toolPart.copiedOutput') : t('chat.toolPart.copyOutput')}
            >
                <Icon name={copied ? 'check' : 'file-copy'} className="h-3.5 w-3.5" />
            </Button>
        </HoverTooltip>
    );
};
