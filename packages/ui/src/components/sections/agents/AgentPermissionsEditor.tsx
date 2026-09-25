import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { selectMcpServersForDirectory, useMcpConfigStore } from '@/stores/useMcpConfigStore';
import { useMcpStore } from '@/stores/useMcpStore';
import {
  useAgentsStore,
  type PermissionEffect,
  type PermissionRule,
  type AgentWithExtras,
} from '@/stores/useAgentsStore';
import {
  SettingsSection,
  SettingsChipGroup,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import {
  AUTOSAVE_SAVED,
  AUTOSAVE_UNCHANGED,
  autosaveFailed,
  type AutosaveResult,
} from '@/components/sections/shared/SettingsAutosave';
import {
  BUILTIN_ACTIONS,
  EFFECTS,
  OPENCHAMBER_ACTIONS,
  cloneModel,
  effectiveEffect,
  emptyModel,
  modelsEqual,
  parseRules,
  serializeRules,
  type KeyState,
  type PermissionModel,
} from './agentPermissionModel';

/**
 * Tool permissions for one agent.
 *
 * One row per tool: the tool's name, an arrow with what OpenCode will actually
 * do for it right now, and inherit / allow / ask / deny. "Inherit" means the
 * agent says nothing about the tool, so OpenCode's defaults and the global
 * config decide (that is what the arrow shows). A row expands to resource
 * patterns for that tool (`git push *` → deny).
 *
 * Under the hood v2 keeps an ordered rule list where the last match wins;
 * `agentPermissionModel.ts` translates this view to and from that list and
 * applies edits to the stored list in place, so what the user did not touch
 * keeps deciding exactly as before. Saving PATCHes only
 * `{ permissions }`. There is no Save button: a chip writes straight away, a
 * pattern writes when it loses focus. The write is its own request but the
 * page owns the autosave: `AgentsPage` registers this section's save routine
 * through `registerSave` and runs it as part of its own.
 */

const formatKeyLabel = (key: string): string =>
  key
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

/** Tools whose rules commonly need resource patterns; others can still add them. */
const PATTERN_HINT_ACTIONS: ReadonlySet<string> = new Set([
  'shell',
  'edit',
  'read',
  'glob',
  'grep',
  'patch',
  'webfetch',
  'skill',
  'subagent',
  'external_directory',
]);

const EMPTY_KEY: KeyState = { effect: null, patterns: [] };

interface AgentPermissionsEditorProps {
  agent: AgentWithExtras;
  /**
   * Hand the page this section's save routine. It is called on mount and
   * whenever the routine changes, and with `null` on unmount.
   */
  registerSave: (save: (() => Promise<AutosaveResult>) | null) => void;
  /** The page's autosave request; this section never runs its own. */
  requestSave: () => void;
}

export const AgentPermissionsEditor: React.FC<AgentPermissionsEditorProps> = ({
  agent,
  registerSave,
  requestSave,
}) => {
  const { t } = useI18n();
  const updateAgent = useAgentsStore((state) => state.updateAgent);
  const fetchAgentPermissions = useAgentsStore((state) => state.fetchAgentPermissions);

  const [globalRules, setGlobalRules] = React.useState<PermissionRule[]>([]);
  const [baseline, setBaseline] = React.useState<PermissionModel>(emptyModel);
  const [model, setModel] = React.useState<PermissionModel>(emptyModel);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [expandedKeys, setExpandedKeys] = React.useState<Record<string, boolean>>({});
  const [customKeyDraft, setCustomKeyDraft] = React.useState('');
  const [reloadToken, setReloadToken] = React.useState(0);

  const agentName = agent.name;
  // Settings browses whichever project its own selector points at; the app
  // stays where it is.
  const settingsDirectory = useSettingsDirectory();

  // MCP servers from the config (not only the connected ones): a permission on
  // a server is worth setting even while it is disabled or failing. Each server
  // gets one row keyed `<server>_*`, which OpenCode matches against every tool
  // the server exposes (`<server>_<tool>`).
  const loadMcpConfigs = useMcpConfigStore((state) => state.loadMcpConfigs);
  const mcpServers = useMcpConfigStore((state) => selectMcpServersForDirectory(state, settingsDirectory));
  const mcpStatus = useMcpStore(
    React.useCallback((state) => state.getStatusForDirectory(settingsDirectory), [settingsDirectory]),
  );
  React.useEffect(() => {
    void loadMcpConfigs({ directory: settingsDirectory });
  }, [loadMcpConfigs, settingsDirectory]);

  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadFailed(false);
    void (async () => {
      const envelope = await fetchAgentPermissions(agentName, settingsDirectory);
      if (cancelled) return;
      if (!envelope) {
        setLoadFailed(true);
        setIsLoading(false);
        return;
      }
      const parsed = parseRules(envelope.agent);
      setGlobalRules(envelope.global);
      setBaseline(cloneModel(parsed));
      setModel(parsed);
      setExpandedKeys({});
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [agentName, fetchAgentPermissions, reloadToken, settingsDirectory]);

  const save = React.useCallback(async (): Promise<AutosaveResult> => {
    if (modelsEqual(model, baseline)) return AUTOSAVE_UNCHANGED;
    const result = await updateAgent(agentName, { permissions: serializeRules(model) }, settingsDirectory);
    if (!result.ok) {
      return autosaveFailed(t('settings.agents.page.permissionsEditor.toast.saveFailed'));
    }
    setBaseline(cloneModel(model));
    return AUTOSAVE_SAVED;
  }, [agentName, baseline, model, settingsDirectory, t, updateAgent]);

  React.useEffect(() => {
    registerSave(save);
    return () => registerSave(null);
  }, [registerSave, save]);

  // --- Rows: built-in and OpenChamber tools, then one row per MCP server, then
  // whatever else the agent already names (custom keys, single MCP tools). ---
  const mcpKeys = React.useMemo(
    () => mcpServers.map((server) => ({ key: `${server.name}_*`, server: server.name })),
    [mcpServers],
  );
  const toolKeys = React.useMemo(() => {
    const keys: string[] = [...BUILTIN_ACTIONS, ...OPENCHAMBER_ACTIONS];
    const mcp = new Set(mcpKeys.map((entry) => entry.key));
    for (const key of Object.keys(model.keys)) {
      if (!keys.includes(key) && !mcp.has(key)) keys.push(key);
    }
    return keys;
  }, [mcpKeys, model.keys]);

  const mcpStatusLabel = (server: string): string | null => {
    const status = mcpStatus?.[server]?.status.status;
    switch (status) {
      case 'connected':
        return t('settings.mcp.page.status.label.connected');
      case 'failed':
        return t('settings.mcp.page.status.label.failed');
      case 'needs_auth':
        return t('settings.mcp.page.status.label.needsAuth');
      case 'disabled':
        return t('settings.agents.page.permissionsEditor.mcpStatus.disabled');
      case 'pending':
        return t('settings.agents.page.permissionsEditor.mcpStatus.pending');
      default:
        return null;
    }
  };

  const effectiveFor = React.useCallback(
    (key: string): PermissionEffect => effectiveEffect(key, { global: globalRules, agentGlobal: model.global }),
    [globalRules, model.global],
  );

  // --- Mutators. Chips save at once; patterns save on blur through the page. ---
  const setGlobal = (effect: PermissionEffect | null) => {
    setModel((current) => ({ ...current, global: effect }));
    requestSave();
  };

  const setKeyEffect = (key: string, effect: PermissionEffect | null) => {
    setModel((current) => {
      const next = cloneModel(current);
      const state = next.keys[key] ?? { effect: null, patterns: [] };
      state.effect = effect;
      if (state.effect === null && state.patterns.length === 0) delete next.keys[key];
      else next.keys[key] = state;
      return next;
    });
    requestSave();
  };

  const setPattern = (key: string, index: number, pattern: string, effect: PermissionEffect, saveNow: boolean) => {
    setModel((current) => {
      const next = cloneModel(current);
      const state = next.keys[key] ?? { effect: null, patterns: [] };
      state.patterns[index] = { pattern, effect };
      next.keys[key] = state;
      return next;
    });
    if (saveNow) requestSave();
  };

  const addPattern = (key: string) => {
    setModel((current) => {
      const next = cloneModel(current);
      const state = next.keys[key] ?? { effect: null, patterns: [] };
      state.patterns.push({ pattern: '', effect: 'allow' });
      next.keys[key] = state;
      return next;
    });
    setExpandedKeys((current) => ({ ...current, [key]: true }));
  };

  const removePattern = (key: string, index: number) => {
    setModel((current) => {
      const next = cloneModel(current);
      const state = next.keys[key];
      if (!state) return current;
      state.patterns.splice(index, 1);
      if (state.effect === null && state.patterns.length === 0) delete next.keys[key];
      return next;
    });
    requestSave();
  };

  const addCustomKey = () => {
    const key = customKeyDraft.trim();
    if (!key || key === '*') return;
    setModel((current) => {
      if (current.keys[key]) return current;
      const next = cloneModel(current);
      next.keys[key] = { effect: 'ask', patterns: [] };
      return next;
    });
    setCustomKeyDraft('');
    requestSave();
  };

  const effectLabel = (effect: PermissionEffect): string => t(
    effect === 'allow'
      ? 'settings.agents.page.permissionsEditor.action.allow'
      : effect === 'ask'
        ? 'settings.agents.page.permissionsEditor.action.ask'
        : 'settings.agents.page.permissionsEditor.action.deny',
  );

  const inheritLabel = t('settings.agents.page.permissionsEditor.action.inherit');
  const defaultChipLabel = t('settings.agents.page.permissionsEditor.action.default');

  const chipOptions = (unsetLabel?: string) => [
    ...(unsetLabel ? [{ value: 'inherit', label: unsetLabel }] : []),
    ...EFFECTS.map((effect) => ({ value: effect, label: effectLabel(effect) })),
  ];

  const renderEffectChips = (
    value: PermissionEffect | null,
    onChange: (effect: PermissionEffect | null) => void,
    ariaLabel: string,
    unsetLabel: string = inheritLabel,
  ) => (
    <SettingsChipGroup
      value={value ?? 'inherit'}
      options={chipOptions(unsetLabel)}
      // SAFETY: the chip group only emits the values it was given: `inherit`
      // or one of the three permission effects.
      onChange={(next) => onChange(next === 'inherit' ? null : (next as PermissionEffect))}
      aria-label={ariaLabel}
    />
  );

  if (isLoading) {
    return (
      <SettingsSection title={t('settings.agents.page.section.toolPermissions')}>
        <p className={SETTINGS_HELPER_CLASS}>{t('common.loading')}</p>
      </SettingsSection>
    );
  }

  if (loadFailed) {
    return (
      <SettingsSection title={t('settings.agents.page.section.toolPermissions')}>
        <div className="flex items-center gap-3">
          <p className="typography-meta text-[var(--status-error)]">
            {t('settings.agents.page.permissionsEditor.state.loadFailed')}
          </p>
          <Button variant="outline" size="xs" onClick={() => setReloadToken((token) => token + 1)}>
            {t('settings.agents.page.permissionsEditor.actions.retry')}
          </Button>
        </div>
      </SettingsSection>
    );
  }

  const renderRow = (key: string, label: string, statusLabel: string | null): React.ReactNode => {
    const state = model.keys[key] ?? EMPTY_KEY;
    const supportsPatterns = PATTERN_HINT_ACTIONS.has(key) || state.patterns.length > 0;
    const isExpanded = expandedKeys[key] === true;

    return (
      <div key={key} className="border-t border-border/40 py-2">
        <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:justify-between">
          <button
            type="button"
            onClick={supportsPatterns ? () => setExpandedKeys((current) => ({ ...current, [key]: !isExpanded })) : undefined}
            className={cn('flex min-w-0 items-center gap-1.5 text-left', !supportsPatterns && 'cursor-default')}
            aria-expanded={supportsPatterns ? isExpanded : undefined}
          >
            <Icon
              name={isExpanded && supportsPatterns ? 'arrow-down-s' : 'arrow-right-s'}
              className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', !supportsPatterns && 'opacity-0')}
            />
            <span className={SETTINGS_FIELD_LABEL_CLASS}>{label}</span>
            <span className="typography-micro font-mono text-muted-foreground/70">{key}</span>
            {statusLabel && (
              <span className="typography-micro rounded bg-muted px-1 text-muted-foreground">{statusLabel}</span>
            )}
            {state.effect === null && (
              <span className="typography-micro text-muted-foreground">
                {t('settings.agents.page.permissionsEditor.effectiveHint', { action: effectLabel(effectiveFor(key)) })}
              </span>
            )}
            {state.patterns.length > 0 && (
              <span className="typography-micro rounded bg-muted px-1 text-muted-foreground">
                {t('settings.agents.page.permissionsEditor.ruleCount', { count: String(state.patterns.length) })}
              </span>
            )}
          </button>
          {renderEffectChips(
            state.effect,
            (effect) => setKeyEffect(key, effect),
            t('settings.agents.page.permissionsEditor.keyAria', { key }),
          )}
        </div>

        {isExpanded && supportsPatterns && (
          <div className="mt-2 space-y-2 pl-5">
            {state.patterns.map((rule, index) => (
              <div key={index} className="flex flex-wrap items-center gap-2">
                <Input
                  value={rule.pattern}
                  onChange={(event) => setPattern(key, index, event.target.value, rule.effect, false)}
                  placeholder={t('settings.agents.page.permissionsEditor.patternPlaceholder')}
                  aria-label={t('settings.agents.page.permissionsEditor.patternActionAria', { key })}
                  className="h-8 w-full max-w-[24rem] min-w-0 flex-1 font-mono text-xs"
                />
                <SettingsChipGroup
                  value={rule.effect}
                  options={chipOptions()}
                  // SAFETY: the chip group only emits the values it was
                  // given, and those are exactly the three effects.
                  onChange={(next) => setPattern(key, index, rule.pattern, next as PermissionEffect, true)}
                  aria-label={t('settings.agents.page.permissionsEditor.patternActionAria', { key })}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => removePattern(key, index)}
                  aria-label={t('settings.agents.page.permissionsEditor.actions.removeRuleAria')}
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <Button variant="outline" size="xs" className="!font-normal" onClick={() => addPattern(key)}>
              <Icon name="add" className="mr-1 h-3.5 w-3.5" />
              {t('settings.agents.page.permissionsEditor.actions.addRule')}
            </Button>
          </div>
        )}
      </div>
    );
  };

  return (
    <SettingsSection
      title={t('settings.agents.page.section.toolPermissions')}
      settingsItem="agents.permissions"
      info={t('settings.agents.page.permissionsEditor.sectionInfo')}
      contentClassName="space-y-4"
    >
      {/* The agent's own fallback for every tool (its `*` rule). */}
      <div className="flex flex-col gap-2 pb-2 @xl:flex-row @xl:items-center @xl:justify-between">
        <div className="flex items-center gap-1.5">
          <span className={SETTINGS_FIELD_LABEL_CLASS}>
            {t('settings.agents.page.permissionsEditor.defaultLabel')}
          </span>
          <SettingsInfoHint>{t('settings.agents.page.permissionsEditor.defaultInfo')}</SettingsInfoHint>
          {model.global === null && (
            <span className="typography-micro text-muted-foreground">
              {t('settings.agents.page.permissionsEditor.effectiveHint', { action: effectLabel(effectiveFor('*')) })}
            </span>
          )}
        </div>
        {renderEffectChips(model.global, setGlobal, t('settings.agents.page.permissionsEditor.defaultAria'), defaultChipLabel)}
      </div>

      <div>
        {toolKeys.map((key) => renderRow(key, formatKeyLabel(key), null))}
      </div>

      {mcpKeys.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 border-t border-border/40 pt-3 pb-1">
            <span className={SETTINGS_FIELD_LABEL_CLASS}>{t('settings.agents.page.permissionsEditor.mcpTitle')}</span>
            <SettingsInfoHint>{t('settings.agents.page.permissionsEditor.mcpInfo')}</SettingsInfoHint>
          </div>
          {mcpKeys.map((entry) => renderRow(entry.key, entry.server, mcpStatusLabel(entry.server)))}
        </div>
      )}
      {/* A tool the list does not know yet (an MCP or plugin tool). */}
      <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-3">
        <Input
          value={customKeyDraft}
          onChange={(event) => setCustomKeyDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              addCustomKey();
            }
          }}
          placeholder={t('settings.agents.page.permissionsEditor.customKeyPlaceholder')}
          className="h-8 w-full max-w-[16rem] font-mono text-xs"
        />
        <Button variant="outline" size="xs" className="!font-normal" onClick={addCustomKey} disabled={!customKeyDraft.trim()}>
          <Icon name="add" className="mr-1 h-3.5 w-3.5" />
          {t('settings.agents.page.permissionsEditor.actions.addKey')}
        </Button>
      </div>
    </SettingsSection>
  );
};
