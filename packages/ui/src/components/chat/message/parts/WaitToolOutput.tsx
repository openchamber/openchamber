import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { waitOrigin, waitSubject } from '../../waitPresentation';
import { prWatchedSchema, waitListedSchema, waitStartedSchema, type WaitEntry } from './openChamberToolEnvelope';
import { Actions, List, ListRow, Section, WebLinkRow } from './ToolResultParts';

const PR_STATUS_KEYS = {
    waking: 'chat.toolPart.openchamber.pr.status.waking',
    unknown: 'chat.toolPart.openchamber.pr.status.unknown',
    pending: 'chat.toolPart.openchamber.pr.status.pending',
    passed: 'chat.toolPart.openchamber.pr.status.passed',
    failed: 'chat.toolPart.openchamber.pr.status.failed',
    open: 'chat.toolPart.openchamber.pr.status.open',
} as const;

const PR_SOURCE = 'pr';

const isPrStatus = (value: string | null | undefined): value is keyof typeof PR_STATUS_KEYS => Boolean(value && Object.hasOwn(PR_STATUS_KEYS, value));

export const PrWatchedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = prWatchedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { url, number, title, status } = parsed.data.watching;
    const label = [number ? `#${number}` : undefined, title || undefined].filter(Boolean).join(' ');
    return (
        <>
            <WebLinkRow url={url} icon="git-pull-request" primary={label || url} secondary={status ? t(PR_STATUS_KEYS[status]) : undefined} />
            <Actions />
        </>
    );
};

const WaitRow: React.FC<{ wait: WaitEntry }> = ({ wait }) => {
    const { t } = useI18n();
    const url = wait.args?.url;
    if (wait.source === PR_SOURCE && url !== undefined) {
        return (
            <li className="min-w-0">
                <WebLinkRow url={url} icon="git-pull-request" primary={wait.title} secondary={isPrStatus(wait.label) ? t(PR_STATUS_KEYS[wait.label]) : undefined} />
            </li>
        );
    }
    return <ListRow icon={<Icon name="timer" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />} primary={waitSubject(wait, t)} secondary={waitOrigin(wait)} />;
};

export const WaitStartedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const parsed = waitStartedSchema.safeParse(data);
    if (!parsed.success) return null;
    if ('watching' in parsed.data) return <PrWatchedBody data={data} />;
    return (
        <>
            <ul className="min-w-0"><WaitRow wait={parsed.data.waiting} /></ul>
            <Actions />
        </>
    );
};

export const WaitListedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = waitListedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { waiting, sources } = parsed.data;
    const sourceTitle = (source: (typeof sources)[number]) => {
        if (source.source === 'timer') return t('chat.waits.source.timer');
        if (source.source === PR_SOURCE) return t('chat.waits.source.pr');
        return source.title;
    };
    return (
        <>
            {waiting.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.wait.waiting')}>
                    <ul className="min-w-0 space-y-0.5">{waiting.map((wait) => <WaitRow key={wait.waitId} wait={wait} />)}</ul>
                </Section>
            ) : null}
            <Section label={t('chat.toolPart.openchamber.wait.sources')}>
                <List count={sources.length}>
                    {sources.map((source) => <ListRow key={source.source} primary={sourceTitle(source)} secondary={waitOrigin(source)} />)}
                </List>
            </Section>
            <Actions />
        </>
    );
};
