import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { fetchProjectMcpTools, MCP_TOOL_EFFECTS, type McpToolPermissions, type ProjectMcpToolCatalog } from '@/lib/suggestedTasksApi';
import { useSuggestedTasksRuntime } from '@/lib/suggestedTasksRuntime';
import { SettingsControlGroup, SettingsFieldRow, SettingsStackedField, SETTINGS_HELPER_CLASS } from './SettingsSection';

type Effect = (typeof MCP_TOOL_EFFECTS)[number];
const EFFECT_LABEL = {
  allow: 'mcpToolPermissions.allow', ask: 'mcpToolPermissions.ask', deny: 'mcpToolPermissions.deny',
} satisfies Record<Effect, I18nKey>;
const BULK_LABEL = {
  allow: 'mcpToolPermissions.allowAll', ask: 'mcpToolPermissions.askAll', deny: 'mcpToolPermissions.denyAll',
} satisfies Record<Effect, I18nKey>;

type EditorProps = {
  readonly projectId: string;
  readonly value: McpToolPermissions;
  readonly onChange: (value: McpToolPermissions) => void;
};
type CatalogRead =
  | { readonly status: 'loading' | 'error'; readonly catalog: ProjectMcpToolCatalog | null }
  | { readonly status: 'loaded'; readonly catalog: ProjectMcpToolCatalog };

/** Explicit rules survive missing catalogs; new tools always start denied. */
const ProjectMcpToolPermissionsEditor: React.FC<EditorProps> = ({ projectId, value, onChange }) => {
  const { t } = useI18n();
  const [read, setRead] = React.useState<CatalogRead>({ status: 'loading', catalog: null });
  const [attempt, setAttempt] = React.useState(0);
  const [serverName, setServerName] = React.useState('');
  const [toolName, setToolName] = React.useState('');
  React.useEffect(() => {
    const controller = new AbortController();
    setRead((current) => ({ status: 'loading', catalog: current.catalog }));
    fetchProjectMcpTools(projectId, controller.signal).then(
      (catalog) => { if (!controller.signal.aborted) setRead({ status: 'loaded', catalog }); },
      () => { if (!controller.signal.aborted) setRead((current) => ({ status: 'error', catalog: current.catalog })); },
    );
    return () => controller.abort();
  }, [projectId, attempt]);

  const catalog = read.catalog;
  const servers = [...new Set([...(catalog?.servers.map((server) => server.name) ?? []), ...value.map((server) => server.server)])];
  const updateServer = (server: string, tools: McpToolPermissions[number]['tools']) => {
    const existing = value.some((entry) => entry.server === server);
    if (!existing && value.length >= 10) return;
    onChange(existing ? value.map((entry) => entry.server === server ? { server, tools } : entry) : [...value, { server, tools }]);
  };
  const external = catalog?.status === 'external';
  const loading = read.status === 'loading' || catalog?.status === 'loading';
  const manualServer = serverName.trim();
  const manualTool = toolName.trim();
  const manualRules = value.find((entry) => entry.server === manualServer)?.tools;
  const canAdd = Boolean(manualServer && manualTool && (manualRules || value.length < 10));

  return (
    <SettingsControlGroup title={t('mcpToolPermissions.title')} contentClassName="space-y-3">
      <div className="flex min-h-7 items-center justify-between gap-2" role="status">
        <span className={SETTINGS_HELPER_CLASS}>
          {read.status === 'error' ? t('mcpToolPermissions.loadFailed')
            : loading ? t('mcpToolPermissions.loading')
              : external ? t('mcpToolPermissions.external')
                : servers.length === 0 ? t('mcpToolPermissions.empty') : null}
        </span>
        <Button type="button" size="sm" variant="ghost" disabled={read.status === 'loading'} onClick={() => setAttempt((current) => current + 1)}>
          {t('mcpToolPermissions.refresh')}
        </Button>
      </div>
      {value.length >= 10 ? <p className={SETTINGS_HELPER_CLASS}>{t('mcpToolPermissions.limit')}</p> : null}
      {servers.map((server) => {
        const saved = value.find((entry) => entry.server === server);
        const tools = catalog?.servers.find((entry) => entry.name === server)?.tools ?? [];
        const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
        const names = [...new Set([...toolsByName.keys(), ...Object.keys(saved?.tools ?? {})])];
        const disabled = !saved && value.length >= 10;
        return (
          <details key={server} className="min-w-0">
            <summary className="cursor-pointer truncate py-1 typography-ui-label text-foreground" title={server}>
              <bdi>{server}</bdi>
            </summary>
            <div className="space-y-2 ps-3">
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('mcpToolPermissions.serverActions', { server })}>
                {MCP_TOOL_EFFECTS.map((effect) => (
                  <Button key={effect} type="button" size="sm" variant="outline" disabled={disabled || names.length === 0}
                    onClick={() => updateServer(server, Object.fromEntries(names.map((name) => [name, effect])))}>
                    {t(BULK_LABEL[effect])}
                  </Button>
                ))}
                {saved ? <Button type="button" size="sm" variant="ghost" onClick={() => onChange(value.filter((entry) => entry.server !== server))}>
                  {t('mcpToolPermissions.removeRules')}
                </Button> : null}
              </div>
              {names.length === 0 ? <p className={SETTINGS_HELPER_CLASS}>{t('mcpToolPermissions.noTools')}</p> : null}
              {names.map((name) => {
                const isNew = !saved || !Object.hasOwn(saved.tools, name);
                const effect = isNew ? 'deny' : saved.tools[name];
                return (
                  <SettingsFieldRow key={name} className="[overflow-wrap:anywhere]" description={toolsByName.get(name)?.description}
                    label={<span className="inline-flex min-w-0 max-w-full items-center gap-2">
                      <span className="truncate" dir="auto" title={name}>{name}</span>
                      {isNew ? <span className="oc-tile-inset shrink-0 rounded px-1.5 typography-micro">{t('mcpToolPermissions.new')}</span> : null}
                    </span>}>
                    <Select<Effect> value={effect} disabled={disabled} onValueChange={(next) => updateServer(server, { ...saved?.tools, [name]: next })}>
                      <SelectTrigger aria-label={t('mcpToolPermissions.toolPermission', { server, tool: name })}>
                        <SelectValue>{t(EFFECT_LABEL[effect])}</SelectValue>
                      </SelectTrigger>
                      <SelectContent>{MCP_TOOL_EFFECTS.map((next) => <SelectItem key={next} value={next}>{t(EFFECT_LABEL[next])}</SelectItem>)}</SelectContent>
                    </Select>
                  </SettingsFieldRow>
                );
              })}
            </div>
          </details>
        );
      })}
      {external ? (
        <div className="flex flex-col gap-3">
          <p className="typography-meta text-[var(--status-warning-text)]">{t('mcpToolPermissions.externalDirect')}</p>
          <SettingsStackedField label={t('mcpToolPermissions.server')}>
            <Input value={serverName} onChange={(event) => setServerName(event.target.value)} aria-label={t('mcpToolPermissions.server')} dir="ltr" />
          </SettingsStackedField>
          <SettingsStackedField label={t('mcpToolPermissions.tool')}>
            <Input value={toolName} onChange={(event) => setToolName(event.target.value)} aria-label={t('mcpToolPermissions.tool')} dir="ltr" />
          </SettingsStackedField>
          <Button type="button" variant="outline" className="self-start" disabled={!canAdd} onClick={() => {
            updateServer(manualServer, { ...manualRules, [manualTool]: manualRules && Object.hasOwn(manualRules, manualTool) ? manualRules[manualTool] : 'deny' });
            setToolName('');
          }}>{t('mcpToolPermissions.add')}</Button>
        </div>
      ) : null}
    </SettingsControlGroup>
  );
};

/** Project and runtime changes retire pending reads and the manual-name draft. */
export const McpToolPermissionsEditor: React.FC<EditorProps> = (props) => {
  const runtime = useSuggestedTasksRuntime();
  return <ProjectMcpToolPermissionsEditor key={`${runtime.generation}:${props.projectId}`} {...props} />;
};
