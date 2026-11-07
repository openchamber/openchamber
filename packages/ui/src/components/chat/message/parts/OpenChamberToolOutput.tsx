import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { formatSchedule } from '@/components/session/scheduledTaskSchedule';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useChatColumnActions } from '../../chatColumnSession';
import { ChatExternalLink } from './ChatExternalLink';
import type { ToolInput, ToolPart } from '@/lib/opencode/model';
import { useI18n } from '@/lib/i18n';
import { formatQuotaResetLabel, formatWindowLabel } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import {
    dispatchedSchema,
    knowledgeListedSchema,
    knowledgeSavedSchema,
    linkedSchema,
    memoriesListedSchema,
    memorySavedSchema,
    modelPreferencesSchema,
    modelsFoundSchema,
    movedSchema,
    pageOpenedSchema,
    projectsListedSchema,
    scheduledSchema,
    scheduleListedSchema,
    screenshotSchema,
    sessionsListedSchema,
    tightestWindow,
    readOpenChamberCallInput,
    usageSchema,
    type OpenChamberCallInput,
    type OpenChamberEnvelope,
} from './openChamberToolEnvelope';
import { GeneratedImages } from './GeneratedImages';
import type { ToolPopupContent } from '../types';

const Warning: React.FC<{ text: string | undefined }> = ({ text }) => (
    text ? <div className="typography-meta break-words" style={{ color: 'var(--status-warning)' }}>{text}</div> : null
);

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="flex min-w-0 items-baseline gap-3 typography-meta">
        <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
        <span className="min-w-0 break-words text-foreground">{children}</span>
    </div>
);

/** The row's own "Show the raw answer" switch, which the actions row ends with. */
const RawToggleContext = React.createContext<React.ReactNode>(null);

type OpenAction = { label: string; icon: IconName; onOpen: () => void };

/**
 * The quiet actions under a view: where to open what the call made, then the
 * raw answer. Text that brightens on hover, the way the raw switch looks,
 * in one row.
 */
const Actions: React.FC<{ open?: OpenAction | null }> = ({ open }) => {
    const rawToggle = React.useContext(RawToggleContext);
    return (
        <div className="-ms-2 flex flex-wrap items-center gap-x-1">
            {open ? (
                <Button
                    variant="ghost"
                    size="xs"
                    className="text-muted-foreground hover:text-foreground"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                        event.stopPropagation();
                        open.onOpen();
                    }}
                >
                    <Icon name={open.icon} className="size-3.5" />
                    {open.label}
                </Button>
            ) : null}
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
const WebLinkRow: React.FC<{ url: string; icon: IconName; primary: React.ReactNode; secondary?: React.ReactNode }> = ({ url, icon, primary, secondary }) => (
    <ChatExternalLink href={url} title={url} className={LINK_ROW_CLASS} onPointerDown={(event) => event.stopPropagation()}>
        <LinkRowContent icon={icon} primary={primary} secondary={secondary} />
    </ChatExternalLink>
);

/** A session the call named; a chat pinned beside the main one opens it inside itself. */
const SessionLinkRow: React.FC<{ sessionId: string; directory: string | undefined; title: string | undefined; secondary?: React.ReactNode; child?: boolean }> = ({ sessionId, directory, title, secondary, child }) => {
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

/** Where a panel can open beside the chat: not on a phone or in VS Code, which show one surface at a time. */
const usePanelsAvailable = (isMobile: boolean): boolean => {
    const runtime = React.useContext(RuntimeAPIContext);
    return !isMobile && !runtime?.runtime.isVSCode;
};

/**
 * Whether the call worked on the chat's own project. A panel shows the chat's
 * project, so an entry from another one stays readable in the row without a
 * button that would open the wrong project's panel.
 */
const isOwnProject = (call: OpenChamberCallInput, directory: string): boolean => (
    !call.projectId && (!call.directory || call.directory === directory)
);

const LinkedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const parsed = linkedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { linked } = parsed.data;
    const repository = linked.id?.includes('#') ? linked.id.slice(0, linked.id.indexOf('#')) : undefined;
    const label = [linked.number ? `#${linked.number}` : undefined, linked.title].filter(Boolean).join(' ');
    return (
        <>
            <WebLinkRow url={linked.url} icon={linked.kind === 'issue' ? 'record-circle' : 'git-pull-request'} primary={label || linked.url} secondary={repository} />
            <Actions />
        </>
    );
};

const DispatchedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const parsed = dispatchedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { sessionId, directory, title, model, agent } = parsed.data;
    const modelLabel = [model?.providerID && model.modelID ? `${model.providerID}/${model.modelID}` : undefined, agent].filter(Boolean).join(' · ');
    return (
        <>
            <SessionLinkRow sessionId={sessionId} directory={directory} title={title} secondary={modelLabel || undefined} />
            <Actions />
        </>
    );
};

const MovedBody: React.FC<{ data: unknown; call: OpenChamberCallInput }> = ({ data, call }) => {
    const { t } = useI18n();
    const parsed = movedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { worktree, directory } = parsed.data;
    const carried = call.carry ?? [];
    return (
        <>
            {worktree?.branch ? <Field label={t('chat.toolPart.openchamber.field.branch')}>{worktree.branch}</Field> : null}
            {worktree?.path ?? directory ? <Field label={t('chat.toolPart.openchamber.field.folder')}>{worktree?.path ?? directory}</Field> : null}
            {carried.length > 0 ? <Field label={t('chat.toolPart.openchamber.field.carried')}>{carried.join(', ')}</Field> : null}
            <Actions />
        </>
    );
};

const MemorySavedBody: React.FC<{ data: unknown; call: OpenChamberCallInput; directory: string; isMobile: boolean }> = ({ data, call, directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile);
    const parsed = memorySavedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { memory, replaced, warning } = parsed.data;
    const kind = [
        memory.type === 'fact' ? t('chat.toolPart.openchamber.memory.type.fact')
            : memory.type === 'preference' ? t('chat.toolPart.openchamber.memory.type.preference')
                : memory.type === 'reference' ? t('chat.toolPart.openchamber.memory.type.reference') : undefined,
        memory.scope === 'global' ? t('chat.toolPart.openchamber.memory.scope.global')
            : memory.scope === 'project' ? t('chat.toolPart.openchamber.memory.scope.project') : undefined,
        replaced ? t('chat.toolPart.openchamber.memory.replaced') : undefined,
    ].filter(Boolean).join(' · ');
    const body = call.body;
    const open = () => {
        const store = useUIStore.getState();
        store.setProjectContextTab('memory');
        store.openContextPanelTab(directory, { mode: 'notes' });
    };
    return (
        <>
            {kind ? <div className="typography-meta text-muted-foreground">{kind}</div> : null}
            {body ? <div className="typography-meta whitespace-pre-wrap break-words text-foreground">{body}</div> : null}
            <Warning text={warning} />
            <Actions open={panels && directory ? { label: t('chat.toolPart.openchamber.open.memory'), icon: 'brain', onOpen: open } : null} />
        </>
    );
};

const KnowledgeSavedBody: React.FC<{ data: unknown; call: OpenChamberCallInput; directory: string; isMobile: boolean }> = ({ data, call, directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile);
    const parsed = knowledgeSavedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { todo, note, plan, warning } = parsed.data;
    const ownProject = isOwnProject(call, directory);
    const tab = todo ? 'todos' : plan ? 'plans' : 'notes';
    const open = () => {
        const store = useUIStore.getState();
        store.setProjectContextTab(tab);
        store.openContextPanelTab(directory, { mode: 'notes' });
    };
    return (
        <>
            {todo?.text ? (
                <div className="flex min-w-0 items-start gap-2 typography-meta text-foreground">
                    <Icon name={todo.completed ? 'checkbox-circle' : 'checkbox-blank-circle'} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 break-words">{todo.text}</span>
                </div>
            ) : null}
            {note?.body ? <div className="typography-meta whitespace-pre-wrap break-words text-foreground">{note.body}</div> : null}
            {plan?.path ? <Field label={t('chat.toolPart.openchamber.field.file')}>{plan.path}</Field> : null}
            <Warning text={warning} />
            <Actions open={panels && ownProject && directory ? { label: t('chat.toolPart.openchamber.open.knowledge'), icon: 'sticky-note', onOpen: open } : null} />
        </>
    );
};

const ScheduledBody: React.FC<{ data: unknown; call: OpenChamberCallInput; directory: string; isMobile: boolean }> = ({ data, call, directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile) && isOwnProject(call, directory);
    const parsed = scheduledSchema.safeParse(data);
    if (!parsed.success) return null;
    const { task } = parsed.data;
    return (
        <>
            <Field label={t('chat.toolPart.openchamber.field.when')}>{formatSchedule(task.schedule, t)}</Field>
            {task.enabled === false ? <Field label={t('chat.toolPart.openchamber.field.state')}>{t('chat.toolPart.openchamber.schedule.paused')}</Field> : null}
            <Actions open={panels ? { label: t('chat.toolPart.openchamber.open.scheduled'), icon: 'calendar-schedule', onOpen: () => useUIStore.getState().setScheduledTasksDialogOpen(true) } : null} />
        </>
    );
};

const NotifiedBody: React.FC<{ call: OpenChamberCallInput }> = ({ call }) => {
    const { title, body } = call;
    if (!title && !body) return <Actions />;
    return (
        <>
            <div className="min-w-0 typography-meta">
                {title ? <div className="font-medium text-foreground break-words">{title}</div> : null}
                {body ? <div className="whitespace-pre-wrap break-words text-muted-foreground">{body}</div> : null}
            </div>
            <Actions />
        </>
    );
};

const UsageBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const displayMode = useQuotaStore((state) => state.displayMode);
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const parsed = usageSchema.safeParse(data);
    if (!parsed.success) return null;
    if (parsed.data.providers.length === 0) {
        return (
            <>
                <List count={0}>{null}</List>
                <Actions />
            </>
        );
    }
    return (
        <>
            <div className="grid grid-cols-[minmax(0,7rem)_minmax(3rem,1fr)_auto_minmax(0,12rem)] items-center gap-x-3 gap-y-2 typography-meta">
                {parsed.data.providers.map((provider) => {
                    const name = provider.providerName ?? provider.providerId;
                    const tightest = provider.ok ? tightestWindow(provider) : null;
                    if (!tightest) {
                        return (
                            <React.Fragment key={provider.providerId}>
                                <span className="truncate text-foreground">{name}</span>
                                <span className="col-span-3 truncate text-muted-foreground" title={provider.error}>
                                    {provider.ok ? t('chat.toolPart.openchamber.usage.noLimit') : provider.error ?? t('chat.toolPart.openchamber.usage.failed')}
                                </span>
                            </React.Fragment>
                        );
                    }
                    const { key, window } = tightest;
                    const percent = displayMode === 'remaining' ? window.remainingPercent : window.usedPercent;
                    const reset = formatQuotaResetLabel(window.resetAt, window.resetAfterFormatted ?? window.resetAtFormatted, timeFormatPreference);
                    const caption = [formatWindowLabel(key), reset ? t('settings.usage.card.resetsAt', { time: reset }) : undefined].filter(Boolean).join(' · ');
                    return (
                        <React.Fragment key={provider.providerId}>
                            <span className="truncate text-foreground">{name}</span>
                            <UsageProgressBar percent={percent} tonePercent={window.usedPercent} className="h-1.5" />
                            <span className="text-end tabular-nums text-foreground">
                                {percent === null ? '' : `${Math.round(percent)}%`}
                            </span>
                            <span className="truncate text-muted-foreground" title={caption}>{reset}</span>
                        </React.Fragment>
                    );
                })}
            </div>
            <Actions />
        </>
    );
};

/** One line of a listed item: what it is, then what tells it apart. */
const ListRow: React.FC<{ primary: React.ReactNode; secondary?: React.ReactNode; title?: string; icon?: React.ReactNode }> = ({ primary, secondary, title, icon }) => (
    <li className="flex min-w-0 items-center gap-2 typography-meta" title={title}>
        {icon}
        <span className="min-w-0 truncate text-foreground">{primary}</span>
        {secondary ? <span className="min-w-0 shrink-[2] truncate text-muted-foreground">{secondary}</span> : null}
    </li>
);

const List: React.FC<{ children: React.ReactNode; count: number; more?: number }> = ({ children, count, more }) => {
    const { t } = useI18n();
    if (count === 0) return <div className="typography-meta text-muted-foreground">{t('chat.toolPart.openchamber.list.empty')}</div>;
    return (
        <div className="min-w-0 space-y-1">
            <ul className="min-w-0 space-y-0.5">{children}</ul>
            {more && more > 0 ? <div className="typography-meta text-muted-foreground">{t('chat.toolPart.openchamber.list.more', { count: more })}</div> : null}
        </div>
    );
};

const Section: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <div className="min-w-0 space-y-0.5">
        <div className="typography-micro font-medium text-muted-foreground">{label}</div>
        {children}
    </div>
);

const ProjectsListedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const parsed = projectsListedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { projects } = parsed.data;
    return (
        <>
            <List count={projects.length}>
                {projects.map((project) => (
                    <ListRow key={project.id} primary={project.label ?? project.path ?? project.id} secondary={project.label ? project.path : undefined} />
                ))}
            </List>
            <Actions />
        </>
    );
};

const SessionsListedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const parsed = sessionsListedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { sessions } = parsed.data;
    return (
        <>
            <List count={sessions.length}>
                {sessions.map((session) => {
                    const directory = session.location?.directory;
                    return (
                        <li key={session.id} className="min-w-0">
                            <SessionLinkRow
                                sessionId={session.id}
                                directory={directory}
                                title={session.title}
                                secondary={directory?.split(/[\\/]/).filter(Boolean).pop()}
                                child={Boolean(session.parentID)}
                            />
                        </li>
                    );
                })}
            </List>
            <Actions />
        </>
    );
};

const modelLabel = (model: { providerID: string; modelID: string }) => `${model.providerID}/${model.modelID}`;

const ModelPreferencesBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = modelPreferencesSchema.safeParse(data);
    if (!parsed.success) return null;
    const { defaultModel, defaultVariant, defaultAgent, favoriteModels, recentModels } = parsed.data;
    const defaults = [defaultModel, defaultVariant].filter(Boolean).join(' · ');
    return (
        <>
            {defaults ? <Field label={t('chat.toolPart.openchamber.field.defaultModel')}>{defaults}</Field> : null}
            {defaultAgent ? <Field label={t('chat.toolPart.openchamber.field.defaultAgent')}>{defaultAgent}</Field> : null}
            {favoriteModels.length > 0 ? <Field label={t('chat.toolPart.openchamber.field.favorites')}>{favoriteModels.map(modelLabel).join(', ')}</Field> : null}
            {recentModels.length > 0 ? <Field label={t('chat.toolPart.openchamber.field.recent')}>{recentModels.map(modelLabel).join(', ')}</Field> : null}
            <Actions />
        </>
    );
};

const ModelsFoundBody: React.FC<{ data: unknown }> = ({ data }) => {
    const parsed = modelsFoundSchema.safeParse(data);
    if (!parsed.success) return null;
    const { models, total, next } = parsed.data;
    // A later page of the search: what is left counts from where the next page starts.
    const more = total === undefined || next === undefined ? undefined : next === null ? 0 : total - next;
    return (
        <>
            <List count={models.length} more={more}>
                {models.map((model) => (
                    <ListRow key={model.id} primary={model.name ?? model.id} secondary={model.provider} title={model.id} />
                ))}
            </List>
            <Actions />
        </>
    );
};

const MemoriesListedBody: React.FC<{ data: unknown; directory: string; isMobile: boolean }> = ({ data, directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile);
    const parsed = memoriesListedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { memories, globalUnavailable, projectUnavailable } = parsed.data;
    const open = () => {
        const store = useUIStore.getState();
        store.setProjectContextTab('memory');
        store.openContextPanelTab(directory, { mode: 'notes' });
    };
    return (
        <>
            {/* A scope that failed to load is said so, never shown as empty. */}
            <Warning text={globalUnavailable ? t('chat.toolPart.openchamber.memory.globalUnavailable') : undefined} />
            <Warning text={projectUnavailable ? t('chat.toolPart.openchamber.memory.projectUnavailable') : undefined} />
            <List count={memories.length}>
                {memories.map((memory) => (
                    <ListRow
                        key={`${memory.scope ?? ''}:${memory.memoryId}`}
                        primary={memory.title ?? memory.memoryId}
                        secondary={memory.scope === 'global' ? t('chat.toolPart.openchamber.memory.scope.global')
                            : memory.scope === 'project' ? t('chat.toolPart.openchamber.memory.scope.project') : undefined}
                    />
                ))}
            </List>
            <Actions open={panels && directory ? { label: t('chat.toolPart.openchamber.open.memory'), icon: 'brain', onOpen: open } : null} />
        </>
    );
};

const KnowledgeListedBody: React.FC<{ data: unknown; call: OpenChamberCallInput; directory: string; isMobile: boolean }> = ({ data, call, directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile);
    const parsed = knowledgeListedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { todos, notes, plans } = parsed.data;
    const ownProject = isOwnProject(call, directory);
    const open = () => {
        const store = useUIStore.getState();
        store.setProjectContextTab(todos.length > 0 ? 'todos' : plans.length > 0 ? 'plans' : 'notes');
        store.openContextPanelTab(directory, { mode: 'notes' });
    };
    const empty = todos.length + notes.length + plans.length === 0;
    return (
        <>
            {empty ? <List count={0}>{null}</List> : null}
            {todos.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.knowledge.todos')}>
                    <List count={todos.length}>
                        {todos.map((todo) => (
                            <ListRow
                                key={todo.id}
                                icon={<Icon name={todo.completed ? 'checkbox-circle' : 'checkbox-blank-circle'} className="size-3.5 shrink-0 text-muted-foreground" />}
                                primary={todo.text ?? ''}
                                title={todo.text}
                            />
                        ))}
                    </List>
                </Section>
            ) : null}
            {notes.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.knowledge.notes')}>
                    <List count={notes.length}>
                        {notes.map((note) => <ListRow key={note.id} primary={note.body?.split('\n')[0] ?? ''} title={note.body} />)}
                    </List>
                </Section>
            ) : null}
            {plans.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.knowledge.plans')}>
                    <List count={plans.length}>
                        {plans.map((plan) => (
                            <ListRow
                                key={plan.id}
                                primary={plan.title ?? plan.path ?? plan.id}
                                secondary={plan.progress && plan.progress.total > 0 ? `${plan.progress.done}/${plan.progress.total}` : undefined}
                                title={plan.path}
                            />
                        ))}
                    </List>
                </Section>
            ) : null}
            <Actions open={panels && ownProject && directory ? { label: t('chat.toolPart.openchamber.open.knowledge'), icon: 'sticky-note', onOpen: open } : null} />
        </>
    );
};

const ScheduleListedBody: React.FC<{ data: unknown; call: OpenChamberCallInput; directory: string; isMobile: boolean }> = ({ data, call, directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile) && isOwnProject(call, directory);
    const parsed = scheduleListedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { tasks } = parsed.data;
    return (
        <>
            <List count={tasks.length}>
                {tasks.map((task) => (
                    <ListRow
                        key={task.id}
                        primary={task.name ?? task.id}
                        secondary={[formatSchedule(task.schedule, t), task.enabled === false ? t('chat.toolPart.openchamber.schedule.paused') : undefined].filter(Boolean).join(' · ')}
                    />
                ))}
            </List>
            <Actions open={panels ? { label: t('chat.toolPart.openchamber.open.scheduled'), icon: 'calendar-schedule', onOpen: () => useUIStore.getState().setScheduledTasksDialogOpen(true) } : null} />
        </>
    );
};

/** The page a browser action worked on. */
const PageLink: React.FC<{ url: string; title: string | undefined }> = ({ url, title }) => (
    <WebLinkRow url={url} icon="global" primary={title || url} secondary={title ? url : undefined} />
);

const PageOpenedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const parsed = pageOpenedSchema.safeParse(data);
    if (!parsed.success) return null;
    return (
        <>
            <PageLink url={parsed.data.url} title={parsed.data.title} />
            <Actions />
        </>
    );
};

const ScreenshotBody: React.FC<{ data: unknown; part: ToolPart; onShowPopup?: (content: ToolPopupContent) => void }> = ({ data, part, onShowPopup }) => {
    const parsed = screenshotSchema.safeParse(data);
    if (!parsed.success) return null;
    const { path, url, title } = parsed.data;
    return (
        <>
            {url ? <PageLink url={url} title={title} /> : null}
            <GeneratedImages part={part} paths={[path]} onShowPopup={onShowPopup} />
            <Actions />
        </>
    );
};

/**
 * What one of OpenChamber's own tools did, in its own terms: the pull
 * request it linked, the session it started, the memory it saved. `null`
 * for an action without its own view, and for an answer this view cannot
 * read, so the row falls back to the plain output.
 */
export const OpenChamberToolOutput: React.FC<{
    envelope: OpenChamberEnvelope;
    part: ToolPart;
    input: ToolInput | undefined;
    directory: string;
    isMobile: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
    /** The switch to the raw answer; every view ends its actions row with it. */
    rawToggle: React.ReactNode;
}> = ({ envelope, part, input, directory, isMobile, onShowPopup, rawToggle }) => (
    <RawToggleContext.Provider value={rawToggle}>
        <OpenChamberView envelope={envelope} part={part} input={input} directory={directory} isMobile={isMobile} onShowPopup={onShowPopup} />
    </RawToggleContext.Provider>
);

const OpenChamberView: React.FC<{
    envelope: OpenChamberEnvelope;
    part: ToolPart;
    input: ToolInput | undefined;
    directory: string;
    isMobile: boolean;
    onShowPopup?: (content: ToolPopupContent) => void;
}> = ({ envelope, part, input, directory, isMobile, onShowPopup }) => {
    const { data, action } = envelope;
    const call = readOpenChamberCallInput(input);
    switch (action) {
        case 'projects.list': return <ProjectsListedBody data={data} />;
        case 'session.list': return <SessionsListedBody data={data} />;
        case 'models.list': return <ModelPreferencesBody data={data} />;
        case 'models.search': return <ModelsFoundBody data={data} />;
        case 'memory.list': return <MemoriesListedBody data={data} directory={directory} isMobile={isMobile} />;
        case 'knowledge.list': return <KnowledgeListedBody data={data} call={call} directory={directory} isMobile={isMobile} />;
        case 'schedule.list': return <ScheduleListedBody data={data} call={call} directory={directory} isMobile={isMobile} />;
        case 'browser.open': return <PageOpenedBody data={data} />;
        case 'browser.capture': return <ScreenshotBody data={data} part={part} onShowPopup={onShowPopup} />;
        case 'session.link': return <LinkedBody data={data} />;
        case 'session.create':
        case 'session.send':
        case 'session.fork': return <DispatchedBody data={data} />;
        case 'session.moveToWorktree': return <MovedBody data={data} call={call} />;
        case 'memory.save': return <MemorySavedBody data={data} call={call} directory={directory} isMobile={isMobile} />;
        case 'knowledge.save': return <KnowledgeSavedBody data={data} call={call} directory={directory} isMobile={isMobile} />;
        case 'schedule.create':
        case 'schedule.update': return <ScheduledBody data={data} call={call} directory={directory} isMobile={isMobile} />;
        case 'notify.send': return <NotifiedBody call={call} />;
        case 'usage.read': return <UsageBody data={data} />;
        default: return null;
    }
};

