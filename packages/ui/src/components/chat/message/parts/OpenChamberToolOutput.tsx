import * as React from 'react';
import { z } from 'zod';

import { Icon } from '@/components/icon/Icon';
import { UsageProgressBar } from '@/components/sections/usage/UsageProgressBar';
import { formatSchedule } from '@/components/session/scheduledTaskSchedule';
import type { JsonValue, ToolInput, ToolPart } from '@/lib/opencode/model';
import { workflowRunSchema, type WorkflowRun } from '@/lib/workflows/model';
import { openWorkflowRunInPanel } from '@/lib/workflows/panel';
import { useWorkflowRun } from '@/lib/workflows/store';
import { workflowRunLook } from '../../workflows/workflowRunPresentation';
import { useI18n } from '@/lib/i18n';
import { formatQuotaResetLabel, formatWindowLabel } from '@/lib/quota';
import { useQuotaStore } from '@/stores/useQuotaStore';
import { useUIStore } from '@/stores/useUIStore';
import { useChatColumnActions } from '../../chatColumnSession';
import {
    dispatchedSchema,
    workflowSavedSchema,
    workflowStoppedSchema,
    workflowResultSchema,
    workflowListedSchema,
    workflowCheckedSchema,
    browserResizedSchema,
    browserInspectedSchema,
    browserNavigatedSchema,
    browserScrolledSchema,
    browserSelectedSchema,
    browserTypedSchema,
    browserClickedSchema,
    browserSnapshotSchema,
    scheduleRanSchema,
    fileOpenedSchema,
    workNamedSchema,
    prWatchedSchema,
    sessionMessagesSchema,
    sessionStatusSchema,
    memoryReadSchema,
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
import { RawToggleContext, usePanelsAvailable } from './toolResultContext';
import { Actions, Field, List, ListRow, Section, SessionLinkRow, Warning, WebLinkRow, type OpenActionInput } from './ToolResultParts';
import type { ToolPopupContent } from '../types';

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

const useMemoryKind = () => {
    const { t } = useI18n();
    return (memory: { type?: 'fact' | 'preference' | 'reference'; scope?: 'global' | 'project' }, replaced?: boolean) => [
        memory.type === 'fact' ? t('chat.toolPart.openchamber.memory.type.fact')
            : memory.type === 'preference' ? t('chat.toolPart.openchamber.memory.type.preference')
                : memory.type === 'reference' ? t('chat.toolPart.openchamber.memory.type.reference') : undefined,
        memory.scope === 'global' ? t('chat.toolPart.openchamber.memory.scope.global')
            : memory.scope === 'project' ? t('chat.toolPart.openchamber.memory.scope.project') : undefined,
        replaced ? t('chat.toolPart.openchamber.memory.replaced') : undefined,
    ].filter(Boolean).join(' · ');
};

const openMemory = (directory: string) => {
    const store = useUIStore.getState();
    store.setProjectContextTab('memory');
    store.openContextPanelTab(directory, { mode: 'notes' });
};

const openKnowledge = (directory: string, tab: 'todos' | 'notes' | 'plans') => {
    const store = useUIStore.getState();
    store.setProjectContextTab(tab);
    store.openContextPanelTab(directory, { mode: 'notes' });
};

const MemorySavedBody: React.FC<{ data: unknown; call: OpenChamberCallInput; directory: string; isMobile: boolean }> = ({ data, call, directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile);
    const describeKind = useMemoryKind();
    const parsed = memorySavedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { memory, replaced, warning } = parsed.data;
    const kind = describeKind(memory, replaced);
    return (
        <>
            {kind ? <div className="typography-meta text-muted-foreground">{kind}</div> : null}
            {call.body ? <div className="typography-meta whitespace-pre-wrap break-words text-foreground">{call.body}</div> : null}
            <Warning text={warning} />
            <Actions open={panels && directory ? { label: t('chat.toolPart.openchamber.open.memory'), icon: 'brain', onOpen: () => openMemory(directory) } : null} />
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

/** A memory the agent read: what kind it is, its title and its text. */
const MemoryReadBody: React.FC<{ data: unknown; directory: string; isMobile: boolean }> = ({ data, directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile);
    const describeKind = useMemoryKind();
    const parsed = memoryReadSchema.safeParse(data);
    if (!parsed.success) return null;
    const { memory } = parsed.data;
    const kind = describeKind(memory);
    return (
        <>
            {kind ? <div className="typography-meta text-muted-foreground">{kind}</div> : null}
            {memory.title ? <div className="typography-meta font-medium text-foreground break-words">{memory.title}</div> : null}
            {memory.body ? <div className="typography-meta whitespace-pre-wrap break-words text-foreground">{memory.body}</div> : null}
            <Actions open={panels && directory ? { label: t('chat.toolPart.openchamber.open.memory'), icon: 'brain', onOpen: () => openMemory(directory) } : null} />
        </>
    );
};

/** A call whose description already says what it did: only where to look next. */
const MemoryDeletedBody: React.FC<{ directory: string; isMobile: boolean }> = ({ directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile);
    return <Actions open={panels && directory ? { label: t('chat.toolPart.openchamber.open.memory'), icon: 'brain', onOpen: () => openMemory(directory) } : null} />;
};

const KnowledgeTouchedBody: React.FC<{ call: OpenChamberCallInput; directory: string; isMobile: boolean; tab: 'todos' | 'notes' | 'plans' }> = ({ call, directory, isMobile, tab }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile) && isOwnProject(call, directory);
    return <Actions open={panels && directory ? { label: t('chat.toolPart.openchamber.open.knowledge'), icon: 'sticky-note', onOpen: () => openKnowledge(directory, tab) } : null} />;
};

const SESSION_STATE_KEYS = {
    idle: 'chat.toolPart.openchamber.session.state.idle',
    busy: 'chat.toolPart.openchamber.session.state.busy',
    waiting: 'chat.toolPart.openchamber.session.state.waiting',
} as const;

const SessionStatusBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const { openSession } = useChatColumnActions();
    const parsed = sessionStatusSchema.safeParse(data);
    if (!parsed.success) return null;
    const { sessionId, directory, sessionStatus } = parsed.data;
    return (
        <>
            <Field label={t('chat.toolPart.openchamber.field.state')}>{t(SESSION_STATE_KEYS[sessionStatus.type])}</Field>
            <Actions open={directory ? { label: t('chat.toolPart.openchamber.open.session'), icon: 'chat-3', onOpen: () => openSession(sessionId, directory) } : null} />
        </>
    );
};

/** The messages the agent read from another session, oldest first, each shortened to a few lines. */
const SessionMessagesBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const { openSession } = useChatColumnActions();
    const parsed = sessionMessagesSchema.safeParse(data);
    if (!parsed.success) return null;
    const { sessionId, directory, messages } = parsed.data;
    return (
        <>
            {messages.length === 0 ? <List count={0}>{null}</List> : (
                <div className="min-w-0 space-y-2">
                    {messages.map((message) => (
                        <div key={message.id} className="min-w-0 space-y-0.5">
                            <div className="flex min-w-0 items-center gap-1.5 typography-micro text-muted-foreground">
                                <Icon name={message.role === 'user' ? 'user-3' : 'robot-2'} className="size-3 shrink-0" />
                                <span className="truncate">
                                    {[message.role === 'user' ? t('chat.toolPart.openchamber.session.role.user') : t('chat.toolPart.openchamber.session.role.assistant'), message.model].filter(Boolean).join(' · ')}
                                </span>
                            </div>
                            <div className="typography-meta line-clamp-4 whitespace-pre-wrap break-words text-foreground" title={message.text}>{message.text}</div>
                        </div>
                    ))}
                </div>
            )}
            <Actions open={directory ? { label: t('chat.toolPart.openchamber.open.session'), icon: 'chat-3', onOpen: () => openSession(sessionId, directory) } : null} />
        </>
    );
};

const PR_STATUS_KEYS = {
    waking: 'chat.toolPart.openchamber.pr.status.waking',
    unknown: 'chat.toolPart.openchamber.pr.status.unknown',
    pending: 'chat.toolPart.openchamber.pr.status.pending',
    passed: 'chat.toolPart.openchamber.pr.status.passed',
    failed: 'chat.toolPart.openchamber.pr.status.failed',
    open: 'chat.toolPart.openchamber.pr.status.open',
} as const;

const PrWatchedBody: React.FC<{ data: unknown }> = ({ data }) => {
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

const WorkNamedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = workNamedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { title, branch, named } = parsed.data;
    return (
        <>
            {title ? <Field label={t('chat.toolPart.openchamber.field.title')}>{title}</Field> : null}
            {branch ? <Field label={t('chat.toolPart.openchamber.field.branch')}>{branch}</Field> : null}
            {/* The task kept the name it had: the user's own, or the session's title. */}
            {!named ? <div className="typography-meta text-muted-foreground">{t('chat.toolPart.openchamber.work.kept')}</div> : null}
            <Actions />
        </>
    );
};

const FileOpenedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const parsed = fileOpenedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { path } = parsed.data;
    return (
        <>
            <ul><ListRow icon={<Icon name="file-text" className="size-3.5 shrink-0 text-muted-foreground" />} primary={path.split(/[\\/]/).pop() ?? path} secondary={path} title={path} /></ul>
            <Actions />
        </>
    );
};

const ScheduleRanBody: React.FC<{ data: unknown }> = ({ data }) => {
    const parsed = scheduleRanSchema.safeParse(data);
    if (!parsed.success) return null;
    const { task, sessionId, directory, persistError } = parsed.data;
    return (
        <>
            <SessionLinkRow sessionId={sessionId} directory={directory} title={task.name} />
            <Warning text={persistError} />
            <Actions />
        </>
    );
};

const ScheduleDeletedBody: React.FC<{ call: OpenChamberCallInput; directory: string; isMobile: boolean }> = ({ call, directory, isMobile }) => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile) && isOwnProject(call, directory);
    return <Actions open={panels ? { label: t('chat.toolPart.openchamber.open.scheduled'), icon: 'calendar-schedule', onOpen: () => useUIStore.getState().setScheduledTasksDialogOpen(true) } : null} />;
};

const viewportText = (viewport: { width: number | null; height: number | null } | undefined, fill: string): string | undefined => {
    if (!viewport) return undefined;
    return viewport.width && viewport.height ? `${viewport.width} \u00d7 ${viewport.height}` : fill;
};

const BrowserSnapshotBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = browserSnapshotSchema.safeParse(data);
    if (!parsed.success) return null;
    const { url, title, elements, viewport, consoleProblems } = parsed.data;
    const size = viewportText(viewport, t('chat.toolPart.openchamber.browser.viewportFill'));
    return (
        <>
            {url ? <PageLink url={url} title={title} /> : null}
            {size ? <Field label={t('chat.toolPart.openchamber.field.viewport')}>{size}</Field> : null}
            <Field label={t('chat.toolPart.openchamber.field.elements')}>{elements.length}</Field>
            {consoleProblems && consoleProblems.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.browser.console')}>
                    {consoleProblems.map((problem, index) => (
                        <div
                            key={index}
                            className="typography-meta break-words"
                            style={{ color: problem.level === 'error' ? 'var(--status-error)' : 'var(--status-warning)' }}
                        >
                            {problem.message}
                        </div>
                    ))}
                </Section>
            ) : null}
            <Actions />
        </>
    );
};

/** A browser action on one element: what it acted on, then the page it left. */
const BrowserElementBody: React.FC<{ label: string; target: string | undefined; url: string | undefined }> = ({ label, target, url }) => (
    <>
        {target ? <Field label={label}>{target}</Field> : null}
        {url ? <PageLink url={url} title={undefined} /> : null}
        <Actions />
    </>
);

const BrowserScrolledBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = browserScrolledSchema.safeParse(data);
    if (!parsed.success) return null;
    const { scrollY, maxScrollY, atTop, atBottom } = parsed.data;
    const position = atTop ? t('chat.toolPart.openchamber.browser.atTop')
        : atBottom ? t('chat.toolPart.openchamber.browser.atBottom')
            : t('chat.toolPart.openchamber.browser.scrollPosition', { position: Math.round(scrollY), max: Math.round(maxScrollY) });
    return (
        <>
            <Field label={t('chat.toolPart.openchamber.field.position')}>{position}</Field>
            <Actions />
        </>
    );
};

const BrowserInspectedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = browserInspectedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { selector, tag, label, styles } = parsed.data;
    const entries = Object.entries(styles);
    return (
        <>
            <Field label={t('chat.toolPart.openchamber.field.element')}>{[tag, label].filter(Boolean).join(' · ') || selector}</Field>
            <Field label={t('chat.toolPart.openchamber.field.selector')}><code className="typography-code break-all">{selector}</code></Field>
            {entries.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.browser.styles')}>
                    <ul className="min-w-0 space-y-0.5">
                        {entries.map(([property, value]) => <ListRow key={property} primary={property} secondary={value} />)}
                    </ul>
                </Section>
            ) : null}
            <Actions />
        </>
    );
};

/** What a workflow left, as text: an answer that is not text reads as its JSON. */
const answerText = (value: JsonValue | undefined): string | undefined => {
    if (value === undefined) return undefined;
    const plain = z.string().safeParse(value);
    return plain.success ? plain.data : JSON.stringify(value, null, 2);
};

/** A run's state as the workflow card and the Workflows panel show it. */
const WorkflowRunState: React.FC<{ state: WorkflowRun['state'] }> = ({ state }) => {
    const { t } = useI18n();
    const look = workflowRunLook(state);
    return (
        <span className="inline-flex items-center gap-1" style={look.color ? { color: look.color } : undefined}>
            <Icon name={look.icon} className="size-3.5 shrink-0" />
            {t(look.labelKey)}
        </span>
    );
};

/**
 * Opens a run in the Workflows panel, where it is live; only where that panel
 * opens beside the chat. The panel shows a project's runs, so the run's own
 * folder decides which one: a session moved since keeps its old runs there.
 * A run the store does not hold yet gets no link.
 */
const useOpenWorkflowRun = (isMobile: boolean, sessionId: string, runId: string | undefined): OpenActionInput | null => {
    const { t } = useI18n();
    const panels = usePanelsAvailable(isMobile);
    const directory = useWorkflowRun(sessionId, runId ?? '')?.directory;
    return panels && directory && runId
        ? { label: t('chat.toolPart.openchamber.open.workflow'), icon: 'flow-chart', onOpen: () => openWorkflowRunInPanel(directory, sessionId, runId) }
        : null;
};

const WorkflowCheckedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = workflowCheckedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { name, description, phases } = parsed.data;
    return (
        <>
            <div className="typography-meta font-medium text-foreground break-words">{name}</div>
            {description ? <div className="typography-meta break-words text-muted-foreground">{description}</div> : null}
            {phases.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.field.phases')}>
                    <ol className="min-w-0 space-y-0.5">
                        {phases.map((phase, index) => <ListRow key={phase} primary={`${index + 1}. ${phase}`} />)}
                    </ol>
                </Section>
            ) : null}
            <Actions />
        </>
    );
};

const WorkflowStatusBody: React.FC<{ data: unknown; isMobile: boolean }> = ({ data, isMobile }) => {
    const { t } = useI18n();
    const parsed = workflowRunSchema.safeParse(data);
    const run = parsed.success ? parsed.data : null;
    const open = useOpenWorkflowRun(isMobile, run?.parentSessionId ?? '', run?.id);
    if (!run) return null;
    const done = run.agents.filter((agent) => agent.state === 'completed').length;
    return (
        <>
            <div className="typography-meta font-medium text-foreground break-words">{run.name}</div>
            <Field label={t('chat.toolPart.openchamber.field.state')}><WorkflowRunState state={run.state} /></Field>
            {run.currentPhase ? <Field label={t('chat.toolPart.openchamber.field.phase')}>{run.currentPhase}</Field> : null}
            {run.agents.length > 0 ? (
                <Field label={t('chat.toolPart.openchamber.field.agents')}>{t('chat.toolPart.openchamber.workflow.agentsDone', { done, count: run.agents.length })}</Field>
            ) : null}
            {run.error ? <div className="typography-meta break-words" style={{ color: 'var(--status-error)' }}>{run.error}</div> : null}
            {run.resultPreview ? <div className="typography-meta line-clamp-6 whitespace-pre-wrap break-words text-foreground">{run.resultPreview}</div> : null}
            <Actions open={open} />
        </>
    );
};

const WorkflowResultBody: React.FC<{ data: unknown; part: ToolPart; isMobile: boolean }> = ({ data, part, isMobile }) => {
    const { t } = useI18n();
    const parsed = workflowResultSchema.safeParse(data);
    const open = useOpenWorkflowRun(isMobile, part.sessionID, parsed.success ? parsed.data.runId : undefined);
    if (!parsed.success) return null;
    const answer = parsed.data;
    const text = answerText('agent' in answer ? answer.agent.result : answer.result);
    const error = 'agent' in answer ? answer.agent.error : answer.error;
    return (
        <>
            {'agent' in answer ? <Field label={t('chat.toolPart.openchamber.field.agent')}>{answer.agent.label}</Field> : null}
            {'state' in answer ? <Field label={t('chat.toolPart.openchamber.field.state')}><WorkflowRunState state={answer.state} /></Field> : null}
            {error ? <div className="typography-meta break-words" style={{ color: 'var(--status-error)' }}>{error}</div> : null}
            {text ? <div className="typography-meta whitespace-pre-wrap break-words text-foreground">{text}</div> : null}
            <Actions open={open} />
        </>
    );
};

const WorkflowListedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = workflowListedSchema.safeParse(data);
    if (!parsed.success) return null;
    const { workflows, runs } = parsed.data;
    return (
        <>
            {workflows.length + runs.length === 0 ? <List count={0}>{null}</List> : null}
            {workflows.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.workflow.saved')}>
                    <List count={workflows.length}>
                        {workflows.map((workflow) => <ListRow key={workflow.name} primary={workflow.name} secondary={workflow.error ?? workflow.description} />)}
                    </List>
                </Section>
            ) : null}
            {runs.length > 0 ? (
                <Section label={t('chat.toolPart.openchamber.workflow.runs')}>
                    <List count={runs.length}>
                        {runs.map((run) => <ListRow key={run.runId} primary={run.name} secondary={run.state ? <WorkflowRunState state={run.state} /> : undefined} />)}
                    </List>
                </Section>
            ) : null}
            <Actions />
        </>
    );
};

const WorkflowChangedBody: React.FC<{ data: unknown; part: ToolPart; isMobile: boolean }> = ({ data, part, isMobile }) => {
    const { t } = useI18n();
    const parsed = workflowStoppedSchema.safeParse(data);
    const open = useOpenWorkflowRun(isMobile, part.sessionID, parsed.success ? parsed.data.runId : undefined);
    if (!parsed.success) return null;
    const { reused } = parsed.data;
    return (
        <>
            {reused ? <div className="typography-meta text-muted-foreground">{t('chat.toolPart.openchamber.workflow.reused', { count: reused })}</div> : null}
            <Actions open={open} />
        </>
    );
};

const WorkflowSavedBody: React.FC<{ data: unknown }> = ({ data }) => {
    const { t } = useI18n();
    const parsed = workflowSavedSchema.safeParse(data);
    if (!parsed.success) return null;
    return (
        <>
            <div className="typography-meta font-medium text-foreground break-words">{parsed.data.name}</div>
            <Field label={t('chat.toolPart.openchamber.field.file')}>{parsed.data.path}</Field>
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
    const { t } = useI18n();
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
        case 'memory.read': return <MemoryReadBody data={data} directory={directory} isMobile={isMobile} />;
        case 'memory.delete': return <MemoryDeletedBody directory={directory} isMobile={isMobile} />;
        case 'knowledge.show': return <KnowledgeTouchedBody call={call} directory={directory} isMobile={isMobile} tab="plans" />;
        case 'knowledge.delete': return <KnowledgeTouchedBody call={call} directory={directory} isMobile={isMobile} tab={call.kind === 'note' ? 'notes' : call.kind === 'plan' ? 'plans' : 'todos'} />;
        case 'session.status': return <SessionStatusBody data={data} />;
        case 'session.messages': return <SessionMessagesBody data={data} />;
        case 'pr.watch': return <PrWatchedBody data={data} />;
        case 'pr.unwatch':
        case 'browser.close': return <Actions />;
        case 'work.name': return <WorkNamedBody data={data} />;
        case 'file.open': return <FileOpenedBody data={data} />;
        case 'schedule.run': return <ScheduleRanBody data={data} />;
        case 'schedule.delete': return <ScheduleDeletedBody call={call} directory={directory} isMobile={isMobile} />;
        case 'schedule.toggle': return <ScheduledBody data={data} call={call} directory={directory} isMobile={isMobile} />;
        case 'browser.snapshot': return <BrowserSnapshotBody data={data} />;
        case 'browser.click': {
            const parsed = browserClickedSchema.safeParse(data);
            return parsed.success ? <BrowserElementBody label={t('chat.toolPart.openchamber.field.clicked')} target={parsed.data.label ?? parsed.data.clicked} url={parsed.data.url} /> : null;
        }
        case 'browser.type': {
            const parsed = browserTypedSchema.safeParse(data);
            return parsed.success ? <BrowserElementBody label={t('chat.toolPart.openchamber.field.typedInto')} target={parsed.data.selector} url={parsed.data.url} /> : null;
        }
        case 'browser.select': {
            const parsed = browserSelectedSchema.safeParse(data);
            return parsed.success ? <BrowserElementBody label={t('chat.toolPart.openchamber.field.selected')} target={parsed.data.label ?? parsed.data.value} url={parsed.data.url} /> : null;
        }
        case 'browser.scroll': return <BrowserScrolledBody data={data} />;
        case 'browser.back':
        case 'browser.forward': {
            const parsed = browserNavigatedSchema.safeParse(data);
            return parsed.success ? <BrowserElementBody label={t('chat.toolPart.openchamber.field.page')} target={parsed.data.title || undefined} url={undefined} /> : null;
        }
        case 'browser.inspect': return <BrowserInspectedBody data={data} />;
        case 'workflow.check': return <WorkflowCheckedBody data={data} />;
        case 'workflow.status': return <WorkflowStatusBody data={data} isMobile={isMobile} />;
        case 'workflow.result': return <WorkflowResultBody data={data} part={part} isMobile={isMobile} />;
        case 'workflow.list': return <WorkflowListedBody data={data} />;
        case 'workflow.stop':
        case 'workflow.resume': return <WorkflowChangedBody data={data} part={part} isMobile={isMobile} />;
        case 'workflow.save': return <WorkflowSavedBody data={data} />;
        case 'browser.resize': {
            const parsed = browserResizedSchema.safeParse(data);
            return parsed.success ? <BrowserElementBody label={t('chat.toolPart.openchamber.field.viewport')} target={viewportText(parsed.data.viewport, t('chat.toolPart.openchamber.browser.viewportFill'))} url={undefined} /> : null;
        }
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

