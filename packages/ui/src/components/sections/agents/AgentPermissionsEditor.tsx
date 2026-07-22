import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import {
  useAgentsStore,
  getConfigDirectory,
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
  ACTIONS,
  cloneModel,
  emptyModel,
  isAction,
  modelsEqual,
  parsePermissionConfig,
  serializePermissionModel,
  type Action,
  type EffectiveRule,
  type PermissionModel,
} from './agentPermissionModel';

/**
 * Source-of-truth permissions editor.
 *
 * This component edits EXACTLY the agent's own `permission` map as stored in
 * its markdown frontmatter / opencode.json entry — never the resolved rules
 * that `/agent` returns (those already include global config and one-off
 * session grants, and writing them back is what used to corrupt configs).
 *
 * - "Inherit" means the key is absent from the agent's config; the effective
 *   action (from the resolved view) is shown as a hint.
 * - Saving PATCHes only `{ permission }`, and the server writes it verbatim.
 */


/**
 * Permission keys that exist beyond plain tool ids (virtual capabilities).
 * Shown so they are discoverable; nothing is written unless set explicitly.
 */
const VIRTUAL_PERMISSION_KEYS = [
  'edit',
  'external_directory',
  'doom_loop',
  'plan_enter',
  'plan_exit',
] as const;

/**
 * Keys where opencode matches pattern rules (per docs: these accept either a
 * bare action or a pattern map). Everything else is action-only — the pattern
 * UI is hidden unless the config already contains patterns for the key.
 */
const PATTERN_CAPABLE_KEYS = new Set([
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'lsp',
  'skill',
]);

/** Tool ids folded into broader permission keys — never shown standalone. */
const FOLDED_TOOL_IDS = new Set(['write', 'patch', 'apply_patch', 'multiedit', 'invalid']);

const formatKeyLabel = (key: string): string =>
  key
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');

interface AgentPermissionsEditorProps {
  agent: AgentWithExtras;
}

export const AgentPermissionsEditor: React.FC<AgentPermissionsEditorProps> = ({ agent }) => {
  const { t } = useI18n();
  const updateAgent = useAgentsStore((state) => state.updateAgent);

  const [baseline, setBaseline] = React.useState<PermissionModel>(emptyModel);
  const [model, setModel] = React.useState<PermissionModel>(emptyModel);
  const [isLoading, setIsLoading] = React.useState(true);
  const [loadFailed, setLoadFailed] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const [expandedKeys, setExpandedKeys] = React.useState<Record<string, boolean>>({});
  const [toolIds, setToolIds] = React.useState<string[]>([]);
  const [customKeyDraft, setCustomKeyDraft] = React.useState('');
  const [reloadToken, setReloadToken] = React.useState(0);

  const agentName = agent.name;

  // --- Load the SOURCE permission map (the agent's own config file). ---
  React.useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const directory = getConfigDirectory();
        const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
        const response = await runtimeFetch(`/api/config/agents/${encodeURIComponent(agentName)}/config${query}`, {
          headers: {
            'Cache-Control': 'no-cache',
            ...(directory ? { 'x-opencode-directory': directory } : {}),
          },
        });
        if (!response.ok) throw new Error(String(response.status));
        const data = (await response.json().catch(() => null)) as { config?: { permission?: unknown } } | null;
        if (cancelled) return;
        const parsed = parsePermissionConfig(data?.config?.permission);
        setBaseline(cloneModel(parsed));
        setModel(parsed);
      } catch {
        if (!cancelled) setLoadFailed(true);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentName, reloadToken]);

  // --- Known tool ids for the key list (display only). ---
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ids = await opencodeClient.listToolIds({ directory: getConfigDirectory() });
        if (!cancelled && Array.isArray(ids)) {
          setToolIds(ids.filter((id) => typeof id === 'string' && !FOLDED_TOOL_IDS.has(id)));
        }
      } catch {
        // tool ids are additive display data — the editor works without them
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agentName]);

  // --- Effective rules from the resolved view (read-only hints). ---
  const effectiveRules = React.useMemo<EffectiveRule[]>(() => {
    const raw = (agent as { permission?: unknown }).permission;
    if (!Array.isArray(raw)) return [];
    const rules: EffectiveRule[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const { permission, pattern, action } = entry as Record<string, unknown>;
      if (typeof permission === 'string' && typeof pattern === 'string' && isAction(action)) {
        rules.push({ permission, pattern, action });
      }
    }
    return rules;
  }, [agent]);

  const effectiveFor = React.useCallback((key: string): Action | null => {
    const exact = effectiveRules.find((rule) => rule.permission === key && rule.pattern === '*');
    if (exact) return exact.action;
    const wildcard = effectiveRules.find((rule) => rule.permission === '*' && rule.pattern === '*');
    return wildcard ? wildcard.action : null;
  }, [effectiveRules]);

  /** Session/runtime-granted rules that are NOT part of the saved config. */
  const runtimeRulesFor = React.useCallback((key: string): EffectiveRule[] => {
    const saved = model.keys[key]?.patterns ?? [];
    const savedPatterns = new Set(saved.map((rule) => rule.pattern));
    return effectiveRules.filter(
      (rule) => rule.permission === key && rule.pattern !== '*' && !savedPatterns.has(rule.pattern),
    );
  }, [effectiveRules, model.keys]);

  // --- Displayed key list: tools + virtual keys + anything set in the config. ---
  const displayKeys = React.useMemo(() => {
    const keys = new Set<string>();
    for (const id of toolIds) keys.add(id);
    for (const key of VIRTUAL_PERMISSION_KEYS) keys.add(key);
    for (const key of Object.keys(model.keys)) keys.add(key);
    // `edit` covers write/edit/apply_patch — the folded ids never show.
    for (const folded of FOLDED_TOOL_IDS) keys.delete(folded);
    return Array.from(keys).sort((a, b) => a.localeCompare(b));
  }, [toolIds, model.keys]);

  const isDirty = React.useMemo(() => !modelsEqual(model, baseline), [model, baseline]);

  // --- Mutators ---
  const setGlobal = (action: Action | null) => {
    setModel((current) => ({ ...current, global: action }));
  };

  const setKeyAction = (key: string, action: Action | null) => {
    setModel((current) => {
      const next = cloneModel(current);
      const state = next.keys[key] ?? { action: null, patterns: [] };
      state.action = action;
      if (state.action === null && state.patterns.length === 0) {
        delete next.keys[key];
      } else {
        next.keys[key] = state;
      }
      return next;
    });
  };

  const setPattern = (key: string, index: number, pattern: string, action: Action) => {
    setModel((current) => {
      const next = cloneModel(current);
      const state = next.keys[key] ?? { action: null, patterns: [] };
      state.patterns[index] = { pattern, action };
      next.keys[key] = state;
      return next;
    });
  };

  const addPattern = (key: string) => {
    setModel((current) => {
      const next = cloneModel(current);
      const state = next.keys[key] ?? { action: null, patterns: [] };
      state.patterns.push({ pattern: '', action: 'allow' });
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
      if (state.action === null && state.patterns.length === 0) {
        delete next.keys[key];
      }
      return next;
    });
  };

  const addCustomKey = () => {
    const key = customKeyDraft.trim();
    if (!key || key === '*') return;
    setModel((current) => {
      if (current.keys[key]) return current;
      const next = cloneModel(current);
      next.keys[key] = { action: 'ask', patterns: [] };
      return next;
    });
    setExpandedKeys((current) => ({ ...current, [key]: true }));
    setCustomKeyDraft('');
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const permission = serializePermissionModel(model);
      const result = await updateAgent(agentName, { permission });
      if (result.ok) {
        setBaseline(cloneModel(model));
        toast.success(
          result.requiresManualRestart
            ? t('settings.agents.page.permissionsEditor.toast.savedRestartRequired')
            : t('settings.agents.page.permissionsEditor.toast.saved'),
        );
      } else {
        toast.error(t('settings.agents.page.permissionsEditor.toast.saveFailed'));
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDiscard = () => {
    setModel(cloneModel(baseline));
  };

  const actionLabel = (action: Action): string => t(
    action === 'allow'
      ? 'settings.agents.page.permissionsEditor.action.allow'
      : action === 'ask'
        ? 'settings.agents.page.permissionsEditor.action.ask'
        : 'settings.agents.page.permissionsEditor.action.deny',
  );

  const inheritLabel = t('settings.agents.page.permissionsEditor.action.inherit');
  const defaultChipLabel = t('settings.agents.page.permissionsEditor.action.default');

  const chipOptions = (unsetLabel?: string) => [
    ...(unsetLabel ? [{ value: 'inherit', label: unsetLabel }] : []),
    ...ACTIONS.map((action) => ({ value: action, label: actionLabel(action) })),
  ];

  const renderActionChips = (
    value: Action | null,
    onChange: (action: Action | null) => void,
    ariaLabel: string,
    unsetLabel: string = inheritLabel,
  ) => (
    <SettingsChipGroup
      value={value ?? 'inherit'}
      options={chipOptions(unsetLabel)}
      onChange={(next) => onChange(next === 'inherit' ? null : (next as Action))}
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

  return (
    <SettingsSection
      title={t('settings.agents.page.section.toolPermissions')}
      settingsItem="agents.permissions"
      info={t('settings.agents.page.permissionsEditor.sectionInfo')}
      headerAction={isDirty ? (
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="xs" className="!font-normal" onClick={handleDiscard} disabled={isSaving}>
            {t('settings.agents.page.permissionsEditor.actions.discard')}
          </Button>
          <Button size="xs" className="!font-normal" onClick={() => void handleSave()} disabled={isSaving}>
            {isSaving ? t('settings.common.actions.saving') : t('settings.agents.page.permissionsEditor.actions.save')}
          </Button>
        </div>
      ) : undefined}
      contentClassName="space-y-4"
    >
      {/* Agent default (the `*` key) */}
      <div className="flex flex-col gap-2 pb-2 @xl:flex-row @xl:items-center @xl:justify-between">
        <div className="flex items-center gap-1.5">
          <span className={SETTINGS_FIELD_LABEL_CLASS}>
            {t('settings.agents.page.permissionsEditor.defaultLabel')}
          </span>
          <SettingsInfoHint>{t('settings.agents.page.permissionsEditor.defaultInfo')}</SettingsInfoHint>
          {model.global === null && (
            <span className="typography-micro text-muted-foreground">
              {t('settings.agents.page.permissionsEditor.effectiveHint', { action: actionLabel(effectiveFor('*') ?? 'allow') })}
            </span>
          )}
        </div>
        {renderActionChips(model.global, setGlobal, t('settings.agents.page.permissionsEditor.defaultAria'), defaultChipLabel)}
      </div>

      <div>
        {displayKeys.map((key) => {
          const state = model.keys[key] ?? { action: null, patterns: [] };
          const runtimeRules = runtimeRulesFor(key);
          const supportsPatterns = PATTERN_CAPABLE_KEYS.has(key) || state.patterns.length > 0;
          const hasDetails = supportsPatterns || runtimeRules.length > 0;
          const isExpanded = expandedKeys[key] === true;
          const effective = effectiveFor(key);

          return (
            <div key={key} className="border-t border-border/40 py-2">
              <div className="flex flex-col gap-2 @xl:flex-row @xl:items-center @xl:justify-between">
                <button
                  type="button"
                  onClick={hasDetails ? () => setExpandedKeys((current) => ({ ...current, [key]: !isExpanded })) : undefined}
                  className={cn('flex min-w-0 items-center gap-1.5 text-left', !hasDetails && 'cursor-default')}
                  aria-expanded={hasDetails ? isExpanded : undefined}
                >
                  <Icon
                    name={isExpanded && hasDetails ? 'arrow-down-s' : 'arrow-right-s'}
                    className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground', !hasDetails && 'opacity-0')}
                  />
                  <span className={SETTINGS_FIELD_LABEL_CLASS}>{formatKeyLabel(key)}</span>
                  <span className="typography-micro font-mono text-muted-foreground/70">{key}</span>
                  {state.action === null && effective !== null && (
                    <span className="typography-micro text-muted-foreground">
                      {t('settings.agents.page.permissionsEditor.effectiveHint', { action: actionLabel(effective) })}
                    </span>
                  )}
                  {state.patterns.length > 0 && (
                    <span className="typography-micro rounded bg-muted px-1 text-muted-foreground">
                      {t('settings.agents.page.permissionsEditor.ruleCount', { count: String(state.patterns.length) })}
                    </span>
                  )}
                </button>
                {renderActionChips(
                  state.action,
                  (action) => setKeyAction(key, action),
                  t('settings.agents.page.permissionsEditor.keyAria', { key }),
                )}
              </div>

              {isExpanded && hasDetails && (
                <div className="mt-2 space-y-2 pl-5">
                  {state.patterns.map((rule, index) => (
                    <div key={index} className="flex flex-wrap items-center gap-2">
                      <Input
                        value={rule.pattern}
                        onChange={(event) => setPattern(key, index, event.target.value, rule.action)}
                        placeholder={t('settings.agents.page.permissionsEditor.patternPlaceholder')}
                        className="h-8 w-full max-w-[24rem] min-w-0 flex-1 font-mono text-xs"
                      />
                      <SettingsChipGroup
                        value={rule.action}
                        options={chipOptions()}
                        onChange={(next) => setPattern(key, index, rule.pattern, next as Action)}
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

                  {supportsPatterns && (
                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => addPattern(key)}>
                      <Icon name="add" className="mr-1 h-3.5 w-3.5" />
                      {t('settings.agents.page.permissionsEditor.actions.addRule')}
                    </Button>
                  )}

                  {runtimeRules.length > 0 && (
                    <div className="space-y-1 pt-1">
                      <div className="flex items-center gap-1.5">
                        <span className="typography-micro font-medium text-muted-foreground">
                          {t('settings.agents.page.permissionsEditor.sessionRulesTitle')}
                        </span>
                        <SettingsInfoHint>
                          {t('settings.agents.page.permissionsEditor.sessionRulesInfo')}
                        </SettingsInfoHint>
                      </div>
                      {runtimeRules.map((rule) => (
                        <div key={`${rule.pattern}-${rule.action}`} className="flex items-center gap-2">
                          <span className="typography-micro min-w-0 flex-1 truncate font-mono text-muted-foreground/70">
                            {rule.pattern}
                          </span>
                          <span className="typography-micro text-muted-foreground">{actionLabel(rule.action)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Custom permission key */}
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
