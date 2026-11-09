import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { I18nKey } from '@/lib/i18n';
import { useI18n } from '@/lib/i18n';
import { formatDateTimeForPreference } from '@/lib/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import type { OpencodeToolResult, ScheduleView } from './opencodeToolResult';
import { RawToggleContext } from './toolResultContext';
import { Actions, Field, List, ListRow, Section, WebLinkRow } from './ToolResultParts';

/** The data of one tool's result. */
type ResultOf<Tool extends OpencodeToolResult['tool']> = Extract<OpencodeToolResult, { tool: Tool }>['data'];

const folderName = (directory: string): string => directory.split(/[\\/]/).filter(Boolean).pop() ?? directory;

const FolderRow: React.FC<{ directory: string; secondary?: string }> = ({ directory, secondary }) => (
    <ListRow
        icon={<Icon name="folder-6" className="size-3.5 shrink-0 text-muted-foreground" />}
        primary={folderName(directory)}
        secondary={secondary ?? directory}
        title={directory}
    />
);

const WorktreeBody: React.FC<{ data: { directory: string } }> = ({ data }) => (
    <>
        <ul><FolderRow directory={data.directory} /></ul>
        <Actions />
    </>
);

const WorktreesBody: React.FC<{ data: ResultOf<'worktree_list'> }> = ({ data }) => {
    const { t } = useI18n();
    return (
        <>
            <List count={data.worktrees.length}>
                {data.worktrees.map((worktree) => (
                    <FolderRow
                        key={worktree.directory}
                        directory={worktree.directory}
                        secondary={worktree.type === 'root' ? t('chat.toolPart.opencode.worktree.root') : undefined}
                    />
                ))}
            </List>
            <Actions />
        </>
    );
};

const ModelsBody: React.FC<{ data: ResultOf<'models'> }> = ({ data }) => {
    const { providers, total, next } = data;
    const models = providers.flatMap((provider) => provider.models.map((model) => ({ ...model, provider: provider.name ?? provider.id })));
    // A later page of the search: what is left counts from where the next page starts.
    const more = total === undefined || next === undefined ? undefined : next === null ? 0 : total - next;
    return (
        <>
            <List count={models.length} more={more}>
                {models.map((model) => <ListRow key={model.id} primary={model.name ?? model.id} secondary={model.provider} title={model.id} />)}
            </List>
            <Actions />
        </>
    );
};

const McpCatalogBody: React.FC<{ data: ResultOf<'list_mcp_resources'> }> = ({ data }) => {
    const { t } = useI18n();
    const { resources, templates } = data;
    return (
        <>
            {resources.length + templates.length === 0 ? <List count={0}>{null}</List> : null}
            {resources.length > 0 ? (
                <Section label={t('chat.toolPart.opencode.mcp.resources')}>
                    <List count={resources.length}>
                        {resources.map((resource) => (
                            <ListRow key={`${resource.server}:${resource.uri}`} primary={resource.name} secondary={resource.server} title={resource.description ?? resource.uri} />
                        ))}
                    </List>
                </Section>
            ) : null}
            {templates.length > 0 ? (
                <Section label={t('chat.toolPart.opencode.mcp.templates')}>
                    <List count={templates.length}>
                        {templates.map((template) => (
                            <ListRow key={`${template.server}:${template.uriTemplate}`} primary={template.name} secondary={template.server} title={template.description ?? template.uriTemplate} />
                        ))}
                    </List>
                </Section>
            ) : null}
            <Actions />
        </>
    );
};

const McpContentBody: React.FC<{ data: ResultOf<'read_mcp_resource'> }> = ({ data }) => {
    const { t } = useI18n();
    const { server, uri, contents } = data;
    return (
        <>
            <ul><ListRow primary={uri} secondary={server} title={uri} /></ul>
            {contents.map((content, index) => (content.type === 'text' ? (
                <div key={index} className="typography-meta whitespace-pre-wrap break-words text-foreground">{content.text}</div>
            ) : (
                <div key={index} className="typography-meta text-muted-foreground">
                    {t('chat.toolPart.opencode.mcp.binary', { type: content.mimeType ?? 'application/octet-stream' })}
                </div>
            )))}
            <Actions />
        </>
    );
};

const WHEN_KEYS = {
    in: 'chat.toolPart.opencode.schedule.in',
    at: 'chat.toolPart.opencode.schedule.at',
    every: 'chat.toolPart.opencode.schedule.every',
    cron: 'chat.toolPart.opencode.schedule.cron',
} as const satisfies Record<ScheduleView['when']['type'], I18nKey>;

/** When a schedule fires, in the words it was given: OpenCode keeps durations and cron as written. */
const useScheduleWhen = () => {
    const { t } = useI18n();
    return (schedule: ScheduleView): string => {
        const { when } = schedule;
        // `at` is a wall-clock time in the schedule's zone or an instant with
        // its offset, so it is shown as written rather than moved into ours.
        const value = when.type === 'in' ? when.in : when.type === 'at' ? when.at.replace('T', ' ') : when.type === 'every' ? when.every : when.cron;
        const phrase = t(WHEN_KEYS[when.type], { value });
        return schedule.tz ? `${phrase} (${schedule.tz})` : phrase;
    };
};

/** A schedule's gate: the shell command it runs, or that a script decides. */
const ConditionText: React.FC<{ condition: NonNullable<ScheduleView['if']> }> = ({ condition }) => {
    const { t } = useI18n();
    return condition.type === 'shell'
        ? <code className="typography-code break-all">{condition.run}</code>
        : <>{t('chat.toolPart.opencode.schedule.codeCheck')}</>;
};

const ScheduleBody: React.FC<{ schedule: ScheduleView }> = ({ schedule }) => {
    const { t } = useI18n();
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
    const describeWhen = useScheduleWhen();
    const format = (value: string | undefined) => (value
        ? formatDateTimeForPreference(new Date(value), timeFormatPreference, { dateStyle: 'medium', timeStyle: 'short' })
        : '');
    const next = format(schedule.nextDueAt);
    const ends = format(schedule.endsAt);
    // A gated schedule's slots are checks; the prompt goes out only when its check passes.
    const gated = Boolean(schedule.if ?? schedule.until);
    return (
        <>
            <Field label={t('chat.toolPart.openchamber.field.when')}>{describeWhen(schedule)}</Field>
            {schedule.if ? <Field label={t('chat.toolPart.opencode.field.if')}><ConditionText condition={schedule.if} /></Field> : null}
            {schedule.until ? <Field label={t('chat.toolPart.opencode.field.until')}><ConditionText condition={schedule.until} /></Field> : null}
            {next && schedule.status === 'active' ? <Field label={t(gated ? 'chat.toolPart.opencode.field.nextCheck' : 'chat.toolPart.opencode.field.nextRun')}>{next}</Field> : null}
            {ends ? <Field label={t('chat.toolPart.opencode.field.ends')}>{ends}</Field> : null}
            {schedule.remainingRuns !== undefined ? <Field label={t('chat.toolPart.opencode.field.runsLeft')}>{schedule.remainingRuns}</Field> : null}
            {schedule.status !== 'active' ? (
                <Field label={t('chat.toolPart.openchamber.field.state')}>
                    {schedule.status === 'paused' ? t('chat.toolPart.openchamber.schedule.paused') : t('chat.toolPart.opencode.schedule.done')}
                </Field>
            ) : null}
            <div className="typography-meta whitespace-pre-wrap break-words text-foreground">{schedule.prompt}</div>
            <Actions />
        </>
    );
};

const SchedulesBody: React.FC<{ data: ResultOf<'schedule_list'> }> = ({ data }) => {
    const { t } = useI18n();
    const describeWhen = useScheduleWhen();
    const { schedules } = data;
    return (
        <>
            <List count={schedules.length}>
                {schedules.map((schedule) => (
                    <ListRow
                        key={schedule.id}
                        primary={schedule.name ?? schedule.prompt.split('\n')[0]}
                        secondary={[
                            describeWhen(schedule),
                            schedule.until ? t('chat.toolPart.opencode.schedule.untilCheck') : schedule.if ? t('chat.toolPart.opencode.schedule.ifCheck') : undefined,
                            schedule.status === 'paused' ? t('chat.toolPart.openchamber.schedule.paused')
                                : schedule.status === 'done' ? t('chat.toolPart.opencode.schedule.done') : undefined,
                        ].filter(Boolean).join(' · ')}
                        title={schedule.prompt}
                    />
                ))}
            </List>
            <Actions />
        </>
    );
};

const ArtifactBody: React.FC<{ data: ResultOf<'artifact_create'> }> = ({ data }) => {
    const { url, title, provider } = data;
    return (
        <>
            <WebLinkRow url={url} icon="global" primary={title} secondary={provider} />
            <Actions />
        </>
    );
};

const ArtifactContentBody: React.FC<{ data: ResultOf<'artifact_read'> }> = ({ data }) => {
    const { t } = useI18n();
    const { info, files } = data;
    const paths = Object.keys(files);
    return (
        <>
            <WebLinkRow url={info.url} icon="global" primary={info.title} secondary={info.provider} />
            <Section label={t('chat.toolPart.opencode.artifact.files')}>
                <List count={paths.length}>
                    {paths.map((path) => (
                        <ListRow key={path} icon={<Icon name="file-text" className="size-3.5 shrink-0 text-muted-foreground" />} primary={path} />
                    ))}
                </List>
            </Section>
            <Actions />
        </>
    );
};

const OpencodeView: React.FC<{ result: OpencodeToolResult }> = ({ result }) => {
    const { t } = useI18n();
    switch (result.tool) {
        case 'session_rename':
            return (
                <>
                    <Field label={t('chat.toolPart.opencode.field.title')}>{result.data.title}</Field>
                    <Actions />
                </>
            );
        case 'session_move':
            return (
                <>
                    <Field label={t('chat.toolPart.openchamber.field.folder')}>{result.data.directory}</Field>
                    <Actions />
                </>
            );
        case 'worktree_create':
        case 'worktree_remove': return <WorktreeBody data={result.data} />;
        case 'worktree_list': return <WorktreesBody data={result.data} />;
        case 'models': return <ModelsBody data={result.data} />;
        case 'list_mcp_resources': return <McpCatalogBody data={result.data} />;
        case 'read_mcp_resource': return <McpContentBody data={result.data} />;
        case 'schedule_create':
        case 'schedule_pause':
        case 'schedule_resume': return <ScheduleBody schedule={result.data} />;
        case 'schedule_list': return <SchedulesBody data={result.data} />;
        case 'artifact_create':
        case 'artifact_update': return <ArtifactBody data={result.data} />;
        case 'artifact_read': return <ArtifactContentBody data={result.data} />;
        // What was deleted is the row's own description.
        case 'schedule_delete':
        case 'artifact_delete': return <Actions />;
    }
};

/**
 * What one of OpenCode's `opencode` namespace tools did, in its own terms:
 * the worktree it made, the models it found, the schedule it set. The result
 * was read against the tool's output schema before this renders.
 */
export const OpencodeToolOutput: React.FC<{ result: OpencodeToolResult; rawToggle: React.ReactNode }> = ({ result, rawToggle }) => (
    <RawToggleContext.Provider value={rawToggle}>
        <OpencodeView result={result} />
    </RawToggleContext.Provider>
);
