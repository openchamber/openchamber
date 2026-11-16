import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { useChatColumnActions } from '../../chatColumnSession';
import { ChatExternalLink } from './ChatExternalLink';
import { RawToggleContext } from './toolResultContext';

/*
 * The pieces the views of the agent's own tools are built from (OpenChamber's
 * in `OpenChamberToolOutput.tsx`, OpenCode's in `OpencodeToolOutput.tsx`), so
 * both read alike: fields, lists, rows that open what a call named, and one
 * row of quiet actions that ends with the raw answer.
 */

export const Warning: React.FC<{ text: string | undefined }> = ({ text }) => (
    text ? <div className="typography-meta break-words" style={{ color: 'var(--status-warning)' }}>{text}</div> : null
);

export const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex min-w-0 items-baseline gap-3 typography-meta">
        <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
        <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
);


/**
 * A quiet text action inside a tool row: muted text with its icon that
 * brightens on hover or keyboard focus, no fill and no padding, so its icon
 * lines up with the row's content and nothing sticks out of the row's
 * scroll box. A click stays inside: it never collapses the row. Pointer and
 * focus handlers pass through, so a `HoverTooltip` can wrap it.
 */
export const QuietAction: React.FC<
    { label: string; icon?: IconName; onClick: () => void }
    & Pick<React.ComponentProps<'button'>, 'onPointerEnter' | 'onPointerLeave' | 'onPointerDown' | 'onFocus' | 'onBlur'>
> = ({ label, icon, onClick, onPointerDown, ...handlers }) => (
    <button
        {...handlers}
        type="button"
        className="inline-flex h-6 items-center gap-1.5 whitespace-nowrap typography-meta text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:text-foreground"
        onPointerDown={(event) => {
            onPointerDown?.(event);
            event.stopPropagation();
        }}
        onClick={(event) => {
            event.stopPropagation();
            onClick();
        }}
    >
        {icon ? <Icon name={icon} className="size-3.5 shrink-0" /> : null}
        {label}
    </button>
);

export type OpenActionInput = { label: string; icon: IconName; onOpen: () => void };

/** The quiet actions under a view: where to open what the call made, then the raw answer, in one row. */
export const Actions: React.FC<{ open?: OpenActionInput | null }> = ({ open }) => {
    const rawToggle = React.useContext(RawToggleContext);
    return (
        <div className="flex flex-wrap items-center gap-x-4">
            {open ? <QuietAction icon={open.icon} label={open.label} onClick={open.onOpen} /> : null}
            {rawToggle}
        </div>
    );
};

const LINK_ROW_CLASS = 'flex w-full min-w-0 items-center gap-1.5 text-start typography-meta text-foreground/80 hover:text-foreground';

/** Something the call named that opens on a click: its kind icon, its name, then what tells it apart. */
const LinkRowContent: React.FC<{ icon: IconName; primary: React.ReactNode; secondary?: React.ReactNode }> = ({ icon, primary, secondary }) => (
    <>
        <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate">{primary}</span>
        {secondary ? <span className="min-w-0 shrink-[2] truncate text-muted-foreground">{secondary}</span> : null}
    </>
);

/**
 * A web address the call named. A click goes where a link in the chat's text
 * goes: an issue or pull request to the Tracker, a page to the browser panel,
 * as the link settings say.
 */
export const WebLinkRow: React.FC<{ url: string; icon: IconName; primary: React.ReactNode; secondary?: React.ReactNode }> = ({ url, icon, primary, secondary }) => (
    <ChatExternalLink href={url} title={url} className={LINK_ROW_CLASS} onPointerDown={(event) => event.stopPropagation()}>
        <LinkRowContent icon={icon} primary={primary} secondary={secondary} />
    </ChatExternalLink>
);

/** A session the call named; a chat pinned beside the main one opens it inside itself. */
export const SessionLinkRow: React.FC<{ sessionId: string; directory: string | undefined; title: string | undefined; secondary?: React.ReactNode; child?: boolean }> = ({ sessionId, directory, title, secondary, child }) => {
    const { t } = useI18n();
    const { openSession } = useChatColumnActions();
    return (
        <button
            type="button"
            disabled={!directory}
            className={LINK_ROW_CLASS}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
                event.stopPropagation();
                if (directory) openSession(sessionId, directory);
            }}
        >
            <LinkRowContent icon={child ? 'robot-2' : 'chat-3'} primary={title ?? t('chat.toolPart.openchamber.session.untitled')} secondary={secondary} />
        </button>
    );
};


/** One line of a listed item: what it is, then what tells it apart. */
export const ListRow: React.FC<{ primary: React.ReactNode; secondary?: React.ReactNode; title?: string; icon?: React.ReactNode }> = ({ primary, secondary, title, icon }) => (
    <li className="flex min-w-0 items-center gap-2 typography-meta" title={title}>
        {icon}
        <span className="min-w-0 truncate text-foreground">{primary}</span>
        {secondary ? <span className="min-w-0 shrink-[2] truncate text-muted-foreground">{secondary}</span> : null}
    </li>
);

export const List: React.FC<{ children: React.ReactNode; count: number; more?: number }> = ({ children, count, more }) => {
    const { t } = useI18n();
    if (count === 0) return <div className="typography-meta text-muted-foreground">{t('chat.toolPart.openchamber.list.empty')}</div>;
    return (
        <div className="min-w-0 space-y-1">
            <ul className="min-w-0 space-y-0.5">{children}</ul>
            {more && more > 0 ? <div className="typography-meta text-muted-foreground">{t('chat.toolPart.openchamber.list.more', { count: more })}</div> : null}
        </div>
    );
};

export const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="min-w-0 space-y-0.5">
        <div className="typography-micro font-medium text-muted-foreground">{label}</div>
        {children}
    </div>
);

