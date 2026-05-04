import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumberInput } from '@/components/ui/number-input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useAgentsStore, type AgentConfig, type AgentScope } from '@/stores/useAgentsStore';
import { useShallow } from 'zustand/react/shallow';
import { useDirectorySync } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useDeviceInfo } from '@/lib/device';
import { opencodeClient } from '@/lib/opencode/client';
import { RiCloseLine, RiInformationLine, RiRobot2Line, RiSubtractLine, RiUser3Line, RiFolderLine } from '@remixicon/react';
import { cn } from '@/lib/utils';
import { ModelSelector } from './ModelSelector';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRule = { permission: string; pattern: string; action: PermissionAction };
type PermissionConfigValue = PermissionAction | Record<string, PermissionAction>;
type PermissionRuleKey = `${string}::${string}`;

const STANDARD_PERMISSION_KEYS = [
  '*',
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'skill',
  'lsp',
  'todoread',
  'todowrite',
  'webfetch',
  'websearch',
  'codesearch',
  'external_directory',
  'doom_loop',
  'question',
  'plan_enter',
  'plan_exit',
] as const;

const isPermissionAction = (value: unknown): value is PermissionAction =>
  value === 'allow' || value === 'ask' || value === 'deny';

const buildRuleKey = (permission: string, pattern: string): PermissionRuleKey =>
  `${permission}::${pattern}`;

const normalizeRuleset = (ruleset: PermissionRule[]): PermissionRule[] => {
  const map = new Map<PermissionRuleKey, PermissionRule>();
  for (const rule of ruleset) {
    if (!rule.permission || rule.permission === 'invalid') {
      continue;
    }
    if (!rule.pattern) {
      continue;
    }
    if (!isPermissionAction(rule.action)) {
      continue;
    }
    map.set(buildRuleKey(rule.permission, rule.pattern), {
      permission: rule.permission,
      pattern: rule.pattern,
      action: rule.action,
    });
  }
  return Array.from(map.values());
};

const buildRuleMap = (ruleset: PermissionRule[]): Map<PermissionRuleKey, PermissionRule> => {
  const map = new Map<PermissionRuleKey, PermissionRule>();
  for (const rule of normalizeRuleset(ruleset)) {
    map.set(buildRuleKey(rule.permission, rule.pattern), rule);
  }
  return map;
};

const sortRules = (ruleset: PermissionRule[]): PermissionRule[] =>
  [...ruleset].sort((a, b) => {
    const permissionCompare = a.permission.localeCompare(b.permission);
    if (permissionCompare !== 0) return permissionCompare;
    return a.pattern.localeCompare(b.pattern);
  });

const areRulesEqual = (a: PermissionRule[], b: PermissionRule[]): boolean => {
  const sortedA = sortRules(normalizeRuleset(a));
  const sortedB = sortRules(normalizeRuleset(b));
  if (sortedA.length !== sortedB.length) {
    return false;
  }
  return sortedA.every((rule, index) => {
    const other = sortedB[index];
    return rule.permission === other.permission
      && rule.pattern === other.pattern
      && rule.action === other.action;
  });
};

const getGlobalWildcardAction = (ruleset: PermissionRule[]): PermissionAction => {
  const globalRule = ruleset.find((rule) => rule.permission === '*' && rule.pattern === '*');
  return globalRule?.action ?? 'allow';
};

const filterRulesAgainstGlobal = (ruleset: PermissionRule[], globalAction: PermissionAction): PermissionRule[] => (
  normalizeRuleset(ruleset)
    .filter((rule) => !(rule.permission === '*' && rule.pattern === '*'))
    // Keep wildcard overrides only when they differ from global.
    .filter((rule) => rule.pattern !== '*' || rule.action !== globalAction)
);

const permissionConfigToRuleset = (value: unknown): PermissionRule[] => {
  if (isPermissionAction(value)) {
    return [{ permission: '*', pattern: '*', action: value }];
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [];
  }

  const rules: PermissionRule[] = [];
  for (const [permissionName, configValue] of Object.entries(value as Record<string, unknown>)) {
    if (permissionName === '__originalKeys') {
      continue;
    }
    if (isPermissionAction(configValue)) {
      rules.push({ permission: permissionName, pattern: '*', action: configValue });
      continue;
    }
    if (configValue && typeof configValue === 'object' && !Array.isArray(configValue)) {
      for (const [pattern, action] of Object.entries(configValue as Record<string, unknown>)) {
        if (isPermissionAction(action)) {
          rules.push({ permission: permissionName, pattern, action });
        }
      }
    }
  }

  return rules;
};

const buildPermissionConfigWithGlobal = (
  globalAction: PermissionAction,
  ruleset: PermissionRule[],
): AgentConfig['permission'] => {
  const normalized = normalizeRuleset(ruleset);
  const grouped: Record<string, Record<string, PermissionAction>> = {};

  for (const rule of normalized) {
    (grouped[rule.permission] ||= {})[rule.pattern] = rule.action;
  }

  const result: Record<string, PermissionConfigValue> = {
    '*': globalAction,
  };

  for (const [permissionName, patterns] of Object.entries(grouped)) {
    if (permissionName === '*') {
      continue;
    }

    if (Object.keys(patterns).length === 1 && patterns['*']) {
      result[permissionName] = patterns['*'];
      continue;
    }

    result[permissionName] = patterns;
  }

  return result as AgentConfig['permission'];
};


export const AgentsPage: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const {
    selectedAgentName,
    getAgentByName,
    createAgent,
    updateAgent,
    agents,
    agentDraft,
    setAgentDraft,
  } = useAgentsStore(useShallow((s) => ({
    selectedAgentName: s.selectedAgentName,
    getAgentByName: s.getAgentByName,
    createAgent: s.createAgent,
    updateAgent: s.updateAgent,
    agents: s.agents,
    agentDraft: s.agentDraft,
    setAgentDraft: s.setAgentDraft,
  })));

  const selectedAgent = selectedAgentName ? getAgentByName(selectedAgentName) : null;
  const isNewAgent = Boolean(agentDraft && agentDraft.name === selectedAgentName && !selectedAgent);

  const [draftName, setDraftName] = React.useState('');
  const [draftScope, setDraftScope] = React.useState<AgentScope>('user');
  const [description, setDescription] = React.useState('');
  const [mode, setMode] = React.useState<'primary' | 'subagent' | 'all'>('subagent');
  const [model, setModel] = React.useState('');
  const [temperature, setTemperature] = React.useState<number | undefined>(undefined);
  const [topP, setTopP] = React.useState<number | undefined>(undefined);
  const [prompt, setPrompt] = React.useState('');
  const [globalPermission, setGlobalPermission] = React.useState<PermissionAction>('allow');
  const [permissionBaseline, setPermissionBaseline] = React.useState<PermissionRule[]>([]);
  const [permissionRules, setPermissionRules] = React.useState<PermissionRule[]>([]);
  const [pendingRuleName, setPendingRuleName] = React.useState('');
  const [pendingRulePattern, setPendingRulePattern] = React.useState('*');
  const [showPermissionEditor, setShowPermissionEditor] = React.useState(false);
  const [isSaving, setIsSaving] = React.useState(false);
  const initialStateRef = React.useRef<{
    draftName: string;
    draftScope: AgentScope;
    description: string;
    mode: 'primary' | 'subagent' | 'all';
    model: string;
    temperature: number | undefined;
    topP: number | undefined;
    prompt: string;
    globalPermission: PermissionAction;
    permissionRules: PermissionRule[];
  } | null>(null);

  const currentDirectory = useDirectoryStore((state) => state.currentDirectory ?? null);
  const [toolIds, setToolIds] = React.useState<string[]>([]);

  const permissionsBySession = useDirectorySync((state) => state.permission);

  React.useEffect(() => {
    let cancelled = false;

    const fetchToolIds = async () => {
      const ids = await opencodeClient.listToolIds({ directory: currentDirectory });
      if (cancelled) {
        return;
      }

      // OpenCode permissions are keyed by tool name, but some tools are grouped
      // under a single permission key. E.g. `edit` covers `write`, `patch`, and `multiedit`.
      const editCoveredToolIds = new Set(['write', 'patch', 'multiedit']);

      const normalized = ids
        .map((id) => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
        .filter((id) => id !== '*')
        .filter((id) => id !== 'invalid')
        .filter((id) => !editCoveredToolIds.has(id));

      setToolIds(Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b)));
    };

    void fetchToolIds();

    return () => {
      cancelled = true;
    };
  }, [currentDirectory]);

  const knownPermissionNames = React.useMemo(() => {
    const names = new Set<string>();

    for (const agent of agents) {
      const rules = normalizeRuleset(Array.isArray(agent.permission) ? agent.permission as PermissionRule[] : []);
      for (const rule of rules) {
        if (rule.permission && rule.permission !== '*' && rule.permission !== 'invalid') {
          names.add(rule.permission);
        }
      }
    }

    for (const permissions of Object.values(permissionsBySession)) {
      for (const request of permissions) {
        const permissionName = request.permission?.trim();
        if (permissionName && permissionName !== 'invalid') {
          names.add(permissionName);
        }
      }
    }

    for (const toolId of toolIds) {
      names.add(toolId);
    }

    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [agents, permissionsBySession, toolIds]);

  const baselineRuleMap = React.useMemo(() => buildRuleMap(permissionBaseline), [permissionBaseline]);
  const currentRuleMap = React.useMemo(() => buildRuleMap(permissionRules), [permissionRules]);

  const getWildcardOverride = React.useCallback((permissionName: string): PermissionAction | undefined => (
    currentRuleMap.get(buildRuleKey(permissionName, '*'))?.action
  ), [currentRuleMap]);


  const getPatternRules = React.useCallback((permissionName: string): PermissionRule[] => (
    permissionRules
      .filter((rule) => rule.permission === permissionName && rule.pattern !== '*')
      .sort((a, b) => a.pattern.localeCompare(b.pattern))
  ), [permissionRules]);

  const summaryPermissionNames = React.useMemo(() => {
    const names = new Set<string>();
    for (const key of STANDARD_PERMISSION_KEYS) {
      names.add(key);
    }
    for (const key of knownPermissionNames) {
      names.add(key);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [knownPermissionNames]);


  const getPermissionSummary = React.useCallback((permissionName: string) => {
    const defaultAction = permissionName === '*'
      ? globalPermission
      : (getWildcardOverride(permissionName) ?? globalPermission);
    const patternRules = getPatternRules(permissionName);
    const hasDefaultHint = false;
    const patternCounts = patternRules.reduce<Record<PermissionAction, number>>((acc, rule) => {
      acc[rule.action] = (acc[rule.action] ?? 0) + 1;
      return acc;
    }, { allow: 0, ask: 0, deny: 0 });
    const patternSummary = (['allow', 'ask', 'deny'] as const)
      .filter((action) => patternCounts[action] > 0)
      .map((action) => `${patternCounts[action]} ${action}`)
      .join(', ');
    return {
      defaultAction,
      patternRulesCount: patternRules.length,
      patternSummary,
      hasDefaultHint,
    };
  }, [getPatternRules, getWildcardOverride, globalPermission]);
  const permissionActionLabel = React.useCallback((value: PermissionAction): string => {
    if (value === 'allow') return t('settings.common.permission.allow');
    if (value === 'deny') return t('settings.common.permission.deny');
    return t('settings.common.permission.ask');
  }, [t]);
  const permissionScopeLabel = React.useCallback((value: PermissionAction | 'global'): string => {
    if (value === 'global') return t('settings.common.scope.global');
    return permissionActionLabel(value);
  }, [permissionActionLabel, t]);

  const availablePermissionNames = React.useMemo(() => {
    const names = new Set<string>();

    for (const key of STANDARD_PERMISSION_KEYS) {
      names.add(key);
    }

    for (const key of knownPermissionNames) {
      names.add(key);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [knownPermissionNames]);

  const upsertRule = React.useCallback((permissionName: string, pattern: string, action: PermissionAction) => {
    setPermissionRules((prev) => {
      const map = buildRuleMap(prev);
      map.set(buildRuleKey(permissionName, pattern), { permission: permissionName, pattern, action });
      return Array.from(map.values());
    });
  }, []);

  const removeRule = React.useCallback((permissionName: string, pattern: string) => {
    setPermissionRules((prev) => {
      const map = buildRuleMap(prev);
      map.delete(buildRuleKey(permissionName, pattern));
      return Array.from(map.values());
    });
  }, []);

  const revertRule = React.useCallback((permissionName: string, pattern: string) => {
    const baseline = baselineRuleMap.get(buildRuleKey(permissionName, pattern));
    if (baseline) {
      upsertRule(permissionName, pattern, baseline.action);
      return;
    }
    removeRule(permissionName, pattern);
  }, [baselineRuleMap, removeRule, upsertRule]);

  const setRuleAction = React.useCallback((permissionName: string, pattern: string, action: PermissionAction) => {
    upsertRule(permissionName, pattern, action);
  }, [upsertRule]);

  const setGlobalPermissionAndPrune = React.useCallback((next: PermissionAction) => {
    setGlobalPermission(next);
    setPermissionRules((prev) => prev.filter((rule) => !(rule.pattern === '*' && rule.action === next)));
  }, []);

  const applyPendingRule = React.useCallback((action: PermissionAction) => {
    const name = pendingRuleName.trim();
    if (!name) {
      toast.error(t('settings.agents.page.toast.permissionNameRequired'));
      return;
    }

    const pattern = pendingRulePattern.trim() || '*';
    if (name === '*' && pattern === '*') {
      setGlobalPermissionAndPrune(action);
      setPendingRuleName('');
      setPendingRulePattern('*');
      return;
    }
    if (pattern === '*' && name !== '*' && action === globalPermission) {
      removeRule(name, '*');
    } else {
      upsertRule(name, pattern, action);
    }
    setPendingRuleName('');
    setPendingRulePattern('*');
  }, [globalPermission, pendingRuleName, pendingRulePattern, removeRule, setGlobalPermissionAndPrune, t, upsertRule]);

  const formatPermissionLabel = React.useCallback((permissionName: string): string => {
    if (permissionName === '*') return t('settings.agents.page.permissions.defaultLabel');
    if (permissionName === 'webfetch') return 'WebFetch';
    if (permissionName === 'websearch') return 'WebSearch';
    if (permissionName === 'codesearch') return 'CodeSearch';
    if (permissionName === 'doom_loop') return 'Doom Loop';
    if (permissionName === 'external_directory') return 'External Directory';
    if (permissionName === 'todowrite') return 'TodoWrite';
    if (permissionName === 'todoread') return 'TodoRead';

    return permissionName
      .split(/[_-]+/g)
      .filter(Boolean)
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' ');
  }, [t]);

  React.useEffect(() => {
    setPendingRuleName('');
    setPendingRulePattern('*');

    const applyPermissionState = (rules: PermissionRule[]) => {
      const normalized = normalizeRuleset(rules);
      const nextGlobal = getGlobalWildcardAction(normalized);
      const filtered = filterRulesAgainstGlobal(normalized, nextGlobal);
      setGlobalPermission(nextGlobal);
      setPermissionBaseline(filtered);
      setPermissionRules(filtered);
      return { global: nextGlobal, rules: filtered };
    };

    if (isNewAgent && agentDraft) {
      const draftNameValue = agentDraft.name || '';
      const draftScopeValue = agentDraft.scope || 'user';
      const descriptionValue = agentDraft.description || '';
      const modeValue = agentDraft.mode || 'subagent';
      const modelValue = agentDraft.model || '';
      const temperatureValue = agentDraft.temperature;
      const topPValue = agentDraft.top_p;
      const promptValue = agentDraft.prompt || '';

      setDraftName(draftNameValue);
      setDraftScope(draftScopeValue);
      setDescription(descriptionValue);
      setMode(modeValue);
      setModel(modelValue);
      setTemperature(temperatureValue);
      setTopP(topPValue);
      setPrompt(promptValue);

      const parsedRules = permissionConfigToRuleset(agentDraft.permission);
      const permissionState = applyPermissionState(parsedRules);

      initialStateRef.current = {
        draftName: draftNameValue,
        draftScope: draftScopeValue,
        description: descriptionValue,
        mode: modeValue,
        model: modelValue,
        temperature: temperatureValue,
        topP: topPValue,
        prompt: promptValue,
        globalPermission: permissionState.global,
        permissionRules: permissionState.rules,
      };
      return;
    }

    if (selectedAgent && selectedAgentName === selectedAgent.name) {
      const descriptionValue = selectedAgent.description || '';
      const modeValue = selectedAgent.mode || 'subagent';
      const modelValue = selectedAgent.model?.providerID && selectedAgent.model?.modelID
        ? `${selectedAgent.model.providerID}/${selectedAgent.model.modelID}`
        : '';
      const temperatureValue = selectedAgent.temperature;
      const topPValue = selectedAgent.topP;
      const promptValue = selectedAgent.prompt || '';

      setDescription(descriptionValue);
      setMode(modeValue);

      setModel(modelValue);
      setTemperature(temperatureValue);
      setTopP(topPValue);
      setPrompt(promptValue);

      const permissionState = applyPermissionState(
        Array.isArray(selectedAgent.permission) ? selectedAgent.permission as PermissionRule[] : [],
      );

      initialStateRef.current = {
        draftName: '',
        draftScope: 'user',
        description: descriptionValue,
        mode: modeValue,
        model: modelValue,
        temperature: temperatureValue,
        topP: topPValue,
        prompt: promptValue,
        globalPermission: permissionState.global,
        permissionRules: permissionState.rules,
      };
    }
  }, [agentDraft, isNewAgent, selectedAgent, selectedAgentName]);

  const isDirty = React.useMemo(() => {
    const initial = initialStateRef.current;
    if (!initial) {
      return false;
    }

    if (isNewAgent) {
      if (draftName !== initial.draftName) return true;
      if (draftScope !== initial.draftScope) return true;
    }

    if (description !== initial.description) return true;
    if (mode !== initial.mode) return true;
    if (model !== initial.model) return true;
    if (temperature !== initial.temperature) return true;
    if (topP !== initial.topP) return true;
    if (prompt !== initial.prompt) return true;
    if (globalPermission !== initial.globalPermission) return true;
    if (!areRulesEqual(permissionRules, initial.permissionRules)) return true;

    return false;
  }, [description, draftName, draftScope, globalPermission, isNewAgent, mode, model, permissionRules, prompt, temperature, topP]);

  const handleSave = async () => {
    const agentName = isNewAgent ? draftName.trim().replace(/\s+/g, '-') : selectedAgentName?.trim();

    if (!agentName) {
      toast.error(t('settings.agents.sidebar.toast.agentNameRequired'));
      return;
    }

    // Check for duplicate name when creating new agent
    if (isNewAgent && agents.some((a) => a.name === agentName)) {
      toast.error(t('settings.agents.sidebar.toast.agentExists'));
      return;
    }

    setIsSaving(true);

    try {
      const trimmedModel = model.trim();
      const permissionConfig = buildPermissionConfigWithGlobal(globalPermission, permissionRules);
      const config: AgentConfig = {
        name: agentName,
        description: description.trim() || undefined,
        mode,
        model: trimmedModel === '' ? null : trimmedModel,
        temperature,
        top_p: topP,
        prompt: prompt.trim() || undefined,
        permission: permissionConfig,
        scope: isNewAgent ? draftScope : undefined,
      };

      let success: boolean;
      if (isNewAgent) {
        success = await createAgent(config);
        if (success) {
          setAgentDraft(null); // Clear draft after successful creation
        }
      } else {
        success = await updateAgent(agentName, config);
      }

      if (success) {
        toast.success(isNewAgent ? t('settings.agents.page.toast.created') : t('settings.agents.page.toast.updated'));
      } else {
        toast.error(isNewAgent ? t('settings.agents.page.toast.createFailed') : t('settings.agents.page.toast.updateFailed'));
      }
    } catch (error) {
      console.error('Error saving agent:', error);
      const message = error instanceof Error && error.message ? error.message : t('settings.agents.page.toast.saveUnexpectedError');
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };


  if (!selectedAgentName) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <RiRobot2Line className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.agents.page.empty.title')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.agents.page.empty.description')}</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header & Actions */}
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {isNewAgent ? t('settings.agents.page.title.new') : selectedAgentName}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              {isNewAgent ? t('settings.agents.page.subtitle.new') : t('settings.agents.page.subtitle.edit')}
            </p>
          </div>
        </div>

        {/* Identity & Role */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.agents.page.section.identityRole')}
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0">

            {isNewAgent && (
              <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
                <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                  <span className="typography-ui-label text-foreground">{t('settings.agents.page.field.agentName')}</span>
                </div>
                <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                  <div className="flex items-center">
                    <span className="typography-ui-label text-muted-foreground mr-1">@</span>
                    <Input
                      value={draftName}
                      onChange={(e) => setDraftName(e.target.value)}
                      placeholder={t('settings.agents.page.field.agentNamePlaceholder')}
                      className="h-7 w-40 px-2"
                    />
                  </div>
                  <Select value={draftScope} onValueChange={(v) => setDraftScope(v as AgentScope)}>
                    <SelectTrigger className="w-fit min-w-[100px]">
                      <SelectValue placeholder={t('settings.agents.page.field.scopePlaceholder')} />
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="user">
                        <div className="flex items-center gap-2">
                          <RiUser3Line className="h-3.5 w-3.5" />
                          <span>{t('settings.common.scope.global')}</span>
                        </div>
                      </SelectItem>
                      <SelectItem value="project">
                        <div className="flex items-center gap-2">
                          <RiFolderLine className="h-3.5 w-3.5" />
                          <span>{t('settings.common.scope.project')}</span>
                        </div>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}

            <div className="py-1.5">
              <span className="typography-ui-label text-foreground">{t('settings.common.field.description')}</span>
              <div className="mt-1.5">
                <Textarea
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder={t('settings.agents.page.field.descriptionPlaceholder')}
                  rows={2}
                  className="w-full resize-none min-h-[60px] bg-transparent"
                />
              </div>
            </div>

            <div className="pb-1.5 pt-0.5">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex items-center gap-1.5">
                  <span className="typography-ui-label text-foreground">{t('settings.agents.page.field.mode')}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      {t('settings.agents.page.field.modeTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <div className="flex flex-wrap items-center gap-1">
                <Button
                  variant="chip"
                  size="xs"
                  aria-pressed={mode === 'primary'}
                  onClick={() => setMode('primary')}
                  className="!font-normal"
                >
                  {t('settings.agents.page.mode.primary')}
                </Button>
                <Button
                  variant="chip"
                  size="xs"
                  aria-pressed={mode === 'subagent'}
                  onClick={() => setMode('subagent')}
                  className="!font-normal"
                >
                  {t('settings.agents.page.mode.subagent')}
                </Button>
                <Button
                  variant="chip"
                  size="xs"
                  aria-pressed={mode === 'all'}
                  onClick={() => setMode('all')}
                  className="!font-normal"
                >
                  {t('settings.agents.page.mode.all')}
                </Button>
                </div>
              </div>
            </div>

          </section>
        </div>

        {/* Model & Parameters */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.agents.page.section.modelParameters')}
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0 space-y-0">

            <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:gap-8">
              <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                <span className="typography-ui-label text-foreground">{t('settings.agents.page.field.overrideModel')}</span>
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                <ModelSelector
                  providerId={parseModelIdentifier(model)?.providerId ?? ''}
                  modelId={parseModelIdentifier(model)?.modelId ?? ''}
                  onChange={(providerId: string, modelId: string) => {
                    if (providerId && modelId) {
                      setModel(`${providerId}/${modelId}`);
                    } else {
                      setModel('');
                    }
                  }}
                />
              </div>
            </div>

            <div className={cn("py-1.5", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
              <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "sm:w-56 shrink-0")}>
                <div className="flex items-center gap-1.5">
                  <span className="typography-ui-label text-foreground">{t('settings.agents.page.field.temperature')}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      {t('settings.agents.page.field.temperatureTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <span className="typography-meta text-muted-foreground">{t('settings.agents.page.field.temperatureRange')}</span>
              </div>
              <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "w-fit")}>
                <NumberInput
                  value={temperature}
                  fallbackValue={0.7}
                  onValueChange={setTemperature}
                  onClear={() => setTemperature(undefined)}
                  min={0}
                  max={2}
                  step={0.1}
                  inputMode="decimal"
                  placeholder="—"
                  emptyLabel="—"
                  className="w-16"
                />
                {temperature !== undefined && (
                  <Button size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setTemperature(undefined)}
                    className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                    aria-label={t('settings.agents.page.field.clearTemperatureAria')}
                    title={t('settings.common.actions.clear')}
                  >
                    <RiCloseLine className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>

            <div className={cn("py-1.5", isMobile ? "flex flex-col gap-3" : "flex items-center gap-8")}>
              <div className={cn("flex min-w-0 flex-col", isMobile ? "w-full" : "sm:w-56 shrink-0")}>
                <div className="flex items-center gap-1.5">
                  <span className="typography-ui-label text-foreground">{t('settings.agents.page.field.topP')}</span>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                    </TooltipTrigger>
                    <TooltipContent sideOffset={8} className="max-w-xs">
                      {t('settings.agents.page.field.topPTooltip')}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <span className="typography-meta text-muted-foreground">{t('settings.agents.page.field.topPRange')}</span>
              </div>
              <div className={cn("flex items-center gap-2", isMobile ? "w-full" : "w-fit")}>
                <NumberInput
                  value={topP}
                  fallbackValue={0.9}
                  onValueChange={setTopP}
                  onClear={() => setTopP(undefined)}
                  min={0}
                  max={1}
                  step={0.1}
                  inputMode="decimal"
                  placeholder="—"
                  emptyLabel="—"
                  className="w-16"
                />
                {topP !== undefined && (
                  <Button size="sm"
                    type="button"
                    variant="ghost"
                    onClick={() => setTopP(undefined)}
                    className="h-7 w-7 px-0 text-muted-foreground hover:text-foreground"
                    aria-label={t('settings.agents.page.field.clearTopPAria')}
                    title={t('settings.common.actions.clear')}
                  >
                    <RiCloseLine className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>

          </section>
        </div>

        {/* System Prompt */}
        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.agents.page.section.systemPrompt')}
            </h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('settings.agents.page.field.systemPromptPlaceholder')}
              rows={8}
              className="w-full font-mono typography-meta min-h-[120px] max-h-[60vh] bg-transparent resize-y"
            />
          </section>
        </div>

        {/* Tool Permissions */}
        <div className="mb-2">
          <div className="mb-1 px-1 flex items-center justify-between gap-4">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.agents.page.section.toolPermissions')}
            </h3>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => setShowPermissionEditor((prev) => !prev)}
            >
              {showPermissionEditor ? t('settings.agents.page.permissions.hideEditor') : t('settings.agents.page.permissions.advancedEditor')}
            </Button>
          </div>

          {!showPermissionEditor ? (
            <section className="px-2 pb-2 pt-0 space-y-0">
              {summaryPermissionNames.map((permissionName, index) => {
                const { defaultAction, patternRulesCount, patternSummary, hasDefaultHint } = getPermissionSummary(permissionName);
                const label = formatPermissionLabel(permissionName);
                const summary = hasDefaultHint ? `${defaultAction} (env blocked)` : defaultAction;
                return (
                  <div key={permissionName} className={cn("flex flex-col gap-1 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8", index > 0 && "border-t border-[var(--surface-subtle)]")}>
                    <div className="flex items-center gap-2">
                      <span className="typography-ui-label text-foreground">{label}</span>
                      <span className="typography-micro text-muted-foreground/70 font-mono hidden sm:inline-block">{permissionName}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {patternRulesCount > 0 ? (
                        <span className="typography-micro text-muted-foreground bg-[var(--surface-muted)] px-1.5 py-0.5 rounded">{t('settings.agents.page.permissions.globalSummary', { summary })}</span>
                      ) : (
                        <span className={cn("typography-micro capitalize px-1.5 py-0.5 rounded", summary === 'allow' ? "text-[var(--status-success)] bg-[var(--status-success)]/10" : summary === 'deny' ? "text-[var(--status-error)] bg-[var(--status-error)]/10" : "text-[var(--status-warning)] bg-[var(--status-warning)]/10")}>{summary}</span>
                      )}
                      {patternRulesCount > 0 && (
                        <span className="typography-micro text-muted-foreground bg-[var(--surface-muted)] px-1.5 py-0.5 rounded">{t('settings.agents.page.permissions.rulesSummary', { summary: patternSummary })}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </section>
          ) : (
            <div className="space-y-6 px-2">
              <div className="flex items-center justify-between gap-4 py-1.5">
                <div className="flex items-center gap-2">
                  <span className="typography-ui-label text-foreground">{t('settings.agents.page.permissions.globalDefault')}</span>
                  <span className="typography-micro text-muted-foreground/70 font-mono">*</span>
                </div>
                <Select
                  value={globalPermission}
                  onValueChange={(value) => setGlobalPermissionAndPrune(value as PermissionAction)}
                >
                  <SelectTrigger className="w-[100px]">
                    <SelectValue>{permissionActionLabel(globalPermission)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="allow">{t('settings.common.permission.allow')}</SelectItem>
                    <SelectItem value="ask">{t('settings.common.permission.ask')}</SelectItem>
                    <SelectItem value="deny">{t('settings.common.permission.deny')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-4">
                {summaryPermissionNames.filter((name) => name !== '*').map((permissionName) => {
                  const label = formatPermissionLabel(permissionName);
                  const { defaultAction, patternRulesCount } = getPermissionSummary(permissionName);
                  const wildcardOverride = getWildcardOverride(permissionName);
                  const wildcardValue: string = wildcardOverride ?? 'global';
                  const patternRules = getPatternRules(permissionName);
                  const wildcardOptions = (['allow', 'ask', 'deny'] as const).filter((action) => action !== globalPermission);

                  return (
                    <div key={permissionName} className="border-t border-[var(--surface-subtle)] pt-2">
                      <div className="flex items-center justify-between py-1">
                        <div className="flex items-center gap-2">
                          <span className="typography-ui-label text-foreground">{label}</span>
                          <span className="typography-micro text-muted-foreground/70 font-mono">{permissionName}</span>
                        </div>
                        <div className="typography-micro text-muted-foreground">
                          {patternRulesCount > 0 ? t('settings.agents.page.permissions.globalSummary', { summary: defaultAction }) : defaultAction}
                        </div>
                      </div>

                      <div className="space-y-1 pl-2 mt-1">
                        <div className="flex flex-wrap items-center justify-between gap-2 py-0.5">
                          <div className="flex items-center gap-2">
                            <span className="typography-micro text-muted-foreground">{t('settings.agents.page.permissions.pattern')}</span>
                            <span className="typography-micro font-mono text-foreground bg-[var(--surface-muted)] px-1 rounded">*</span>
                            {wildcardOverride && (
                              <Button size="sm"
                                variant="ghost"
                                onClick={() => revertRule(permissionName, '*')}
                                className="px-1.5 py-0 h-5"
                              >
                                <RiSubtractLine className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                              </Button>
                            )}
                          </div>
                          <Select
                            value={wildcardValue}
                            onValueChange={(value) => {
                              if (value === 'global') {
                                removeRule(permissionName, '*');
                                return;
                              }
                              upsertRule(permissionName, '*', value as PermissionAction);
                            }}
                          >
                            <SelectTrigger className="w-[90px]">
                               <SelectValue>{permissionScopeLabel(wildcardValue as PermissionAction | 'global')}</SelectValue>
                             </SelectTrigger>
                             <SelectContent>
                               <SelectItem value="global">{t('settings.common.scope.global')}</SelectItem>
                              {wildcardOptions.map((action) => (
                                <SelectItem key={action} value={action} className="capitalize">
                                  {permissionActionLabel(action)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        {patternRules.map((rule) => {
                          const ruleKey = buildRuleKey(rule.permission, rule.pattern);
                          const baselineRule = baselineRuleMap.get(ruleKey);
                          const isAdded = !baselineRule;
                          const isModified = Boolean(baselineRule && baselineRule.action !== rule.action);

                          return (
                            <div key={ruleKey} className="flex flex-wrap items-center justify-between gap-2 py-0.5 border-t border-[var(--surface-subtle)]">
                              <div className="flex items-center gap-2">
                                <span className="typography-micro text-muted-foreground">{t('settings.agents.page.permissions.pattern')}</span>
                                <span className="typography-micro font-mono text-foreground bg-[var(--surface-muted)] px-1 rounded">{rule.pattern}</span>
                                {isAdded && <span className="typography-micro text-[var(--status-success)]">{t('settings.common.badge.new')}</span>}
                                {isModified && <span className="typography-micro text-[var(--status-warning)]">{t('settings.common.badge.modified')}</span>}
                                {(isAdded || isModified) && (
                                  <Button size="sm"
                                    variant="ghost"
                                    onClick={() => isAdded ? removeRule(rule.permission, rule.pattern) : revertRule(rule.permission, rule.pattern)}
                                    className="px-1.5 py-0 h-5"
                                  >
                                    <RiSubtractLine className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                                  </Button>
                                )}
                              </div>
                              <Select
                                value={rule.action}
                                onValueChange={(value) => setRuleAction(rule.permission, rule.pattern, value as PermissionAction)}
                              >
                                 <SelectTrigger className="w-[90px]">
                                   <SelectValue>{permissionActionLabel(rule.action)}</SelectValue>
                                 </SelectTrigger>
                                 <SelectContent>
                                   <SelectItem value="allow">{t('settings.common.permission.allow')}</SelectItem>
                                  <SelectItem value="ask">{t('settings.common.permission.ask')}</SelectItem>
                                  <SelectItem value="deny">{t('settings.common.permission.deny')}</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="border-t border-[var(--surface-subtle)] pt-3">
                <h4 className="typography-ui-label text-foreground mb-2">{t('settings.agents.page.permissions.addCustomRule')}</h4>
                <div className="flex flex-col sm:flex-row items-end sm:items-center gap-2">
                  <Select value={pendingRuleName} onValueChange={setPendingRuleName}>
                    <SelectTrigger className="w-full sm:w-[160px]">
                      {pendingRuleName ? (
                        <span className="truncate">{formatPermissionLabel(pendingRuleName)}</span>
                      ) : (
                        <span className="text-muted-foreground">{t('settings.agents.page.permissions.permissionPlaceholder')}</span>
                      )}
                    </SelectTrigger>
                    <SelectContent>
                      {availablePermissionNames.map((name) => (
                        <SelectItem key={name} value={name}>
                          <div className="flex items-center justify-between gap-2 w-full">
                            <span>{formatPermissionLabel(name)}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  <Input
                    value={pendingRulePattern}
                    onChange={(e) => setPendingRulePattern(e.target.value)}
                    placeholder={t('settings.agents.page.permissions.patternPlaceholder')}
                    className="h-7 flex-1 font-mono text-xs"
                  />

                  <div className="flex gap-1">
                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => applyPendingRule('allow')}>{t('settings.common.permission.allow')}</Button>
                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => applyPendingRule('ask')}>{t('settings.common.permission.ask')}</Button>
                    <Button variant="outline" size="xs" className="!font-normal" onClick={() => applyPendingRule('deny')}>{t('settings.common.permission.deny')}</Button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Save action */}
        <div className="px-2 py-1">
          <Button
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            size="xs"
            className="!font-normal"
          >
            {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
          </Button>
        </div>

      </div>
    </ScrollableOverlay>
  );
};
