import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { answerPreview } from '../lib/turns/answerPreview';
import type { TurnRecord } from '../lib/turns/types';
import { formatTimestampForDisplay } from '../message/timeFormat';
import { NAME_SLOT, readWake } from '../message/wake';
import { WakeTitle } from '../message/WakeTitle';
import { FoldLine } from './FoldLine';

const LINE_LOOK = { wake: { icon: 'notification-3' }, reply: { icon: 'message-2' } } as const;

export const TurnLine: React.FC<{ turn: TurnRecord; wake: boolean; open: boolean; unread: boolean; onToggle: () => void }> = ({ turn, wake, open, unread, onToggle }) => {
    const { t } = useI18n();
    const timeFormat = useUIStore((state) => state.timeFormatPreference);
    const preview = React.useMemo(() => answerPreview(turn), [turn]);
    const cause = React.useMemo(() => (wake ? readWake(turn.userMessage.info, t) : undefined), [t, turn, wake]);
    const text = preview.text || t('chat.exchange.noAnswer');
    const line = (
        <FoldLine icon={cause?.icon ?? LINE_LOOK[wake ? 'wake' : 'reply'].icon} failed={preview.failed || cause?.failed} open={open} onToggle={onToggle}>
            {wake ? (
                <>
                    <span className="max-w-[45%] shrink-0 truncate" title={cause?.title.replace(NAME_SLOT, () => cause.name)}>
                        {cause ? <WakeTitle title={cause.title} name={cause.name} /> : t('chat.exchange.wake')}
                    </span>
                    <Icon name="arrow-right" className="size-3 shrink-0 text-[var(--tools-icon)]" />
                </>
            ) : null}
            <span
                className={unread ? 'oc-ui-start-align min-w-0 flex-1 truncate text-foreground' : 'oc-ui-start-align min-w-0 flex-1 truncate'}
                dir="auto"
                title={preview.at === undefined ? text : `${formatTimestampForDisplay(preview.at, timeFormat)}\n${text}`}
            >
                {text}
                {unread ? <span className="sr-only"> {t('chat.exchange.unread')}</span> : null}
            </span>
        </FoldLine>
    );
    if (!wake || open) return line;
    return <section id={`turn-${turn.turnId}`} data-turn-id={turn.turnId} data-scroll-spy-id={turn.turnId}>{line}</section>;
};
