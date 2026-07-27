import React from 'react';
import type { EditPermissionMode } from '@/stores/types/sessionTypes';
import type { ModelMetadata } from '@/types';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { EngineLogo } from '@/components/ui/EngineLogo';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { ModelPickerList, type ModelPickerEntry } from '@/components/model-picker/ModelPickerList';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { isDesktopShell } from '@/lib/desktop';
import { getAgentColor } from '@/lib/agentColors';
import { useDeviceInfo } from '@/lib/device';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/modelDisplay';
import { getEditModeColors } from '@/lib/permissions/editModeColors';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useContextStore } from '@/stores/contextStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useHarnessStore } from '@/stores/useHarnessStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionMessages, useSessionRenderable } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists } from '@/hooks/useModelLists';
import { useIsTextTruncated } from '@/hooks/useIsTextTruncated';
import { formatEffortLabel, getCycledPrimaryAgentName, isPrimaryMode, type MobileControlsPanel } from './mobileControlsUtils';
import { ClaudeEffortMobilePanel, ClaudeEffortSelector } from './model-controls/ClaudeEffortControl';
import { MobileInfoCard } from './model-controls/MobileInfoCard';
import { useModelPickerData } from './model-controls/useModelPickerData';
import { ENGINE_STATUS_LABEL_KEYS } from './model-controls/modelPickerData';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';
import { eventMatchesShortcut, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import { markStartupTrace } from '@/lib/startupTrace';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { withEnginesSettingsDefaults, setCachedClaudeAgentsMode, getCachedClaudeAgentsMode, type ClaudeAgentsMode } from '@/lib/harness/settings';
import { buildOpenCodeExecutionTarget, persistSessionExecutionTarget } from '@/lib/harness/resolve-execution-target';
import { applySessionExecutionTargetSelection } from '@/lib/harness/session-handoff';
import { CLAUDE_FAVORITE_PROVIDER_ID } from '@/lib/harness/favorite-targets';
import {
    buildClaudeModelMetadata,
    buildClaudeModelMetadataMap,
    resolveClaudeCatalogModel,
    type ClaudeEffort,
} from '@/lib/harness/claude-models';
import { claudePermissionModeFromEditPermission } from '@/lib/harness/claude-models';
import { getAgentDefaultEditPermission } from '@/stores/utils/permissionUtils';
import type { ExecutionTarget, HarnessId } from '@/types/harness';
import { isClaudeEffort } from '@/types/harness';
import { useShallow } from 'zustand/react/shallow';

const CLAUDE_PICKER_PROVIDER_ID = CLAUDE_FAVORITE_PROVIDER_ID;

type IconComponent = IconName;

type ProviderModel = Record<string, unknown> & { id?: string; name?: string };

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRule = { permission: string; pattern: string; action: PermissionAction };
type MobileVariantTarget = { providerId: string; modelId: string };

const buildModelRefKey = (providerID: string, modelID: string) => `${providerID}:${modelID}`;
const MAX_INLINE_MOBILE_VARIANT_OPTIONS = 6;

const asPermissionRuleset = (value: unknown): PermissionRule[] | null => {
    if (!Array.isArray(value)) {
        return null;
    }
    const rules: PermissionRule[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const candidate = entry as Partial<PermissionRule>;
        if (typeof candidate.permission !== 'string' || typeof candidate.pattern !== 'string' || typeof candidate.action !== 'string') {
            continue;
        }
        if (candidate.action !== 'allow' && candidate.action !== 'ask' && candidate.action !== 'deny') {
            continue;
        }
        rules.push({ permission: candidate.permission, pattern: candidate.pattern, action: candidate.action });
    }
    return rules;
};

const resolveWildcardPermissionAction = (ruleset: unknown, permission: string): PermissionAction | undefined => {
    const rules = asPermissionRuleset(ruleset);
    if (!rules || rules.length === 0) {
        return undefined;
    }

    for (let i = rules.length - 1; i >= 0; i -= 1) {
        const rule = rules[i];
        if (rule.permission === permission && rule.pattern === '*') {
            return rule.action;
        }
    }

    for (let i = rules.length - 1; i >= 0; i -= 1) {
        const rule = rules[i];
        if (rule.permission === '*' && rule.pattern === '*') {
            return rule.action;
        }
    }

    return undefined;
};

interface CapabilityDefinition {
    key: 'tool_call' | 'reasoning';
    icon: IconComponent;
    label: string;
    isActive: (metadata?: ModelMetadata) => boolean;
}

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
    {
        key: 'tool_call',
        icon: "tools",
        label: 'Tool calling',
        isActive: (metadata) => metadata?.tool_call === true,
    },
    {
        key: 'reasoning',
        icon: "brain-ai-3",
        label: 'Reasoning',
        isActive: (metadata) => metadata?.reasoning === true,
    },
];

interface ModalityIconDefinition {
    icon: IconComponent;
    label: string;
}

type ModalityIcon = {
    key: string;
    icon: IconComponent;
    label: string;
};

type ModelApplyResult = 'applied' | 'provider-missing' | 'model-missing';

const MODALITY_ICON_MAP: Record<string, ModalityIconDefinition> = {
    text: { icon: "text", label: 'Text' },
    image: { icon: "file-image", label: 'Image' },
    video: { icon: "file-video", label: 'Video' },
    audio: { icon: "file-music", label: 'Audio' },
    pdf: { icon: "file-pdf", label: 'PDF' },
};

const normalizeModality = (value: string) => value.trim().toLowerCase();

const getModalityIcons = (metadata: ModelMetadata | undefined, direction: 'input' | 'output'): ModalityIcon[] => {
    const modalityList = direction === 'input' ? metadata?.modalities?.input : metadata?.modalities?.output;
    if (!Array.isArray(modalityList) || modalityList.length === 0) {
        return [];
    }

    const uniqueValues = Array.from(new Set(modalityList.map((item) => normalizeModality(item))));

    const result: ModalityIcon[] = [];
    for (const modality of uniqueValues) {
        const definition = MODALITY_ICON_MAP[modality];
        if (!definition) {
            continue;
        }
        result.push({
            key: modality,
            icon: definition.icon,
            label: definition.label,
        });
    }
    return result;
};

const formatCompactNumber = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
}).format(value);

const formatUsdCurrency = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 2,
}).format(value);

const formatKnowledgeDate = (value: Date) => new Intl.DateTimeFormat(getCurrentIntlLocale(), { month: 'short', year: 'numeric' }).format(value);

const formatReleaseDate = (value: Date) => new Intl.DateTimeFormat(getCurrentIntlLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
}).format(value);

const ADD_PROVIDER_ID = '__add_provider__';

const IconBadge: React.FC<{ iconName: IconComponent; label: string }> = ({ iconName, label }) => (
    <span
        className="flex size-5 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"
        title={label}
        aria-label={label}
        role="img"
    >
        <Icon name={iconName} className="size-3.5" />
    </span>
);

const EditModeIcon: React.FC<{ mode: EditPermissionMode; className?: string }> = ({ mode, className }) => {
    const combinedClassName = cn(className, 'flex-shrink-0');
    const modeColors = getEditModeColors(mode);
    const iconColor = modeColors ? modeColors.text : 'var(--foreground)';
    const iconStyle = { color: iconColor };

    if (mode === 'full') {
        return <Icon name="pencil-ai" className={combinedClassName} style={iconStyle} />;
    }
    if (mode === 'allow') {
        return <Icon name="checkbox-circle" className={combinedClassName} style={iconStyle} />;
    }
    if (mode === 'deny') {
        return <Icon name="close-circle" className={combinedClassName} style={iconStyle} />;
    }
    return <Icon name="question" className={combinedClassName} style={iconStyle} />;
};

const formatTokens = (value?: number | null) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '—';
    }

    if (value === 0) {
        return '0';
    }

    const formatted = formatCompactNumber(value);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const formatCost = (value?: number | null) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '—';
    }

    return formatUsdCurrency(value);
};

const getCapabilityIcons = (metadata?: ModelMetadata) => {
    const result: { key: string; icon: IconComponent; label: string }[] = [];
    for (const definition of CAPABILITY_DEFINITIONS) {
        if (definition.isActive(metadata)) {
            result.push({ key: definition.key, icon: definition.icon, label: definition.label });
        }
    }
    return result;
};

const formatKnowledge = (knowledge?: string) => {
    if (!knowledge) {
        return '—';
    }

    const match = knowledge.match(/^(\d{4})-(\d{2})$/);
    if (match) {
        const year = Number.parseInt(match[1], 10);
        const monthIndex = Number.parseInt(match[2], 10) - 1;
        const knowledgeDate = new Date(Date.UTC(year, monthIndex, 1));
        if (!Number.isNaN(knowledgeDate.getTime())) {
            return formatKnowledgeDate(knowledgeDate);
        }
    }

    return knowledge;
};

const formatDate = (value?: string) => {
    if (!value) {
        return '—';
    }

    const parsedDate = new Date(value);
    if (Number.isNaN(parsedDate.getTime())) {
        return value;
    }

    return formatReleaseDate(parsedDate);
};

interface ModelControlsProps {
    className?: string;
    mobilePanel?: MobileControlsPanel;
    onMobilePanelChange?: (panel: MobileControlsPanel) => void;
}

export const ModelControls: React.FC<ModelControlsProps> = ({
    className,
    mobilePanel,
    onMobilePanelChange,
}) => {
    const { t } = useI18n();
    const { isReady, isUnavailable } = useOpenCodeReadiness();
    const readinessLabel = isUnavailable ? t('common.unavailable') : t('common.loading');
    const providers = useConfigStore((state) => state.providers);
    const currentProviderId = useConfigStore((state) => state.currentProviderId);
    const currentModelId = useConfigStore((state) => state.currentModelId);
    const currentVariant = useConfigStore((state) => state.currentVariant);
    const currentAgentName = useConfigStore((state) => state.currentAgentName);
    const settingsDefaultVariant = useConfigStore((state) => state.settingsDefaultVariant);
    const settingsDefaultAgent = useConfigStore((state) => state.settingsDefaultAgent);
    const setProvider = useConfigStore((state) => state.setProvider);
    const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
    const setModel = useConfigStore((state) => state.setModel);
    const setCurrentVariant = useConfigStore((state) => state.setCurrentVariant);
    const getCurrentModelVariants = useConfigStore((state) => state.getCurrentModelVariants);
    const setAgent = useConfigStore((state) => state.setAgent);
    const getCurrentProvider = useConfigStore((state) => state.getCurrentProvider);
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    const getCurrentAgent = useConfigStore((state) => state.getCurrentAgent);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);

    // Use visible agents (excludes hidden internal agents)
    const agents = getVisibleAgents();
    const primaryAgents = React.useMemo(() => agents.filter((agent) => agent.mode === 'primary'), [agents]);
    const tracedReadyRef = React.useRef(false);

    React.useEffect(() => {
        if (tracedReadyRef.current || !isReady) return;
        tracedReadyRef.current = true;
        markStartupTrace('ModelControls:ready', {
            providers: providers.length,
            agents: agents.length,
            currentProviderId,
            currentModelId,
            currentAgentName,
        });
    }, [agents.length, currentAgentName, currentModelId, currentProviderId, isReady, providers.length]);

    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const getDirectoryForSession = useSessionUIStore((s) => s.getDirectoryForSession);
    const sync = useSync();

    const getSessionModelSelection = useSelectionStore((state) => state.getSessionModelSelection);
    const saveSessionModelSelection = useSelectionStore((state) => state.saveSessionModelSelection);
    const saveSessionAgentSelection = useSelectionStore((state) => state.saveSessionAgentSelection);
    const saveAgentModelForSession = useSelectionStore((state) => state.saveAgentModelForSession);
    const getAgentModelForSession = useSelectionStore((state) => state.getAgentModelForSession);
    const saveAgentModelVariantForSession = useSelectionStore((state) => state.saveAgentModelVariantForSession);
    const getAgentModelVariantForSession = useSelectionStore((state) => state.getAgentModelVariantForSession);
    const getLastUsedTarget = useSelectionStore((state) => state.getLastUsedTarget);
    const sessionTarget = useSelectionStore((state) =>
        currentSessionId ? state.sessionTargets.get(currentSessionId) ?? null : null
    );
    const pendingHandoffTarget = useSelectionStore((state) =>
        currentSessionId ? state.pendingHandoffTargets.get(currentSessionId) ?? null : null
    );
    const lastUsedTarget = useSelectionStore((state) => state.lastUsedTarget);

    const {
        harnessCatalogsById,
        refreshHarnessCatalog,
    } = useHarnessStore(useShallow((s) => ({
        harnessCatalogsById: s.catalogsById,
        refreshHarnessCatalog: s.refresh,
    })));
    const claudeCatalog = harnessCatalogsById['claude-code'];
    const [enginesClaudeCodeEnabled, setEnginesClaudeCodeEnabled] = React.useState(true);
    const [claudeAgentsMode, setClaudeAgentsMode] = React.useState<ClaudeAgentsMode>(getCachedClaudeAgentsMode());
    const [pickerHarnessId, setPickerHarnessId] = React.useState<HarnessId>('opencode');
    const [claudeModelRef, setClaudeModelRef] = React.useState('sonnet');
    const [claudeEffort, setClaudeEffort] = React.useState<ClaudeEffort | undefined>(undefined);

    const contextHydrated = useContextStore((state) => state.hasHydrated);

    const sessionSavedAgentName = useSelectionStore((state) =>
        currentSessionId ? state.sessionAgentSelections.get(currentSessionId) ?? null : null
    );

    const stickySessionAgentRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!currentSessionId) {
            stickySessionAgentRef.current = null;
            return;
        }
        if (sessionSavedAgentName) {
            stickySessionAgentRef.current = sessionSavedAgentName;
        }
    }, [currentSessionId, sessionSavedAgentName]);

    const stickySessionAgentName = currentSessionId ? stickySessionAgentRef.current : null;

    // Prefer per-session selection over global config to avoid flicker during server-driven mode switches.
    const uiAgentName = currentSessionId
        ? (sessionSavedAgentName || stickySessionAgentName || currentAgentName)
        : currentAgentName;

    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const reorderFavoriteModel = useUIStore((state) => state.reorderFavoriteModel);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const setProviderOrder = useUIStore((state) => state.setProviderOrder);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const addRecentTarget = useUIStore((state) => state.addRecentTarget);
    const addRecentAgent = useUIStore((state) => state.addRecentAgent);
    const addRecentEffort = useUIStore((state) => state.addRecentEffort);
    const isModelSelectorOpen = useUIStore((state) => state.isModelSelectorOpen);
    const setModelSelectorOpen = useUIStore((state) => state.setModelSelectorOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    const setSettingsPage = useUIStore((state) => state.setSettingsPage);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const cycleAgentShortcutOverride = useUIStore((state) => state.shortcutOverrides.cycle_agent);
    const cycleAgentShortcut = React.useMemo(() => (
        getEffectiveShortcutCombo('cycle_agent', cycleAgentShortcutOverride ? { cycle_agent: cycleAgentShortcutOverride } : undefined)
    ), [cycleAgentShortcutOverride]);

    // Separate state for agent selector to avoid conflict with model selector
    const [isAgentSelectorOpen, setIsAgentSelectorOpen] = React.useState(false);
    const { favoriteModelsList, recentModelsList } = useModelLists();

    const { isMobile: deviceIsMobile } = useDeviceInfo();
    // The composer decides whether it renders the mobile layout from the UI
    // store (the Capacitor shell forces it true even on tablets/iPad, where
    // useDeviceInfo classifies the wide screen as non-mobile). The bottom-sheet
    // panels must follow the SAME source: with the device flag alone, tapping
    // the model/agent chip on an iPad set the panel state while the sheet
    // itself rendered null.
    const uiIsMobile = useUIStore((state) => state.isMobile);
    const isMobile = deviceIsMobile || uiIsMobile;
    const isDesktop = React.useMemo(() => isDesktopShell(), []);
    const isVSCodeRuntime = useIsVSCodeRuntime();
    // Only use mobile panels on actual mobile devices, VSCode uses desktop dropdowns
    const isCompact = isMobile;
    const [localMobilePanel, setLocalMobilePanel] = React.useState<MobileControlsPanel>(null);
    const usingExternalMobilePanel = mobilePanel !== undefined && typeof onMobilePanelChange === 'function';
    const activeMobilePanel = usingExternalMobilePanel ? mobilePanel : localMobilePanel;
    const setActiveMobilePanel = usingExternalMobilePanel ? onMobilePanelChange : setLocalMobilePanel;
    const [mobileTooltipOpen, setMobileTooltipOpen] = React.useState<'model' | 'agent' | null>(null);
    const [mobileModelQuery, setMobileModelQuery] = React.useState('');
    const [expandedMobileModelKey, setExpandedMobileModelKey] = React.useState<string | null>(null);
    const [mobileVariantTarget, setMobileVariantTarget] = React.useState<MobileVariantTarget | null>(null);
    const manualVariantSelectionRef = React.useRef(false);
    const closeMobilePanel = React.useCallback(() => setActiveMobilePanel(null), [setActiveMobilePanel]);
    const closeMobileTooltip = React.useCallback(() => setMobileTooltipOpen(null), []);
    const longPressTimerRef = React.useRef<NodeJS.Timeout | undefined>(undefined);
    const [expandedMobileProviders, setExpandedMobileProviders] = React.useState<Set<string>>(() => {
        const initial = new Set<string>();
        if (currentProviderId) {
            initial.add(currentProviderId);
        }
        return initial;
    });
    // Use global state for model selector (allows Ctrl+M shortcut)
    const agentMenuOpen = isModelSelectorOpen;
    const setAgentMenuOpen = setModelSelectorOpen;
    const openAddProviderSettings = React.useCallback(() => {
        setSelectedProvider(ADD_PROVIDER_ID);
        setSettingsPage('providers');
        setSettingsDialogOpen(true);
        setAgentMenuOpen(false);
        closeMobilePanel();
    }, [setSelectedProvider, setSettingsPage, setSettingsDialogOpen, setAgentMenuOpen, closeMobilePanel]);
    const openEnginesSettings = React.useCallback(() => {
        setSettingsPage('engines');
        setSettingsDialogOpen(true);
        setAgentMenuOpen(false);
        closeMobilePanel();
    }, [setSettingsPage, setSettingsDialogOpen, setAgentMenuOpen, closeMobilePanel]);

    React.useEffect(() => {
        void refreshHarnessCatalog();
    }, [refreshHarnessCatalog]);

    React.useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const response = await runtimeFetch('/api/config/settings', {
                    method: 'GET',
                    headers: { Accept: 'application/json' },
                });
                if (!response.ok || cancelled) return;
                const data = await response.json().catch(() => null) as Record<string, unknown> | null;
                if (!data || cancelled) return;
                const resolved = withEnginesSettingsDefaults({
                    enginesClaudeCodeEnabled: typeof data.enginesClaudeCodeEnabled === 'boolean'
                        ? data.enginesClaudeCodeEnabled
                        : undefined,
                    enginesClaudeCodeAgentsMode:
                        data.enginesClaudeCodeAgentsMode === 'claude'
                        || data.enginesClaudeCodeAgentsMode === 'opencode'
                            ? data.enginesClaudeCodeAgentsMode
                            : undefined,
                });
                setEnginesClaudeCodeEnabled(resolved.enginesClaudeCodeEnabled);
                setClaudeAgentsMode(resolved.enginesClaudeCodeAgentsMode);
                setCachedClaudeAgentsMode(resolved.enginesClaudeCodeAgentsMode);
            } catch {
                // keep default
            }
        })();
        return () => {
            cancelled = true;
        };
    }, []);

    // Rehydrate picker engine from pending handoff / sticky / last-used; hydrate OpenCode sessions missing a target.
    React.useEffect(() => {
        const sticky = pendingHandoffTarget
            ?? sessionTarget
            ?? (currentSessionId ? null : lastUsedTarget)
            ?? getLastUsedTarget();
        if (sticky?.harnessId === 'claude-code') {
            setPickerHarnessId('claude-code');
            setClaudeModelRef(sticky.modelRef || 'sonnet');
            setClaudeEffort(isClaudeEffort(sticky.effort) ? sticky.effort : undefined);
            return;
        }
        if (sticky?.harnessId === 'opencode') {
            setPickerHarnessId('opencode');
            return;
        }
        if (currentSessionId && currentProviderId && currentModelId && !sessionTarget && !pendingHandoffTarget) {
            const opencodeTarget = buildOpenCodeExecutionTarget({
                providerID: currentProviderId,
                modelID: currentModelId,
            });
            persistSessionExecutionTarget(currentSessionId, opencodeTarget);
            setPickerHarnessId('opencode');
        }
    }, [
        currentSessionId,
        currentProviderId,
        currentModelId,
        sessionTarget,
        pendingHandoffTarget,
        lastUsedTarget,
        getLastUsedTarget,
    ]);

    const persistTarget = React.useCallback((target: ExecutionTarget) => {
        const directory = currentSessionId
            ? getDirectoryForSession(currentSessionId)
            : null;
        applySessionExecutionTargetSelection(currentSessionId, target, { directory });
    }, [currentSessionId, getDirectoryForSession]);

    const resolveDefaultClaudeModelRef = React.useCallback(() => {
        const fromLast = getLastUsedTarget();
        if (fromLast?.harnessId === 'claude-code' && fromLast.modelRef) {
            return fromLast.modelRef;
        }
        const first = claudeCatalog?.sections.flatMap((section) => section.models)[0]?.id;
        return first || claudeModelRef || 'sonnet';
    }, [claudeCatalog, claudeModelRef, getLastUsedTarget]);

    const buildClaudeTarget = React.useCallback((
        modelRef: string,
        opts?: {
            agentName?: string | null;
            /** Pass `null` to clear effort back to SDK default. */
            effort?: ClaudeEffort | null;
        },
    ): ExecutionTarget => {
        const agentName = opts?.agentName ?? uiAgentName;
        const effort = opts && Object.prototype.hasOwnProperty.call(opts, 'effort')
            ? (opts.effort ?? undefined)
            : claudeEffort;
        // OpenCode agents mode inherits edit permission → permissionMode.
        // Claude agents mode leaves permissionMode unset (native Claude settings).
        if (claudeAgentsMode === 'claude') {
            return {
                harnessId: 'claude-code',
                modelRef,
                ...(effort ? { effort } : {}),
            };
        }
        const permissionMode = claudePermissionModeFromEditPermission(
            getAgentDefaultEditPermission(agentName || undefined),
        );
        return {
            harnessId: 'claude-code',
            modelRef,
            permissionMode,
            ...(effort ? { effort } : {}),
        };
    }, [claudeAgentsMode, claudeEffort, uiAgentName]);

    const handleSelectEngine = React.useCallback((engineId: string) => {
        if (engineId === 'claude-code') {
            if (!enginesClaudeCodeEnabled) return;
            const modelRef = resolveDefaultClaudeModelRef();
            setPickerHarnessId('claude-code');
            setClaudeModelRef(modelRef);
            persistTarget(buildClaudeTarget(modelRef));
            return;
        }
        setPickerHarnessId('opencode');
        if (currentProviderId && currentModelId) {
            persistTarget(buildOpenCodeExecutionTarget({
                providerID: currentProviderId,
                modelID: currentModelId,
            }));
        }
    }, [
        enginesClaudeCodeEnabled,
        resolveDefaultClaudeModelRef,
        persistTarget,
        buildClaudeTarget,
        currentProviderId,
        currentModelId,
    ]);

    const handleClaudeEffortChange = React.useCallback((effort?: ClaudeEffort) => {
        setClaudeEffort(effort);
        persistTarget(buildClaudeTarget(claudeModelRef, { effort: effort ?? null }));
    }, [buildClaudeTarget, claudeModelRef, persistTarget]);
    const [desktopModelQuery, setDesktopModelQuery] = React.useState('');
    const keyboardOwnsModelSelectionRef = React.useRef(false);
    const lastModelPointerPositionRef = React.useRef<{ x: number; y: number } | null>(null);
    const activeModelPickerEntryRef = React.useRef<ModelPickerEntry | undefined>(undefined);
    const [pendingThinkingVariants, setPendingThinkingVariants] = React.useState<Map<string, string | undefined>>(new Map());
    const [adjustedThinkingModels, setAdjustedThinkingModels] = React.useState<Set<string>>(new Set());
    const [modelPickerRenderVersion, setModelPickerRenderVersion] = React.useState(0);

    React.useEffect(() => {
        if (activeMobilePanel === 'model') {
            setExpandedMobileProviders(() => {
                const initial = new Set<string>();
                if (currentProviderId) {
                    initial.add(currentProviderId);
                }
                return initial;
            });
        }
    }, [activeMobilePanel, currentProviderId]);

    React.useEffect(() => {
        if (activeMobilePanel === null) {
            setExpandedMobileModelKey(null);
        }
        if (activeMobilePanel !== 'variant') {
            setMobileVariantTarget(null);
        }
    }, [activeMobilePanel]);

    React.useEffect(() => {
        if (activeMobilePanel !== 'model') {
            setMobileModelQuery('');
            setExpandedMobileModelKey(null);
        }
    }, [activeMobilePanel]);

    // Handle model selector close behavior (separate from agent selector)
    const prevModelSelectorOpenRef = React.useRef(isModelSelectorOpen);
    React.useEffect(() => {
        const wasOpen = prevModelSelectorOpenRef.current;
        prevModelSelectorOpenRef.current = isModelSelectorOpen;

        if (!isModelSelectorOpen) {
            setDesktopModelQuery('');
            keyboardOwnsModelSelectionRef.current = false;
            lastModelPointerPositionRef.current = null;
            setPendingThinkingVariants(new Map());
            setAdjustedThinkingModels(new Set());

            // Restore focus to chat input when model selector closes
            if (wasOpen && !isCompact) {
                requestAnimationFrame(() => {
                    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
                    textarea?.focus();
                });
            }
        }
    }, [isModelSelectorOpen, isCompact]);

    // Handle agent selector close behavior
    const [agentSearchQuery, setAgentSearchQuery] = React.useState('');
    React.useEffect(() => {
        if (!isAgentSelectorOpen) {
            setAgentSearchQuery('');
            if (!isCompact) {
                requestAnimationFrame(() => {
                    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
                    textarea?.focus();
                });
            }
        }
    }, [isAgentSelectorOpen, isCompact]);

    const selectableDesktopAgents = React.useMemo(() => {
        return agents.filter((agent) => isPrimaryMode(agent.mode));
    }, [agents]);

    const sortedAndFilteredAgents = React.useMemo(() => {
        const sorted = [...selectableDesktopAgents].sort((a, b) => a.name.localeCompare(b.name));
        if (!agentSearchQuery.trim()) {
            return sorted;
        }
        return sorted.filter((agent) =>
            fuzzyMatch(agent.name, agentSearchQuery) ||
            (agent.description && fuzzyMatch(agent.description, agentSearchQuery))
        );
    }, [selectableDesktopAgents, agentSearchQuery]);

    const defaultAgentName = React.useMemo(() => {
        if (settingsDefaultAgent) {
            const found = selectableDesktopAgents.find(a => a.name === settingsDefaultAgent);
            if (found) return found.name;
        }
        const buildAgent = selectableDesktopAgents.find(a => a.name === 'build');
        if (buildAgent) return buildAgent.name;
        return selectableDesktopAgents[0]?.name;
    }, [settingsDefaultAgent, selectableDesktopAgents]);

    const currentAgent = React.useMemo(() => {
        if (uiAgentName) {
            return agents.find((agent) => agent.name === uiAgentName);
        }
        return getCurrentAgent?.();
    }, [agents, getCurrentAgent, uiAgentName]);

    const sizeVariant: 'mobile' | 'vscode' | 'default' = isMobile ? 'mobile' : isVSCodeRuntime ? 'vscode' : 'default';
    const buttonHeight = sizeVariant === 'mobile' ? 'h-9' : sizeVariant === 'vscode' ? 'h-6' : 'h-8';
    const controlIconSize = sizeVariant === 'mobile' ? 'size-5' : sizeVariant === 'vscode' ? 'size-4' : 'size-4';
    const controlTextSize = isCompact ? 'typography-micro' : 'typography-meta';
    const inlineGapClass = sizeVariant === 'mobile' ? 'gap-x-1' : sizeVariant === 'vscode' ? 'gap-x-2' : 'gap-x-3';

    const currentProvider = getCurrentProvider();
    const models = Array.isArray(currentProvider?.models) ? currentProvider.models : [];

    const visibleProviders = React.useMemo(() => {
        const result: typeof providers = [];
        for (const provider of providers) {
            const providerModels = Array.isArray(provider.models) ? provider.models : [];
            const visibleModels = providerModels.filter((model: ProviderModel) => {
                const modelId = typeof model?.id === 'string' ? model.id : '';
                return !hiddenModels.some(
                    (item) => item.providerID === String(provider.id) && item.modelID === modelId
                );
            });
            if (visibleModels.length > 0) {
                result.push({ ...provider, models: visibleModels });
            }
        }
        return result;
    }, [providers, hiddenModels]);

    const normalizeModelSearchValue = React.useCallback((value: string) => {
        const lower = value.toLowerCase().trim();
        const compact = lower.replace(/[^a-z0-9]/g, '');
        const tokens = lower.split(/[^a-z0-9]+/).filter(Boolean);
        return { lower, compact, tokens };
    }, []);

    const matchesModelSearch = React.useCallback((candidate: string, query: string) => {
        const normalizedQuery = normalizeModelSearchValue(query);
        if (!normalizedQuery.lower) {
            return true;
        }

        const normalizedCandidate = normalizeModelSearchValue(candidate);
        if (normalizedCandidate.lower.includes(normalizedQuery.lower)) {
            return true;
        }

        if (normalizedQuery.compact.length >= 2 && normalizedCandidate.compact.includes(normalizedQuery.compact)) {
            return true;
        }

        if (normalizedQuery.tokens.length === 0) {
            return false;
        }

        return normalizedQuery.tokens.every((queryToken) =>
            normalizedCandidate.tokens.some((candidateToken) =>
                candidateToken.startsWith(queryToken) || candidateToken.includes(queryToken)
            )
        );
    }, [normalizeModelSearchValue]);

    const claudeCatalogModels = React.useMemo(
        () => claudeCatalog?.sections.flatMap((section) => section.models) ?? [],
        [claudeCatalog],
    );
    const claudeModelsMetadata = React.useMemo(
        () => buildClaudeModelMetadataMap(claudeCatalogModels),
        [claudeCatalogModels],
    );

    const {
        labels: modelPickerLabels,
        engineOptions,
        pickerProviders,
        pickerFavoriteModels,
        pickerRecentModels,
        pickerSelectedModel,
    } = useModelPickerData({
        t,
        claudePickerProviderId: CLAUDE_PICKER_PROVIDER_ID,
        pickerHarnessId,
        enginesClaudeCodeEnabled,
        claudeCatalog,
        claudeCatalogModels,
        claudeModelRef,
        providers,
        favoriteModelsList,
        recentModelsList,
        currentProviderId,
        currentModelId,
    });
    const currentModelForMetadata = currentModelId
        ? models.find((model: ProviderModel) => model.id === currentModelId)
        : undefined;
    const currentMetadata = pickerHarnessId === 'claude-code'
        ? buildClaudeModelMetadata(resolveClaudeCatalogModel(claudeCatalogModels, claudeModelRef))
        : currentProviderId && currentModelId && currentModelForMetadata
            ? mergeModelMetadataWithLiveModel(currentProviderId, currentModelForMetadata, getModelMetadata(currentProviderId, currentModelId))
            : currentProviderId && currentModelId
                ? getModelMetadata(currentProviderId, currentModelId)
                : undefined;
    const localizeMetaLabel = React.useCallback((label: string) => {
        if (label === 'Tool calling') return t('chat.modelControls.capability.toolCalling');
        if (label === 'Reasoning') return t('chat.modelControls.capability.reasoning');
        if (label === 'Text') return t('chat.modelControls.modality.text');
        if (label === 'Image') return t('chat.modelControls.modality.image');
        if (label === 'Video') return t('chat.modelControls.modality.video');
        if (label === 'Audio') return t('chat.modelControls.modality.audio');
        if (label === 'PDF') return t('chat.modelControls.modality.pdf');
        return label;
    }, [t]);

    const currentCapabilityIcons = React.useMemo(
        () => getCapabilityIcons(currentMetadata).map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
        [currentMetadata, localizeMetaLabel],
    );
    const inputModalityIcons = React.useMemo(
        () => getModalityIcons(currentMetadata, 'input').map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
        [currentMetadata, localizeMetaLabel],
    );
    const outputModalityIcons = React.useMemo(
        () => getModalityIcons(currentMetadata, 'output').map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
        [currentMetadata, localizeMetaLabel],
    );

    // Compute from current model each render to avoid stale variants
    // in draft/session transitions.
    const availableVariants = getCurrentModelVariants();
    const hasVariants = availableVariants.length > 0;

    const costRows = [
        { label: t('chat.modelControls.input'), value: formatCost(currentMetadata?.cost?.input) },
        { label: t('chat.modelControls.output'), value: formatCost(currentMetadata?.cost?.output) },
        { label: t('chat.modelControls.cacheRead'), value: formatCost(currentMetadata?.cost?.cache_read) },
        { label: t('chat.modelControls.cacheWrite'), value: formatCost(currentMetadata?.cost?.cache_write) },
    ];

    const limitRows = [
        { label: t('chat.modelControls.context'), value: formatTokens(currentMetadata?.limit?.context) },
        { label: t('chat.modelControls.output'), value: formatTokens(currentMetadata?.limit?.output) },
    ];

    const prevAgentNameRef = React.useRef<string | undefined>(undefined);
    const explicitAgentSwitchRef = React.useRef<string | null>(null);
    const latestLoadedUserChoiceRestoreRef = React.useRef<string | null>(null);

    const currentSessionDirectory = currentSessionId ? getDirectoryForSession(currentSessionId) : undefined;
    const hasRenderableCurrentSessionSnapshot = useSessionRenderable(
        currentSessionId ?? '',
        currentSessionDirectory ?? undefined,
    );
    const currentSessionMessagesFromSync = useSessionMessages(currentSessionId ?? '', currentSessionDirectory ?? undefined);
    const latestLoadedUserChoice = React.useMemo(() => {
        for (let i = currentSessionMessagesFromSync.length - 1; i >= 0; i -= 1) {
            const message = currentSessionMessagesFromSync[i] as typeof currentSessionMessagesFromSync[number] & {
                model?: { providerID?: string; modelID?: string; variant?: string };
                variant?: string;
                mode?: string;
            };
            if (message.role !== 'user') {
                continue;
            }

            const providerID = typeof message.model?.providerID === 'string' && message.model.providerID.trim().length > 0
                ? message.model.providerID
                : undefined;
            const modelID = typeof message.model?.modelID === 'string' && message.model.modelID.trim().length > 0
                ? message.model.modelID
                : undefined;
            const agent = typeof message.agent === 'string' && message.agent.trim().length > 0
                ? message.agent
                : (typeof message.mode === 'string' && message.mode.trim().length > 0 ? message.mode : undefined);
            // OpenCode 1.4.0 moved variant from top-level to model.variant.
            // Prefer the new location, fall back to the legacy one for older servers.
            const variantCandidate = message.model?.variant ?? message.variant;
            const variant = typeof variantCandidate === 'string' && variantCandidate.trim().length > 0
                ? variantCandidate
                : undefined;

            return { id: message.id, agent, providerID, modelID, variant };
        }
        return null;
    }, [currentSessionMessagesFromSync]);

    const tryApplyModelSelection = React.useCallback(
        (providerId: string, modelId: string, agentName?: string): ModelApplyResult => {
            if (!providerId || !modelId) {
                return 'model-missing';
            }

            const provider = providers.find(p => p.id === providerId);
            if (!provider) {
                return 'provider-missing';
            }

            const providerModels = Array.isArray(provider.models) ? provider.models : [];
            const modelExists = providerModels.find((m: ProviderModel) => m.id === modelId);
            if (!modelExists) {
                return 'model-missing';
            }

            const providerMatches = currentProviderId === providerId;
            const modelMatches = currentModelId === modelId;
            if (providerMatches && modelMatches) {
                return 'applied';
            }

            setProvider(providerId);
            setModel(modelId);

            if (currentSessionId) {
                saveSessionModelSelection(currentSessionId, providerId, modelId);
                if (agentName) {
                    saveAgentModelForSession(currentSessionId, agentName, providerId, modelId);
                }
            }

            return 'applied';
        },
        [providers, currentProviderId, currentModelId, setProvider, setModel, currentSessionId, saveAgentModelForSession, saveSessionModelSelection],
    );

    const getModelVariantOptions = React.useCallback((providerId: string, modelId: string) => {
        const provider = providers.find((entry) => entry.id === providerId);
        const model = provider?.models.find((entry) => entry.id === modelId) as { variants?: Record<string, unknown> } | undefined;
        const variants = model?.variants;
        return variants ? Object.keys(variants) : [];
    }, [providers]);

    const resolveModelVariantSelection = React.useCallback((providerId: string, modelId: string) => {
        const variantOptions = getModelVariantOptions(providerId, modelId);
        if (variantOptions.length === 0) {
            return undefined;
        }

        const effectiveAgentName = uiAgentName || currentAgentName;
        if (currentSessionId && effectiveAgentName) {
            const savedVariant = getAgentModelVariantForSession(currentSessionId, effectiveAgentName, providerId, modelId);
            if (savedVariant && variantOptions.includes(savedVariant)) {
                return savedVariant;
            }
        }

        if (currentProviderId === providerId && currentModelId === modelId && currentVariant && variantOptions.includes(currentVariant)) {
            return currentVariant;
        }

        if (!currentSessionId && settingsDefaultVariant && variantOptions.includes(settingsDefaultVariant)) {
            return settingsDefaultVariant;
        }

        return undefined;
    }, [
        currentAgentName,
        currentModelId,
        currentProviderId,
        currentSessionId,
        currentVariant,
        getAgentModelVariantForSession,
        getModelVariantOptions,
        settingsDefaultVariant,
        uiAgentName,
    ]);

    const resolveLiveAgentName = React.useCallback(() => {
        const liveConfigAgentName = useConfigStore.getState().currentAgentName;
        if (currentSessionId) {
            return useSelectionStore.getState().getSessionAgentSelection(currentSessionId)
                || stickySessionAgentRef.current
                || liveConfigAgentName
                || currentAgentName;
        }
        return liveConfigAgentName || currentAgentName;
    }, [currentAgentName, currentSessionId]);

    const commitVariantSelectionForModel = React.useCallback((providerId: string, modelId: string, variant: string | undefined, agentNameOverride?: string | null) => {
        const variantOptions = getModelVariantOptions(providerId, modelId);
        if (variantOptions.length === 0) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        manualVariantSelectionRef.current = true;
        setCurrentVariant(variant);
        addRecentEffort(providerId, modelId, variant);

        const effectiveAgentName = agentNameOverride ?? resolveLiveAgentName();
        if (currentSessionId && effectiveAgentName) {
            saveAgentModelVariantForSession(currentSessionId, effectiveAgentName, providerId, modelId, variant);
        }
    }, [
        addRecentEffort,
        currentSessionId,
        getModelVariantOptions,
        resolveLiveAgentName,
        saveAgentModelVariantForSession,
        setCurrentVariant,
    ]);

    const applyModelSelectionWithVariant = React.useCallback((providerId: string, modelId: string, variant: string | undefined, agentNameOverride?: string | null) => {
        const effectiveAgentName = agentNameOverride ?? resolveLiveAgentName() ?? undefined;
        const result = tryApplyModelSelection(providerId, modelId, effectiveAgentName);
        if (result !== 'applied') {
            return result;
        }

        addRecentModel(providerId, modelId);
        commitVariantSelectionForModel(providerId, modelId, variant, effectiveAgentName);
        return 'applied';
    }, [addRecentModel, commitVariantSelectionForModel, resolveLiveAgentName, tryApplyModelSelection]);

    React.useEffect(() => {
        if (!currentSessionId) {
            latestLoadedUserChoiceRestoreRef.current = null;
            return;
        }

        if (!contextHydrated || providers.length === 0 || !hasRenderableCurrentSessionSnapshot || !latestLoadedUserChoice?.providerID || !latestLoadedUserChoice.modelID) {
            return;
        }

        const restoreKey = [
            currentSessionId,
            latestLoadedUserChoice.id,
            latestLoadedUserChoice.agent ?? '',
            latestLoadedUserChoice.providerID,
            latestLoadedUserChoice.modelID,
            latestLoadedUserChoice.variant ?? '',
        ].join('|');

        if (latestLoadedUserChoiceRestoreRef.current === restoreKey) {
            return;
        }

        if (latestLoadedUserChoice.agent && currentAgentName !== latestLoadedUserChoice.agent) {
            setAgent(latestLoadedUserChoice.agent);
        }

        const historicalVariant = latestLoadedUserChoice.variant
            && getModelVariantOptions(latestLoadedUserChoice.providerID, latestLoadedUserChoice.modelID).includes(latestLoadedUserChoice.variant)
            ? latestLoadedUserChoice.variant
            : undefined;
        const applyResult = applyModelSelectionWithVariant(
            latestLoadedUserChoice.providerID,
            latestLoadedUserChoice.modelID,
            historicalVariant,
            latestLoadedUserChoice.agent || currentAgentName || undefined,
        );
        if (applyResult !== 'applied') {
            return;
        }

        if (latestLoadedUserChoice.agent) {
            saveSessionAgentSelection(currentSessionId, latestLoadedUserChoice.agent);
            saveAgentModelVariantForSession(
                currentSessionId,
                latestLoadedUserChoice.agent,
                latestLoadedUserChoice.providerID,
                latestLoadedUserChoice.modelID,
                historicalVariant,
            );
        }
        saveSessionModelSelection(currentSessionId, latestLoadedUserChoice.providerID, latestLoadedUserChoice.modelID);
        latestLoadedUserChoiceRestoreRef.current = restoreKey;

    }, [
        currentSessionId,
        currentAgentName,
        contextHydrated,
        providers,
        hasRenderableCurrentSessionSnapshot,
        latestLoadedUserChoice,
        setAgent,
        applyModelSelectionWithVariant,
        getModelVariantOptions,
        saveSessionAgentSelection,
        saveAgentModelVariantForSession,
        saveSessionModelSelection,
    ]);

    React.useEffect(() => {
        if (!currentSessionId) {
            latestLoadedUserChoiceRestoreRef.current = null;
            return;
        }

        if (!contextHydrated || providers.length === 0 || agents.length === 0) {
            return;
        }

        const applySavedSelections = (): 'resolved' | 'waiting' | 'continue' => {
            const savedSessionModel = getSessionModelSelection(currentSessionId);
            const savedAgentName = currentSessionId
                ? useSelectionStore.getState().getSessionAgentSelection(currentSessionId)
                : null;
            if (savedAgentName) {
                if (currentAgentName !== savedAgentName) {
                    setAgent(savedAgentName);
                }

                const savedModel = getAgentModelForSession(currentSessionId, savedAgentName);
                if (savedModel) {
                    const result = tryApplyModelSelection(savedModel.providerId, savedModel.modelId, savedAgentName);
                    if (result === 'applied') {
                        return 'resolved';
                    }
                    if (result === 'provider-missing') {
                        return 'waiting';
                    }
                }
            }

            if (savedSessionModel) {
                const result = tryApplyModelSelection(savedSessionModel.providerId, savedSessionModel.modelId, savedAgentName || currentAgentName || undefined);
                if (result === 'applied') {
                    return 'resolved';
                }
                if (result === 'provider-missing') {
                    return 'waiting';
                }
            }

            for (const agent of agents) {
                const selection = getAgentModelForSession(currentSessionId, agent.name);
                if (!selection) {
                    continue;
                }

                if (currentAgentName !== agent.name) {
                    setAgent(agent.name);
                }

                const existingSelection = useSelectionStore.getState().getSessionAgentSelection(currentSessionId) || stickySessionAgentRef.current;
                if (!existingSelection) {
                    saveSessionAgentSelection(currentSessionId, agent.name);
                }
                const result = tryApplyModelSelection(selection.providerId, selection.modelId, agent.name);
                if (result === 'applied') {
                    return 'resolved';
                }
                if (result === 'provider-missing') {
                    return 'waiting';
                }
            }

            return 'continue';
        };

        const applyFallbackAgent = () => {
            if (agents.length === 0) {
                return;
            }

            const existingSelection = currentSessionId
                ? (useSelectionStore.getState().getSessionAgentSelection(currentSessionId) || stickySessionAgentRef.current)
                : null;

            // If we already have a valid agent selected (often from server-injected mode switch),
            // don't override it with a fallback.
            const preferred =
                (currentSessionId
                    ? (useSelectionStore.getState().getSessionAgentSelection(currentSessionId) || stickySessionAgentRef.current)
                    : null) ||
                currentAgentName;
            if (preferred && agents.some((agent) => agent.name === preferred)) {
                if (currentAgentName !== preferred) {
                    setAgent(preferred);
                }
                return;
            }

            const fallbackAgent = agents.find(agent => agent.name === 'build') || primaryAgents[0] || agents[0];
            if (!fallbackAgent) {
                return;
            }

            if (!existingSelection) {
                saveSessionAgentSelection(currentSessionId, fallbackAgent.name);
            }

            if (currentAgentName !== fallbackAgent.name) {
                setAgent(fallbackAgent.name);
            }

            if (fallbackAgent.model?.providerID && fallbackAgent.model?.modelID) {
                tryApplyModelSelection(fallbackAgent.model.providerID, fallbackAgent.model.modelID, fallbackAgent.name);
            }
        };

        const savedOutcome = applySavedSelections();
        if (savedOutcome === 'resolved' || savedOutcome === 'waiting') {
            return;
        }

        if (!hasRenderableCurrentSessionSnapshot) {
            if (!sync.isLoading(currentSessionId)) {
                void sync.ensureSessionRenderable(currentSessionId);
            }
            return;
        }

        if (latestLoadedUserChoice) {
            return;
        }

        applyFallbackAgent();
    }, [
        currentSessionId,
        hasRenderableCurrentSessionSnapshot,
        latestLoadedUserChoice,
        agents,
        primaryAgents,
        currentAgentName,
        getSessionModelSelection,
        getAgentModelForSession,
        setAgent,
        tryApplyModelSelection,
        saveSessionAgentSelection,
        contextHydrated,
        providers,
        sync,
    ]);

    React.useEffect(() => {
        if (!contextHydrated) {
            return;
        }
        const abortController = new AbortController();

        const handleAgentSwitch = async () => {
            try {
                if (currentAgentName !== prevAgentNameRef.current) {
                    prevAgentNameRef.current = currentAgentName;

                    if (currentAgentName && currentSessionId) {
                        const shouldPreferAgentModel = explicitAgentSwitchRef.current === currentAgentName;
                        explicitAgentSwitchRef.current = null;

                        await new Promise<void>((resolve) => {
                            const timer = setTimeout(resolve, 50);
                            abortController.signal.addEventListener('abort', () => {
                                clearTimeout(timer);
                                resolve();
                            });
                        });

                        if (abortController.signal.aborted) {
                            return;
                        }

                        const selectedAgent = shouldPreferAgentModel
                            ? agents.find((agent) => agent.name === currentAgentName)
                            : undefined;
                        if (selectedAgent?.model?.providerID && selectedAgent.model.modelID) {
                            const result = tryApplyModelSelection(
                                selectedAgent.model.providerID,
                                selectedAgent.model.modelID,
                                currentAgentName,
                            );
                            if (result === 'applied' || result === 'provider-missing') {
                                if (result === 'applied') {
                                    saveSessionModelSelection(
                                        currentSessionId,
                                        selectedAgent.model.providerID,
                                        selectedAgent.model.modelID,
                                    );
                                    saveAgentModelForSession(
                                        currentSessionId,
                                        currentAgentName,
                                        selectedAgent.model.providerID,
                                        selectedAgent.model.modelID,
                                    );
                                }
                                return;
                            }
                        }

                        const persistedChoice = getAgentModelForSession(currentSessionId, currentAgentName);

                        if (persistedChoice) {
                            const result = tryApplyModelSelection(
                                persistedChoice.providerId,
                                persistedChoice.modelId,
                                currentAgentName,
                            );
                            if (result === 'applied' || result === 'provider-missing') {
                                return;
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('[ModelControls] Agent change error:', error);
            }
        };

        handleAgentSwitch();

        return () => {
            abortController.abort();
        };
    }, [
        agents,
        currentAgentName,
        currentSessionId,
        getAgentModelForSession,
        saveAgentModelForSession,
        saveSessionModelSelection,
        tryApplyModelSelection,
        contextHydrated,
    ]);

    React.useEffect(() => {
        if (!contextHydrated || !currentAgentName) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        if (!currentProviderId || !currentModelId) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        if (availableVariants.length === 0) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        if (currentVariant && !availableVariants.includes(currentVariant)) {
            setCurrentVariant(undefined);
            return;
        }

        // Draft state (no session yet): seed from settings default, but don't override
        // user selection while drafting.
        if (!currentSessionId) {
            if (!currentVariant && !manualVariantSelectionRef.current) {
                const desired = settingsDefaultVariant && availableVariants.includes(settingsDefaultVariant)
                    ? settingsDefaultVariant
                    : undefined;
                setCurrentVariant(desired);
            }
            return;
        }

        const savedVariant = getAgentModelVariantForSession(
            currentSessionId,
            currentAgentName,
            currentProviderId,
            currentModelId,
        );

        const resolvedSaved = savedVariant && availableVariants.includes(savedVariant)
            ? savedVariant
            : settingsDefaultVariant && availableVariants.includes(settingsDefaultVariant)
                ? settingsDefaultVariant
                : undefined;

        setCurrentVariant(resolvedSaved);
        manualVariantSelectionRef.current = false;
    }, [
        availableVariants,
        contextHydrated,
        currentSessionId,
        currentAgentName,
        currentProviderId,
        currentModelId,
        currentVariant,
        getAgentModelVariantForSession,
        setCurrentVariant,
        settingsDefaultVariant,
    ]);

    React.useEffect(() => {
        manualVariantSelectionRef.current = false;
    }, [currentProviderId, currentModelId]);

    const handleVariantSelect = React.useCallback((variant: string | undefined) => {
        if (currentProviderId && currentModelId) {
            commitVariantSelectionForModel(currentProviderId, currentModelId, variant);
        }
    }, [commitVariantSelectionForModel, currentModelId, currentProviderId]);

    const handleAgentChange = React.useCallback((agentName: string, options?: { closeModelSelector?: boolean }) => {
        try {
            explicitAgentSwitchRef.current = agentName;
            setAgent(agentName);
            addRecentAgent(agentName);
            if (options?.closeModelSelector ?? true) {
                setAgentMenuOpen(false);
            }

            if (currentSessionId) {
                saveSessionAgentSelection(currentSessionId, agentName);
            }
            // Claude permissionMode mirrors the selected OpenCode agent's edit rule.
            if (pickerHarnessId === 'claude-code') {
                persistTarget(buildClaudeTarget(claudeModelRef, { agentName }));
            }
            if (isCompact) {
                closeMobilePanel();
            }
        } catch (error) {
            console.error('[ModelControls] Handle agent change error:', error);
        }
    }, [
        addRecentAgent,
        buildClaudeTarget,
        closeMobilePanel,
        claudeModelRef,
        currentSessionId,
        isCompact,
        persistTarget,
        pickerHarnessId,
        saveSessionAgentSelection,
        setAgent,
        setAgentMenuOpen,
    ]);

    const handleCycleAgentFromModelPicker = React.useCallback((direction: 1 | -1) => {
        const nextAgentName = getCycledPrimaryAgentName(agents, currentAgentName, direction);
        if (!nextAgentName) {
            return;
        }
        handleAgentChange(nextAgentName, { closeModelSelector: false });
    }, [agents, currentAgentName, handleAgentChange]);

    const getCycleAgentDirectionFromEvent = React.useCallback((event: KeyboardEvent | React.KeyboardEvent): 1 | -1 | null => {
        const cycleAgentBackwardShortcut = cycleAgentShortcut && !cycleAgentShortcut.includes('shift')
            ? normalizeCombo(`shift+${cycleAgentShortcut}`)
            : '';

        if (cycleAgentBackwardShortcut && eventMatchesShortcut(event, cycleAgentBackwardShortcut)) {
            return -1;
        }

        if (eventMatchesShortcut(event, cycleAgentShortcut)) {
            return 1;
        }

        return null;
    }, [cycleAgentShortcut]);

    const handleProviderAndModelChange = (
        providerId: string,
        modelId: string,
        options?: { applyVariant?: boolean; variant?: string | undefined; agentName?: string | null },
    ) => {
        try {
            if (providerId === CLAUDE_PICKER_PROVIDER_ID || pickerHarnessId === 'claude-code') {
                setPickerHarnessId('claude-code');
                setClaudeModelRef(modelId);
                const target = buildClaudeTarget(modelId);
                persistTarget(target);
                addRecentTarget(target);
                setAgentMenuOpen(false);
                if (isCompact) {
                    closeMobilePanel();
                }
                requestAnimationFrame(() => {
                    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
                    textarea?.focus();
                });
                return;
            }

            const effectiveAgentName = options?.agentName ?? resolveLiveAgentName() ?? undefined;
            const result = options?.applyVariant
                ? applyModelSelectionWithVariant(providerId, modelId, options.variant, effectiveAgentName)
                : tryApplyModelSelection(providerId, modelId, effectiveAgentName);
            if (result !== 'applied') {
                if (result === 'provider-missing') {
                    console.error('[ModelControls] Provider not available for selection:', providerId);
                } else if (result === 'model-missing') {
                    console.error('[ModelControls] Model not available for selection:', { providerId, modelId });
                }
                return;
            }
            setPickerHarnessId('opencode');
            persistTarget(buildOpenCodeExecutionTarget({
                providerID: providerId,
                modelID: modelId,
                agent: effectiveAgentName,
                variant: options?.applyVariant ? options.variant : currentVariant,
            }));
            if (!options?.applyVariant) {
                // Add to recent models on successful selection.
                addRecentModel(providerId, modelId);
            }
            setAgentMenuOpen(false);
            if (isCompact) {
                closeMobilePanel();
            }
            // Restore focus to chat input after model selection.
            requestAnimationFrame(() => {
                const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
                textarea?.focus();
            });
        } catch (error) {
            console.error('[ModelControls] Handle model change error:', error);
        }
    };

    const getModelDisplayName = (model: ProviderModel | undefined, fallbackModelId?: string) => {
        return getSharedModelDisplayName(model, fallbackModelId, { maxLength: 40 });
    };

    const getProviderDisplayName = () => {
        if (pickerHarnessId === 'claude-code') {
            return t('chat.engines.claudeCode');
        }
        const provider = providers.find(p => p.id === currentProviderId);
        return provider?.name || currentProviderId;
    };

    const getClaudeModelDisplayName = React.useCallback((modelRef: string) => {
        const models = claudeCatalog?.sections.flatMap((section) => section.models) ?? [];
        const match = models.find((model) => model.id === modelRef);
        return match?.name || modelRef;
    }, [claudeCatalog]);

    const getCurrentModelDisplayName = () => {
        if (pickerHarnessId === 'claude-code') {
            return t('chat.engines.chip.claude', { model: getClaudeModelDisplayName(claudeModelRef) });
        }
        if (!currentModelId) return t('chat.modelControls.selectModel');
        const currentModel = models.find((m: ProviderModel) => m.id === currentModelId);
        return getModelDisplayName(currentModel, currentModelId) || t('chat.modelControls.selectModel');
    };

    const currentModelDisplayName = getCurrentModelDisplayName();
    const modelLabelRef = React.useRef<HTMLSpanElement>(null);
    const isModelLabelTruncated = useIsTextTruncated(modelLabelRef, [currentModelDisplayName, isCompact]);

    const getAgentDisplayName = () => {
        if (!uiAgentName) {
            const buildAgent = primaryAgents.find(agent => agent.name === 'build');
            const defaultAgent = buildAgent || primaryAgents[0];
            return defaultAgent ? capitalizeAgentName(defaultAgent.name) : 'Select Agent';
        }
        const agent = agents.find(a => a.name === uiAgentName);
        return agent ? capitalizeAgentName(agent.name) : capitalizeAgentName(uiAgentName);
    };

    const capitalizeAgentName = (name: string) => {
        return name.charAt(0).toUpperCase() + name.slice(1);
    };

    const toggleMobileProviderExpansion = React.useCallback((providerId: string) => {
        setExpandedMobileProviders((prev) => {
            const next = new Set(prev);
            if (next.has(providerId)) {
                next.delete(providerId);
            } else {
                next.add(providerId);
            }
            return next;
        });
    }, []);

    const handleLongPressStart = React.useCallback((type: 'model' | 'agent') => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
        }
        longPressTimerRef.current = setTimeout(() => {
            setMobileTooltipOpen(type);
        }, 500);
    }, []);

    const handleLongPressEnd = React.useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
        }
    }, []);

    React.useEffect(() => {
        return () => {
            if (longPressTimerRef.current) {
                clearTimeout(longPressTimerRef.current);
            }
        };
    }, []);

    const renderMobileModelTooltip = () => {
        if (!isCompact || mobileTooltipOpen !== 'model') return null;

        return (
            <MobileOverlayPanel
                open={true}
                onClose={closeMobileTooltip}
                title={currentMetadata?.name || getCurrentModelDisplayName()}
            >
                <div className="flex flex-col gap-1.5">
                    {}
                    <MobileInfoCard caption={t('chat.modelControls.provider')} tightCaption>
                        <div className="typography-meta text-foreground font-medium">{getProviderDisplayName()}</div>
                    </MobileInfoCard>

                    {}
                    {currentCapabilityIcons.length > 0 && (
                        <MobileInfoCard caption={t('chat.modelControls.capabilities')}>
                            <div className="flex flex-wrap gap-1.5">
                                {currentCapabilityIcons.map(({ key, icon, label }) => (
                                    <div key={key} className="flex items-center gap-1.5">
                                        <IconBadge key={`cap-${key}`} iconName={icon} label={label} />
                                        <span className="typography-meta text-foreground">{label}</span>
                                    </div>
                                ))}
                            </div>
                        </MobileInfoCard>
                    )}

                    {}
                    {(inputModalityIcons.length > 0 || outputModalityIcons.length > 0) && (
                        <MobileInfoCard caption={t('chat.modelControls.modalities')}>
                            <div className="flex flex-col gap-1">
                                {inputModalityIcons.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="typography-meta text-muted-foreground/80 w-12">{t('chat.modelControls.input')}</span>
                                        <div className="flex gap-1">
                                            {inputModalityIcons.map(({ key, icon, label }) => (
                                                <IconBadge
                                                    key={`input-${key}`}
                                                    iconName={icon}
                                                    label={t('chat.modelControls.modalityInputAria', { modality: label })}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {outputModalityIcons.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="typography-meta text-muted-foreground/80 w-12">{t('chat.modelControls.output')}</span>
                                        <div className="flex gap-1">
                                            {outputModalityIcons.map(({ key, icon, label }) => (
                                                <IconBadge
                                                    key={`output-${key}`}
                                                    iconName={icon}
                                                    label={t('chat.modelControls.modalityOutputAria', { modality: label })}
                                                />
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </MobileInfoCard>
                    )}

                    {}
                    <MobileInfoCard caption={t('chat.modelControls.limits')}>
                        <div className="flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.context')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatTokens(currentMetadata?.limit?.context)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.output')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatTokens(currentMetadata?.limit?.output)}</span>
                            </div>
                        </div>
                    </MobileInfoCard>

                    {pickerHarnessId !== 'claude-code' ? (
                        <MobileInfoCard caption={t('chat.modelControls.metadata')}>
                            <div className="flex flex-col gap-0.5">
                                <div className="flex items-center justify-between">
                                    <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.knowledge')}</span>
                                    <span className="typography-meta font-medium text-foreground">{formatKnowledge(currentMetadata?.knowledge)}</span>
                                </div>
                                <div className="flex items-center justify-between">
                                    <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.release')}</span>
                                    <span className="typography-meta font-medium text-foreground">{formatDate(currentMetadata?.release_date)}</span>
                                </div>
                            </div>
                        </MobileInfoCard>
                    ) : null}
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderMobileAgentTooltip = () => {
        if (!isCompact || mobileTooltipOpen !== 'agent' || !currentAgent) return null;

        const hasCustomPrompt = Boolean(currentAgent.prompt && currentAgent.prompt.trim().length > 0);
        const hasModelConfig = currentAgent.model?.providerID && currentAgent.model?.modelID;
        const hasTemperatureOrTopP = currentAgent.temperature !== undefined || currentAgent.topP !== undefined;

        const summarizePermission = (permissionName: string): { mode: EditPermissionMode; label: string } => {
            const rules = asPermissionRuleset(currentAgent.permission) ?? [];
            const hasCustom = rules.some((rule) => rule.permission === permissionName && rule.pattern !== '*');
            const action = resolveWildcardPermissionAction(rules, permissionName) ?? 'ask';

            if (hasCustom) {
                return { mode: 'ask', label: t('chat.modelControls.permissionLabel.custom') };
            }

            if (action === 'allow') return { mode: 'allow', label: t('chat.modelControls.permissionLabel.allow') };
            if (action === 'deny') return { mode: 'deny', label: t('chat.modelControls.permissionLabel.deny') };
            return { mode: 'ask', label: t('chat.modelControls.permissionLabel.ask') };
        };

        const editPermissionSummary = summarizePermission('edit');
        const bashPermissionSummary = summarizePermission('bash');
        const webfetchPermissionSummary = summarizePermission('webfetch');

        return (
            <MobileOverlayPanel
                open={true}
                onClose={closeMobileTooltip}
                title={capitalizeAgentName(currentAgent.name)}
            >
                <div className="flex flex-col gap-1.5">
                    {}
                    {currentAgent.description && (
                        <MobileInfoCard>
                            <div className="typography-meta text-foreground">{currentAgent.description}</div>
                        </MobileInfoCard>
                    )}

                    {}
                    <MobileInfoCard caption={t('chat.modelControls.mode')} tightCaption>
                        <div className="typography-meta text-foreground font-medium">
                            {currentAgent.mode === 'primary'
                                ? t('chat.modelControls.modeValue.primary')
                                : currentAgent.mode === 'subagent'
                                    ? t('chat.modelControls.modeValue.subagent')
                                    : currentAgent.mode === 'all'
                                        ? t('chat.modelControls.modeValue.all')
                                        : t('chat.modelControls.modeValue.none')}
                        </div>
                    </MobileInfoCard>

                    {}
                    {(hasModelConfig || hasTemperatureOrTopP) && (
                        <MobileInfoCard caption={t('chat.modelControls.model')}>
                            {hasModelConfig && (
                                <div className="typography-meta text-foreground font-medium mb-1">
                                    {currentAgent.model!.providerID} / {currentAgent.model!.modelID}
                                </div>
                            )}
                            {hasTemperatureOrTopP && (
                                <div className="flex flex-col gap-0.5">
                                    {currentAgent.temperature !== undefined && (
                                        <div className="flex items-center justify-between">
                                            <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.temperature')}</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.temperature}</span>
                                        </div>
                                    )}
                                    {currentAgent.topP !== undefined && (
                                        <div className="flex items-center justify-between">
                                            <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.topP')}</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.topP}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </MobileInfoCard>
                    )}

                    {}
                    <MobileInfoCard caption={t('chat.modelControls.permissions')}>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.edit')}</span>
                                <div className="flex items-center gap-1.5">
                                    <EditModeIcon mode={editPermissionSummary.mode} className="size-3.5" />
                                    <span className="typography-meta font-medium text-foreground">
                                        {editPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.bash')}</span>
                                <div className="flex items-center gap-1.5">
                                    <EditModeIcon mode={bashPermissionSummary.mode} className="size-3.5" />
                                    <span className="typography-meta font-medium text-foreground">
                                        {bashPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.webFetch')}</span>
                                <div className="flex items-center gap-1.5">
                                    <EditModeIcon mode={webfetchPermissionSummary.mode} className="size-3.5" />
                                    <span className="typography-meta font-medium text-foreground">
                                        {webfetchPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </MobileInfoCard>

                    {}
                    {hasCustomPrompt && (
                        <MobileInfoCard>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.customPrompt')}</span>
                                <Icon name="checkbox-circle" className="size-4 text-foreground" />
                            </div>
                        </MobileInfoCard>
                    )}
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderMobileModelPanel = () => {
        if (!isCompact) return null;

        const normalizedQuery = mobileModelQuery.trim();
        const filteredFavorites = favoriteModelsList.filter(({ model, providerID, target }) => {
            if (pickerHarnessId === 'claude-code' ? target.harnessId !== 'claude-code' : target.harnessId !== 'opencode') {
                return false;
            }
            const provider = providers.find((entry) => entry.id === providerID);
            const providerName = provider?.name || providerID;
            const modelName = getModelDisplayName(model);
            return normalizedQuery.length === 0
                || matchesModelSearch(modelName, normalizedQuery)
                || matchesModelSearch(providerName, normalizedQuery);
        });

        const filteredRecents = recentModelsList.filter(({ model, providerID, target }) => {
            if (pickerHarnessId === 'claude-code' ? target.harnessId !== 'claude-code' : target.harnessId !== 'opencode') {
                return false;
            }
            const provider = providers.find((entry) => entry.id === providerID);
            const providerName = provider?.name || providerID;
            const modelName = getModelDisplayName(model);
            return normalizedQuery.length === 0
                || matchesModelSearch(modelName, normalizedQuery)
                || matchesModelSearch(providerName, normalizedQuery);
        });

        const filteredProviders: {
            provider: (typeof visibleProviders)[number];
            providerModels: ProviderModel[];
            matchesProvider: boolean;
        }[] = [];
        for (const provider of visibleProviders) {
            const providerModels = Array.isArray(provider.models) ? provider.models : [];
            const matchesProvider = normalizedQuery.length === 0
                ? true
                : matchesModelSearch(provider.name, normalizedQuery) || matchesModelSearch(provider.id, normalizedQuery);
            const matchingModels = normalizedQuery.length === 0
                ? providerModels
                : providerModels.filter((model: ProviderModel) => {
                    const name = getModelDisplayName(model);
                    const id = typeof model.id === 'string' ? model.id : '';
                    return matchesModelSearch(name, normalizedQuery) || matchesModelSearch(id, normalizedQuery);
                });
            const resolvedModels = matchesProvider && normalizedQuery.length > 0 ? providerModels : matchingModels;
            if (matchesProvider || resolvedModels.length > 0) {
                filteredProviders.push({ provider, providerModels: resolvedModels, matchesProvider });
            }
        }

        const focusMobileComposer = () => {
            requestAnimationFrame(() => {
                const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
                textarea?.focus();
            });
        };

        const handleMobileModelApply = (providerId: string, modelId: string, variant: string | undefined) => {
            if (providerId === CLAUDE_PICKER_PROVIDER_ID || pickerHarnessId === 'claude-code') {
                handleProviderAndModelChange(CLAUDE_PICKER_PROVIDER_ID, modelId);
                setExpandedMobileModelKey(null);
                return;
            }
            const result = applyModelSelectionWithVariant(providerId, modelId, variant);
            if (result !== 'applied') {
                if (result === 'provider-missing') {
                    console.error('[ModelControls] Provider not available for selection:', providerId);
                } else if (result === 'model-missing') {
                    console.error('[ModelControls] Model not available for selection:', { providerId, modelId });
                }
                return;
            }
            setPickerHarnessId('opencode');
            persistTarget(buildOpenCodeExecutionTarget({
                providerID: providerId,
                modelID: modelId,
                variant,
            }));

            setExpandedMobileModelKey(null);
            closeMobilePanel();
            focusMobileComposer();
        };

        const openMobileVariantOverflow = (providerId: string, modelId: string) => {
            setMobileVariantTarget({ providerId, modelId });
            setActiveMobilePanel('variant');
        };

        const renderMobileModelRow = ({
            model,
            providerId,
            modelId,
            showProviderLogo,
        }: {
            model: ProviderModel;
            providerId: string;
            modelId: string;
            showProviderLogo: boolean;
        }) => {
            const rowKey = buildModelRefKey(providerId, modelId);
            const isClaudeRow = providerId === CLAUDE_PICKER_PROVIDER_ID;
            const isSelected = isClaudeRow
                ? pickerHarnessId === 'claude-code' && modelId === claudeModelRef
                : pickerHarnessId === 'opencode' && providerId === currentProviderId && modelId === currentModelId;
            const metadata = isClaudeRow
                ? buildClaudeModelMetadata(resolveClaudeCatalogModel(claudeCatalogModels, modelId))
                : mergeModelMetadataWithLiveModel(providerId, model, getModelMetadata(providerId, modelId));
            const variantOptions = isClaudeRow ? [] : getModelVariantOptions(providerId, modelId);
            const hasVariants = variantOptions.length > 0;
            const resolvedVariant = resolveModelVariantSelection(providerId, modelId);
            const variantLabel = hasVariants ? formatEffortLabel(resolvedVariant) : null;
            const isExpanded = expandedMobileModelKey === rowKey;
            const inlineVariantOptions = [undefined, ...variantOptions].slice(0, MAX_INLINE_MOBILE_VARIANT_OPTIONS);
            const hasVariantOverflow = inlineVariantOptions.length < variantOptions.length + 1;
            const capabilityIcons = getCapabilityIcons(metadata).map((icon) => ({
                ...icon,
                label: localizeMetaLabel(icon.label),
            }));
            const modalityIcons = [
                ...getModalityIcons(metadata, 'input').map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
                ...getModalityIcons(metadata, 'output').map((icon) => ({ ...icon, label: localizeMetaLabel(icon.label) })),
            ];
            const indicatorIcons = Array.from(
                new Map([...capabilityIcons, ...modalityIcons].map((icon) => [icon.key, icon])).values()
            );
            const contextText = metadata?.limit?.context
                ? `${formatTokens(metadata.limit.context)} ${t('chat.modelControls.contextAbbr')}`
                : null;

            return (
                <div
                    key={`mobile-model-${providerId}-${modelId}`}
                    className={cn(
                        'border-b border-border/30 last:border-b-0',
                        isSelected && 'bg-interactive-selection/15 text-interactive-selection-foreground'
                    )}
                >
                    <div className="flex items-center gap-2 px-2 py-1.5">
                        <button
                            type="button"
                            onClick={() => handleMobileModelApply(providerId, modelId, resolvedVariant)}
                            className={cn(
                                'flex flex-1 min-w-0 items-start gap-2 text-left',
                                'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary rounded-lg'
                            )}
                        >
                            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                                <div className="flex min-w-0 items-center gap-1.5">
                                    {isClaudeRow ? (
                                        <EngineLogo harnessId="claude-code" className="size-3.5 flex-shrink-0" />
                                    ) : showProviderLogo ? (
                                        <ProviderLogo providerId={providerId} className="size-3.5 flex-shrink-0" />
                                    ) : null}
                                    <span className="typography-meta font-medium text-foreground truncate">
                                        {getModelDisplayName(model)}
                                    </span>
                                    {isSelected ? <Icon name="check" className="size-4 flex-shrink-0 text-primary" /> : null}
                                </div>
                                {contextText || indicatorIcons.length > 0 ? (
                                    <div className="flex min-w-0 items-center gap-1.5 overflow-hidden typography-micro text-muted-foreground">
                                        {contextText ? (
                                            <span className="whitespace-nowrap flex-shrink-0">
                                                {contextText}
                                            </span>
                                        ) : null}
                                        {contextText && indicatorIcons.length > 0 ? (
                                            <span aria-hidden="true" className="h-3 w-px flex-shrink-0 bg-border/50" />
                                        ) : null}
                                        {indicatorIcons.length > 0 ? (
                                            <div className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap pl-0.5">
                                                {indicatorIcons.map(({ key, icon: iconName, label }) => (
                                                <span
                                                    key={`meta-${providerId}-${modelId}-${key}`}
                                                    className="flex size-4 flex-shrink-0 items-center justify-center text-muted-foreground"
                                                    title={label}
                                                    aria-label={label}
                                                >
                                                    <Icon name={iconName} className="size-3" />
                                                </span>
                                            ))}
                                            </div>
                                        ) : null}
                                    </div>
                                ) : null}
                            </div>
                        </button>
                        {hasVariants ? (
                            <button
                                type="button"
                                onClick={() => setExpandedMobileModelKey((prev) => prev === rowKey ? null : rowKey)}
                                className="flex items-center gap-0.5 typography-micro font-medium text-muted-foreground hover:text-foreground flex-shrink-0"
                                aria-expanded={isExpanded}
                                aria-label={isExpanded ? t('chat.modelControls.hideThinkingModes') : t('chat.modelControls.showThinkingModes')}
                            >
                                <span className="whitespace-nowrap">{variantLabel}</span>
                                {isExpanded ? <Icon name="arrow-down-s" className="size-3.5" /> : <Icon name="arrow-right-s" className="size-3.5" />}
                            </button>
                        ) : null}
                        <div className="flex flex-shrink-0 items-center gap-1.5">
                            <button
                                type="button"
                                onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    toggleFavoriteModel(providerId, modelId);
                                }}
                                className={cn(
                                    'model-favorite-button flex size-5 items-center justify-center hover:text-primary/80 flex-shrink-0',
                                    isFavoriteModel(providerId, modelId) ? 'text-primary' : 'text-muted-foreground'
                                )}
                                aria-label={isFavoriteModel(providerId, modelId)
                                    ? t('chat.modelControls.unfavoriteAria')
                                    : t('chat.modelControls.favoriteAria')}
                                title={isFavoriteModel(providerId, modelId)
                                    ? t('chat.modelControls.removeFromFavorites')
                                    : t('chat.modelControls.addToFavorites')}
                            >
                                {isFavoriteModel(providerId, modelId) ? (
                                    <Icon name="star-fill" className="size-4" />
                                ) : (
                                    <Icon name="star" className="size-4" />
                                )}
                            </button>
                        </div>
                    </div>
                    {isExpanded && hasVariants ? (
                        <div className="border-t border-border/30 p-2">
                            <div className="flex flex-wrap gap-2">
                                {inlineVariantOptions.map((variantOption) => {
                                    const isVariantSelected = variantOption === resolvedVariant || (!variantOption && !resolvedVariant);
                                    return (
                                        <button
                                            key={`${rowKey}-variant-${variantOption ?? 'default'}`}
                                            type="button"
                                            onClick={() => handleMobileModelApply(providerId, modelId, variantOption)}
                                            className={cn(
                                                'inline-flex items-center rounded-full border px-2.5 py-1 typography-meta font-medium',
                                                isVariantSelected
                                                    ? 'border-primary/30 bg-primary/10 text-foreground'
                                                    : 'border-border/40 text-muted-foreground hover:bg-interactive-hover/50'
                                            )}
                                            aria-pressed={isVariantSelected}
                                        >
                                            {formatEffortLabel(variantOption)}
                                        </button>
                                    );
                                })}
                                {hasVariantOverflow ? (
                                    <button
                                        type="button"
                                        onClick={() => openMobileVariantOverflow(providerId, modelId)}
                                        className="inline-flex items-center rounded-full border border-border/40 px-2.5 py-1 typography-meta font-medium text-muted-foreground hover:bg-interactive-hover/50"
                                        aria-label={t('chat.modelControls.moreThinkingModes')}
                                    >
                                        {t('inlineComment.actions.showMore')}
                                    </button>
                                ) : null}
                            </div>
                        </div>
                    ) : null}
                </div>
            );
        };

        const claudeMobileModels = (claudeCatalog?.sections.flatMap((section) => section.models) ?? [])
            .filter((model) => {
                if (normalizedQuery.length === 0) return true;
                return matchesModelSearch(model.name, normalizedQuery) || matchesModelSearch(model.id, normalizedQuery);
            });

        const hasResults = pickerHarnessId === 'claude-code'
            ? claudeMobileModels.length > 0 || filteredFavorites.length > 0 || filteredRecents.length > 0
            : filteredFavorites.length > 0 || filteredRecents.length > 0 || filteredProviders.length > 0;

        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'model'}
                onClose={closeMobilePanel}
                title={t('chat.modelControls.selectModel')}
            >
                <div className="flex flex-col gap-2">
                    <div>
                        <div className="relative">
                            <Icon name="search" className="absolute left-2 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                            <Input
                                value={mobileModelQuery}
                                onChange={(event) => {
                                    setMobileModelQuery(event.target.value);
                                    setExpandedMobileModelKey(null);
                                }}
                                        placeholder={t('chat.modelControls.searchProvidersOrModels')}
                                className="pl-7 h-9 rounded-xl border-border/40 bg-[var(--surface-elevated)] typography-meta"
                            />
                            {mobileModelQuery && (
                                <button
                                    type="button"
                                    onClick={() => {
                                        setMobileModelQuery('');
                                        setExpandedMobileModelKey(null);
                                    }}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                    aria-label={t('chat.modelControls.clearSearch')}
                                >
                                    <Icon name="close-circle" className="size-4" />
                                </button>
                            )}
                        </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5 px-0.5">
                        <Button
                            type="button"
                            variant="chip"
                            size="xs"
                            aria-pressed={pickerHarnessId === 'opencode'}
                            onClick={() => handleSelectEngine('opencode')}
                            className="gap-1.5"
                        >
                            <EngineLogo harnessId="opencode" className="size-3.5" />
                            {t('chat.engines.opencode')}
                        </Button>
                        {enginesClaudeCodeEnabled ? (
                            <Button
                                type="button"
                                variant="chip"
                                size="xs"
                                aria-pressed={pickerHarnessId === 'claude-code'}
                                onClick={() => handleSelectEngine('claude-code')}
                                className="gap-1.5"
                            >
                                <EngineLogo harnessId="claude-code" className="size-3.5" />
                                {t('chat.engines.claudeCode')}
                                {claudeCatalog ? (
                                    <span className="typography-micro text-muted-foreground ml-1">
                                        {t(ENGINE_STATUS_LABEL_KEYS[claudeCatalog.status])}
                                    </span>
                                ) : null}
                            </Button>
                        ) : null}
                    </div>

                    {!hasResults && (
                        <div className="px-3 py-8 text-center typography-meta text-muted-foreground">
                            {t('chat.modelControls.noProvidersOrModelsFound')}
                        </div>
                    )}

                    {/* Favorites Section for Mobile */}
                    {filteredFavorites.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                <Icon name="star-fill" className="size-3 inline-block mr-1.5 text-primary" />
                                {t('chat.modelControls.favorites')}
                            </div>
                            <div className="flex flex-col border-t border-border/30">
                                {filteredFavorites.map(({ model, providerID, modelID }) => renderMobileModelRow({
                                    model,
                                    providerId: providerID,
                                    modelId: modelID,
                                    showProviderLogo: providerID !== CLAUDE_PICKER_PROVIDER_ID,
                                }))}
                            </div>
                        </div>
                    )}

                    {/* Recent Section for Mobile */}
                    {filteredRecents.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                <Icon name="time" className="size-3 inline-block mr-1.5" />
                                {t('chat.modelControls.recent')}
                            </div>
                            <div className="flex flex-col border-t border-border/30">
                                {filteredRecents.map(({ model, providerID, modelID }) => renderMobileModelRow({
                                    model,
                                    providerId: providerID,
                                    modelId: modelID,
                                    showProviderLogo: providerID !== CLAUDE_PICKER_PROVIDER_ID,
                                }))}
                            </div>
                        </div>
                    )}

                    {pickerHarnessId === 'claude-code' && claudeMobileModels.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                                <EngineLogo harnessId="claude-code" className="size-3" />
                                {t('chat.engines.claudeCode')}
                            </div>
                            <div className="flex flex-col border-t border-border/30">
                                {claudeMobileModels.map((model) => renderMobileModelRow({
                                    model: { id: model.id, name: model.name },
                                    providerId: CLAUDE_PICKER_PROVIDER_ID,
                                    modelId: model.id,
                                    showProviderLogo: false,
                                }))}
                            </div>
                        </div>
                    )}

                    {pickerHarnessId === 'opencode' && filteredProviders.map(({ provider, providerModels }) => {
                        if (providerModels.length === 0) {
                            return null;
                        }

                        const isActiveProvider = provider.id === currentProviderId;
                        const isExpanded = expandedMobileProviders.has(provider.id) || normalizedQuery.length > 0;

                         return (
                             <div key={provider.id} className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => {
                                        if (normalizedQuery.length > 0) {
                                            return;
                                        }
                                        toggleMobileProviderExpansion(provider.id);
                                    }}
                                    className="flex w-full items-center justify-between gap-1.5 px-2 py-1.5 text-left"
                                    aria-expanded={isExpanded}
                                >
                                    <div className="flex items-center gap-2">
                                        <ProviderLogo
                                            providerId={provider.id}
                                            className="size-3.5"
                                        />
                                        <span className="typography-meta font-medium text-foreground">
                                            {provider.name}
                                        </span>
                                        {isActiveProvider && (
                                            <span className="typography-micro text-primary/80">{t('chat.modelControls.current')}</span>
                                        )}
                                    </div>
                                    {isExpanded ? (
                                        <Icon name="arrow-down-s" className="size-3 text-muted-foreground" />
                                    ) : (
                                        <Icon name="arrow-right-s" className="size-3 text-muted-foreground" />
                                    )}
                                </button>

                                {isExpanded && providerModels.length > 0 && (
                                    <div className="flex flex-col border-t border-border/30">
                                        {providerModels.map((model: ProviderModel) => renderMobileModelRow({
                                            model,
                                            providerId: provider.id as string,
                                            modelId: model.id as string,
                                            showProviderLogo: false,
                                        }))}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    <div className="flex flex-col gap-1 pt-1">
                        <button
                            type="button"
                            onClick={openEnginesSettings}
                            className="typography-meta flex w-full items-center gap-2 rounded-xl border border-border/40 bg-[var(--surface-elevated)] px-3 py-2 text-left hover:bg-interactive-hover/50"
                        >
                            <Icon name="settings-3" className="size-4 text-muted-foreground" />
                            <span className="font-medium text-foreground">{t('chat.engines.manageEngines')}</span>
                        </button>
                        {pickerHarnessId === 'opencode' ? (
                            <button
                                type="button"
                                onClick={openAddProviderSettings}
                                className="typography-meta flex w-full items-center gap-2 rounded-xl border border-border/40 bg-[var(--surface-elevated)] px-3 py-2 text-left hover:bg-interactive-hover/50"
                            >
                                <Icon name="add" className="size-4 text-muted-foreground" />
                                <span className="font-medium text-foreground">{t('chat.modelControls.addNewProvider')}</span>
                            </button>
                        ) : null}
                    </div>
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderMobileVariantPanel = () => {
        if (!isCompact) return null;

        const targetProviderId = mobileVariantTarget?.providerId ?? currentProviderId;
        const targetModelId = mobileVariantTarget?.modelId ?? currentModelId;
        if (!targetProviderId || !targetModelId) return null;

        const targetVariants = getModelVariantOptions(targetProviderId, targetModelId);
        if (targetVariants.length === 0) return null;

        const selectedVariant = resolveModelVariantSelection(targetProviderId, targetModelId);
        const isDefault = !selectedVariant;

        const handleBack = () => {
            setActiveMobilePanel('model');
        };

        const handleSelect = (variant: string | undefined) => {
            const result = applyModelSelectionWithVariant(targetProviderId, targetModelId, variant);
            if (result !== 'applied') {
                return;
            }

            closeMobilePanel();
            requestAnimationFrame(() => {
                const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
                textarea?.focus();
            });
        };

        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'variant'}
                onClose={closeMobilePanel}
                title={t('chat.modelControls.thinking')}
                renderHeader={mobileVariantTarget ? ((closeButton) => (
                    <div className="flex items-center justify-between px-3 py-2 border-b border-border/40">
                        <button
                            type="button"
                            onClick={handleBack}
                            className="flex items-center gap-1 rounded-lg px-1.5 py-1 typography-meta text-muted-foreground hover:bg-interactive-hover"
                        >
                            <Icon name="arrow-go-back" className="size-4" />
                            <span>{t('onboarding.common.actions.back')}</span>
                        </button>
                        <h2 className="typography-ui-label font-semibold text-foreground">{t('chat.modelControls.thinking')}</h2>
                        {closeButton}
                    </div>
                )) : undefined}
            >
                <div className="flex flex-col gap-1.5">
                    <button
                        type="button"
                        className={cn(
                            'flex w-full items-center justify-between gap-2 rounded-xl border px-2 py-1.5 text-left',
                            'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                            isDefault ? 'border-primary/30 bg-primary/10' : 'border-border/40'
                        )}
                        onClick={() => handleSelect(undefined)}
                    >
                        <span className="typography-meta font-medium text-foreground">{t('chat.modelControls.default')}</span>
                        {isDefault && <Icon name="check" className="size-4 text-primary flex-shrink-0" />}
                    </button>

                    {targetVariants.map((variant) => {
                        const selected = selectedVariant === variant;
                        const label = formatEffortLabel(variant);

                        return (
                            <button
                                key={variant}
                                type="button"
                                className={cn(
                                    'flex w-full items-center justify-between gap-2 rounded-xl border px-2 py-1.5 text-left',
                                    'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                                    selected ? 'border-primary/30 bg-primary/10' : 'border-border/40'
                                )}
                                onClick={() => handleSelect(variant)}
                            >
                                <span className="typography-meta font-medium text-foreground">{label}</span>
                                {selected && <Icon name="check" className="size-4 text-primary flex-shrink-0" />}
                            </button>
                        );
                    })}
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderMobileAgentPanel = () => {
        if (!isCompact) return null;
        if (pickerHarnessId === 'claude-code' && claudeAgentsMode === 'claude') return null;

        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'agent'}
                onClose={closeMobilePanel}
                title={t('chat.modelControls.selectAgent')}
                contentMaxHeightClassName="max-h-[min(52dvh,360px)]"
            >
                <div className="flex flex-col gap-2">
                    {selectableDesktopAgents.map((agent) => {
                        const isSelected = agent.name === uiAgentName;
                        const agentColor = getAgentColor(agent.name);
                        return (
                            <button
                                key={agent.name}
                                type="button"
                                className={cn(
                                    'flex w-full flex-col gap-1.5 rounded-xl border px-3 py-2.5 text-left',
                                    'focus:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                                    'touch-manipulation cursor-pointer transition-colors',
                                    'active:bg-interactive-hover',
                                    isSelected 
                                        ? 'border-primary/50 bg-interactive-selection/20' 
                                        : 'border-border/40 hover:bg-interactive-hover/50'
                                )}
                                onClick={() => handleAgentChange(agent.name)}
                            >
                                <div className="flex items-center gap-2">
                                    <div className={cn('size-2.5 rounded-full flex-shrink-0', agentColor.class)} />
                                    <span
                                        className="typography-ui-label font-semibold"
                                        style={isSelected ? { color: `var(${agentColor.var})` } : undefined}
                                    >
                                        {capitalizeAgentName(agent.name)}
                                    </span>
                                    {isSelected && (
                                        <Icon name="check" className="size-4 text-primary ml-auto flex-shrink-0" />
                                    )}
                                </div>
                                {agent.description && (
                                    <span className="typography-meta text-muted-foreground pl-4.5">
                                        {agent.description}
                                    </span>
                                )}
                            </button>
                        );
                    })}
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderModelTooltipContent = () => (
        <TooltipContent align="start" sideOffset={8} className="max-w-[320px]">
            {currentMetadata ? (
                <div className="flex min-w-[240px] flex-col gap-3">
                    <div className="flex flex-col gap-0.5">
                        <span className="typography-micro font-semibold text-foreground">
                            {currentMetadata.name || getCurrentModelDisplayName()}
                        </span>
                        <span className="typography-meta text-muted-foreground">{getProviderDisplayName()}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.capabilities')}</span>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {currentCapabilityIcons.length > 0 ? (
                                currentCapabilityIcons.map(({ key, icon, label }) =>
                                    <IconBadge key={`cap-${key}`} iconName={icon} label={label} />
                                )
                            ) : (
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.modeValue.none')}</span>
                            )}
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.modalities')}</span>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{t('chat.modelControls.input')}</span>
                                <div className="flex items-center gap-1.5">
                                    {inputModalityIcons.length > 0
                                        ? inputModalityIcons.map(({ key, icon, label }) =>
                                              <IconBadge
                                                key={`input-${key}`}
                                                iconName={icon}
                                                label={t('chat.modelControls.modalityInputAria', { modality: label })}
                                              />
                                          )
                                        : <span className="typography-meta text-muted-foreground">-</span>}
                                </div>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{t('chat.modelControls.output')}</span>
                                <div className="flex items-center gap-1.5">
                                    {outputModalityIcons.length > 0
                                        ? outputModalityIcons.map(({ key, icon, label }) =>
                                              <IconBadge
                                                key={`output-${key}`}
                                                iconName={icon}
                                                label={t('chat.modelControls.modalityOutputAria', { modality: label })}
                                              />
                                          )
                                        : <span className="typography-meta text-muted-foreground">-</span>}
                                </div>
                            </div>
                        </div>
                    </div>
                    {pickerHarnessId !== 'claude-code' ? (
                        <div className="flex flex-col gap-1.5">
                            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.costPerMillion')}</span>
                            {costRows.map((row) => (
                                <div key={row.label} className="flex items-center justify-between gap-3">
                                    <span className="typography-meta font-medium text-muted-foreground/80">{row.label}</span>
                                    <span className="typography-meta font-medium text-foreground">{row.value}</span>
                                </div>
                            ))}
                        </div>
                    ) : null}
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.limits')}</span>
                        {limitRows.map((row) => (
                            <div key={row.label} className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{row.label}</span>
                                <span className="typography-meta font-medium text-foreground">{row.value}</span>
                            </div>
                        ))}
                    </div>
                    {pickerHarnessId !== 'claude-code' ? (
                        <div className="flex flex-col gap-1.5">
                            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.metadata')}</span>
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{t('chat.modelControls.knowledge')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatKnowledge(currentMetadata.knowledge)}</span>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{t('chat.modelControls.release')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatDate(currentMetadata.release_date)}</span>
                            </div>
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="min-w-[200px] typography-meta text-muted-foreground">{t('chat.modelControls.metadataUnavailable')}</div>
            )}
        </TooltipContent>
    );

    const renderModelSelector = () => {
        const handleThinkingVariantKey = (e: React.KeyboardEvent, selectedItem: ModelPickerEntry) => {
            keyboardOwnsModelSelectionRef.current = true;
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;

            const { providerID, modelID } = selectedItem;
            const canonicalProvider = useConfigStore.getState().providers.find((provider) => provider.id === providerID);
            const canonicalModel = canonicalProvider?.models.find((model) => model.id === modelID) as { variants?: Record<string, unknown> } | undefined;
            const variantKeys = canonicalModel?.variants ? Object.keys(canonicalModel.variants) : getModelVariantOptions(providerID, modelID);
            if (variantKeys.length === 0) return false;

            e.preventDefault();
            e.stopPropagation();

            const mapKey = buildModelRefKey(providerID, modelID);
            const hasPendingVariant = pendingThinkingVariants.has(mapKey);
            const currentPending = pendingThinkingVariants.get(mapKey);
            const activeModelVariant = hasPendingVariant ? currentPending : (currentProviderId === providerID && currentModelId === modelID ? currentVariant : undefined);

            const variantsWithDefault: Array<string | undefined> = [undefined, ...variantKeys];
            const currentVariantIndex = variantsWithDefault.indexOf(activeModelVariant);
            const safeCurrentIndex = currentVariantIndex >= 0 ? currentVariantIndex : 0;
            const direction = e.key === 'ArrowRight' ? 1 : -1;
            const nextVariantIndex = (safeCurrentIndex + direction + variantsWithDefault.length) % variantsWithDefault.length;
            const nextVariant = variantsWithDefault[nextVariantIndex];

            setPendingThinkingVariants((prev) => {
                const next = new Map(prev);
                next.set(mapKey, nextVariant);
                return next;
            });
            setAdjustedThinkingModels((prev) => {
                const next = new Set(prev);
                next.add(mapKey);
                return next;
            });
            setModelPickerRenderVersion((version) => version + 1);
            return true;
        };

        const handleModelPickerKeyDown = (e: React.KeyboardEvent, selectedItem: ModelPickerEntry | undefined) => {
            const cycleAgentDirection = getCycleAgentDirectionFromEvent(e);
            if (cycleAgentDirection) {
                e.preventDefault();
                handleCycleAgentFromModelPicker(cycleAgentDirection);
                return;
            }

            if (selectedItem) handleThinkingVariantKey(e, selectedItem);
        };

        const handleSharedModelSelect = (entry: ModelPickerEntry) => {
            const mapKey = buildModelRefKey(entry.providerID, entry.modelID);
            const pendingVariant = pendingThinkingVariants.get(mapKey);
            const wasAdjusted = adjustedThinkingModels.has(mapKey);
            const effectiveAgentName = resolveLiveAgentName();

            handleProviderAndModelChange(entry.providerID, entry.modelID, wasAdjusted
                ? { applyVariant: true, variant: pendingVariant, agentName: effectiveAgentName }
                : { agentName: effectiveAgentName });
        };

        const handleModelShortcutKeyDownCapture = (e: React.KeyboardEvent) => {
            const cycleAgentDirection = getCycleAgentDirectionFromEvent(e);
            if (!cycleAgentDirection) {
                return;
            }

            e.preventDefault();
            e.stopPropagation();
            keyboardOwnsModelSelectionRef.current = true;
            handleCycleAgentFromModelPicker(cycleAgentDirection);
        };

        const handleModelMenuOpenChange = (nextOpen: boolean) => {
            setAgentMenuOpen(nextOpen);
        };

        const pickerActionsFooter = (
            <>
                <button
                    type="button"
                    onClick={openEnginesSettings}
                    className="typography-meta group flex w-full items-center gap-1 rounded-md px-2 py-1.5 cursor-pointer hover:bg-interactive-hover/50"
                >
                    <span className="flex size-4 items-center justify-center text-muted-foreground">
                        <Icon name="settings-3" className="size-4" />
                    </span>
                    <span className="font-medium text-foreground">{t('chat.engines.manageEngines')}</span>
                </button>
                {pickerHarnessId === 'opencode' ? (
                    <button
                        type="button"
                        onClick={openAddProviderSettings}
                        className="typography-meta group flex w-full items-center gap-1 rounded-md px-2 py-1.5 cursor-pointer hover:bg-interactive-hover/50"
                    >
                        <span className="flex size-4 items-center justify-center text-muted-foreground">
                            <Icon name="add" className="size-4 -mr-0.5" />
                        </span>
                        <span className="font-medium text-foreground">{t('chat.modelControls.addNewProvider')}</span>
                    </button>
                ) : null}
            </>
        );

        const renderThinkingSlot = (entry: ModelPickerEntry, { isHighlighted, isSelected }: { isHighlighted: boolean; isSelected: boolean }) => {
            const hasThinkingVariants = getModelVariantOptions(entry.providerID, entry.modelID).length > 0;
            const mapKey = buildModelRefKey(entry.providerID, entry.modelID);
            const wasAdjusted = adjustedThinkingModels.has(mapKey);
            if (!hasThinkingVariants || (!isHighlighted && !isSelected)) return null;

            const hasPendingVariant = pendingThinkingVariants.has(mapKey);
            const pendingVariant = pendingThinkingVariants.get(mapKey);
            const effectiveVariant = hasPendingVariant ? pendingVariant : (isSelected ? currentVariant : undefined);
            const displayLabel = effectiveVariant
                ? effectiveVariant.charAt(0).toUpperCase() + effectiveVariant.slice(1)
                : t('chat.engines.effort.default');

            return (
                <span className={cn('typography-micro whitespace-nowrap', wasAdjusted ? 'text-foreground' : 'text-muted-foreground')}>
                    {t('chat.modelControls.thinkingValue', { value: displayLabel })}
                </span>
            );
        };

        return (
            <Tooltip delayDuration={600}>
                {!isCompact ? (
                    <DropdownMenu open={isReady && agentMenuOpen} onOpenChange={isReady ? handleModelMenuOpenChange : undefined}>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <div
                                    className={cn(
                                        'model-controls__model-trigger flex items-center gap-1.5 cursor-pointer hover:bg-transparent hover:opacity-70 min-w-0',
                                        buttonHeight
                                    )}
                                >
                                    {!isReady ? (
                                        <>
                                            <Icon name="loader-4" className={cn(controlIconSize, 'animate-spin text-muted-foreground flex-shrink-0')} />
                                            <span className={cn(
                                                'model-controls__model-label',
                                                controlTextSize,
                                                'font-medium whitespace-nowrap text-muted-foreground min-w-0'
                                            )}>
                                                {readinessLabel}
                                            </span>
                                        </>
                                    ) : pickerHarnessId === 'claude-code' ? (
                                        <EngineLogo harnessId="claude-code" className={cn(controlIconSize, 'flex-shrink-0 text-muted-foreground')} />
                                    ) : currentProviderId ? (
                                        <>
                                            <ProviderLogo
                                                providerId={currentProviderId}
                                                className={cn(controlIconSize, 'flex-shrink-0')}
                                            />
                                            <Icon name="pencil-ai" className={cn(controlIconSize, 'text-primary/60 hidden')} />
                                        </>
                                    ) : (
                                        <Icon name="pencil-ai" className={cn(controlIconSize, 'text-muted-foreground')} />
                                    )}
                                    {isReady && (
                                        <span
                                            ref={modelLabelRef}
                                            key={`${pickerHarnessId}-${pickerHarnessId === 'claude-code' ? claudeModelRef : `${currentProviderId}-${currentModelId}`}`}
                                            className={cn(
                                                'model-controls__model-label overflow-hidden',
                                                controlTextSize,
                                                'font-medium whitespace-nowrap text-foreground min-w-0',
                                                'max-w-[260px]'
                                            )}
                                        >
                                            <span className={cn('marquee-text', isModelLabelTruncated && 'marquee-text--active')}>
                                                {currentModelDisplayName}
                                            </span>
                                        </span>
                                    )}
                                </div>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <DropdownMenuContent
                            className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col"
                            align="end"
                            alignOffset={-40}
                            onKeyDownCapture={handleModelShortcutKeyDownCapture}
                        >
                            <ModelPickerList
                                providers={pickerProviders}
                                favoriteModels={pickerFavoriteModels}
                                recentModels={pickerRecentModels}
                                modelsMetadata={pickerHarnessId === 'claude-code'
                                    ? claudeModelsMetadata
                                    : useConfigStore.getState().modelsMetadata}
                                searchQuery={desktopModelQuery}
                                onSearchQueryChange={setDesktopModelQuery}
                                onSelect={handleSharedModelSelect}
                                labels={modelPickerLabels}
                                selectedModel={pickerSelectedModel}
                                hiddenModels={pickerHarnessId === 'opencode' ? hiddenModels : []}
                                onActiveKeyDown={handleModelPickerKeyDown}
                                onActiveEntryChange={(entry) => { activeModelPickerEntryRef.current = entry; }}
                                onVariantKey={pickerHarnessId === 'opencode' ? handleThinkingVariantKey : undefined}
                                isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
                                onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
                                renderRowEnd={pickerHarnessId === 'opencode' ? renderThinkingSlot : undefined}
                                renderVersion={modelPickerRenderVersion}
                                onReorderFavorite={(active, over) => reorderFavoriteModel(
                                    active.providerID,
                                    active.modelID,
                                    over.providerID,
                                    over.modelID,
                                )}
                                reorderFavoriteAriaLabel={t('chat.modelControls.reorderFavoriteAria')}
                                reorderFavoriteTitle={t('chat.modelControls.reorderFavoriteTitle')}
                                providerOrder={pickerHarnessId === 'opencode' ? providerOrder : undefined}
                                onReorderProvider={pickerHarnessId === 'opencode' ? setProviderOrder : undefined}
                                reorderProviderTitle={t('chat.modelControls.reorderProviderTitle')}
                                engines={engineOptions}
                                onSelectEngine={handleSelectEngine}
                                actionsFooter={pickerActionsFooter}
                                footerContent={(activeEntry) => {
                                    const activeHasThinkingVariants = pickerHarnessId === 'opencode' && activeEntry
                                        ? getModelVariantOptions(activeEntry.providerID, activeEntry.modelID).length > 0
                                        : false;

                                    return (
                                        <div className="flex items-center gap-x-2 whitespace-nowrap overflow-hidden">
                                            <span>{t('chat.modelControls.keyboardHintNavigate')}</span>
                                            {pickerHarnessId === 'opencode' ? (
                                                <span>{t('chat.modelControls.keyboardHintSwitchAgent', { shortcut: 'Tab' })}</span>
                                            ) : null}
                                            {activeHasThinkingVariants ? <span>{t('chat.modelControls.keyboardHintThinking')}</span> : null}
                                        </div>
                                    );
                                }}
                                tooltipsEnabled={agentMenuOpen}
                                onEscape={() => setAgentMenuOpen(false)}
                            />
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : (
                    <button
                        type="button"
                        onClick={isReady ? () => setActiveMobilePanel('model') : undefined}
                        onTouchStart={isReady ? () => handleLongPressStart('model') : undefined}
                        onTouchEnd={isReady ? handleLongPressEnd : undefined}
                        onTouchCancel={isReady ? handleLongPressEnd : undefined}
                        disabled={!isReady}
                        className={cn(
                            'model-controls__model-trigger flex items-center gap-1.5 min-w-0 focus:outline-none',
                            isReady ? 'cursor-pointer hover:bg-transparent hover:opacity-70' : 'opacity-60 cursor-not-allowed',
                            buttonHeight
                        )}
                    >
                        {!isReady ? (
                            <>
                                <Icon name="loader-4" className={cn(controlIconSize, 'animate-spin text-muted-foreground flex-shrink-0')} />
                                <span className="typography-micro font-medium text-muted-foreground min-w-0">
                                    {readinessLabel}
                                </span>
                            </>
                        ) : (
                            <>
                                {pickerHarnessId === 'claude-code' ? (
                                    <EngineLogo harnessId="claude-code" className={cn(controlIconSize, 'flex-shrink-0 text-muted-foreground')} />
                                ) : currentProviderId ? (
                                    <ProviderLogo
                                        providerId={currentProviderId}
                                        className={cn(controlIconSize, 'flex-shrink-0')}
                                    />
                                ) : (
                                    <Icon name="pencil-ai" className={cn(controlIconSize, 'text-muted-foreground')} />
                                )}
                                <span
                                    ref={modelLabelRef}
                                    className={cn(
                                        'model-controls__model-label typography-micro font-medium overflow-hidden min-w-0',
                                        isMobile ? 'max-w-[120px]' : 'max-w-[220px]',
                                    )}
                                >
                                    <span className={cn('marquee-text', isModelLabelTruncated && 'marquee-text--active')}>
                                        {currentModelDisplayName}
                                    </span>
                                </span>
                            </>
                        )}
                    </button>
                )}
                {renderModelTooltipContent()}
            </Tooltip>
        );
    };

    const renderAgentTooltipContent = () => {
        if (!currentAgent) {
            return (
                <TooltipContent align="start" sideOffset={8} className="max-w-[320px]">
                    <div className="min-w-[200px] typography-meta text-muted-foreground">{t('chat.modelControls.noAgentSelected')}</div>
                </TooltipContent>
            );
        }

        const hasCustomPrompt = Boolean(currentAgent.prompt && currentAgent.prompt.trim().length > 0);
        const hasModelConfig = currentAgent.model?.providerID && currentAgent.model?.modelID;
        const hasTemperatureOrTopP = currentAgent.temperature !== undefined || currentAgent.topP !== undefined;

        const summarizePermission = (permissionName: string): { mode: EditPermissionMode; label: string } => {
            const rules = asPermissionRuleset(currentAgent.permission) ?? [];
            const hasCustom = rules.some((rule) => rule.permission === permissionName && rule.pattern !== '*');
            const action = resolveWildcardPermissionAction(rules, permissionName) ?? 'ask';

            if (hasCustom) {
                                return { mode: 'ask', label: t('chat.modelControls.permissionLabel.custom') };
                            }

            if (action === 'allow') return { mode: 'allow', label: t('chat.modelControls.permissionLabel.allow') };
            if (action === 'deny') return { mode: 'deny', label: t('chat.modelControls.permissionLabel.deny') };
            return { mode: 'ask', label: t('chat.modelControls.permissionLabel.ask') };
        };

        const editPermissionSummary = summarizePermission('edit');
        const bashPermissionSummary = summarizePermission('bash');
        const webfetchPermissionSummary = summarizePermission('webfetch');

        return (
            <TooltipContent align="start" sideOffset={8} className="max-w-[280px]">
                <div className="flex min-w-[200px] flex-col gap-2.5">
                    <div className="flex flex-col gap-0.5">
                        <span className="typography-micro font-semibold text-foreground">
                            {capitalizeAgentName(currentAgent.name)}
                        </span>
                        {currentAgent.description && (
                            <span className="typography-meta text-muted-foreground">{currentAgent.description}</span>
                        )}
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.mode')}</span>
                        <span className="typography-meta text-foreground">
                            {currentAgent.mode === 'primary'
                                ? t('chat.modelControls.modeValue.primary')
                                : currentAgent.mode === 'subagent'
                                    ? t('chat.modelControls.modeValue.subagent')
                                    : currentAgent.mode === 'all'
                                        ? t('chat.modelControls.modeValue.all')
                                        : t('chat.modelControls.modeValue.none')}
                        </span>
                    </div>

                    {(hasModelConfig || hasTemperatureOrTopP) && (
                        <div className="flex flex-col gap-1">
                            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.model')}</span>
                            {hasModelConfig ? (
                                <span className="typography-meta text-foreground">
                                    {currentAgent.model!.providerID} / {currentAgent.model!.modelID}
                                </span>
                            ) : (
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.modeValue.none')}</span>
                            )}
                            {hasTemperatureOrTopP && (
                                <div className="flex flex-col gap-0.5 mt-0.5">
                                    {currentAgent.temperature !== undefined && (
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.temperature')}</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.temperature}</span>
                                        </div>
                                    )}
                                    {currentAgent.topP !== undefined && (
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.topP')}</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.topP}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="flex flex-col gap-1">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">{t('chat.modelControls.permissions')}</span>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground/80 w-16">{t('chat.modelControls.edit')}</span>
                            <div className="flex items-center gap-1.5">
                                <EditModeIcon mode={editPermissionSummary.mode} className="size-3.5" />
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {editPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground/80 w-16">{t('chat.modelControls.bash')}</span>
                            <div className="flex items-center gap-1.5">
                                <EditModeIcon mode={bashPermissionSummary.mode} className="size-3.5" />
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {bashPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground/80 w-16">{t('chat.modelControls.webFetch')}</span>
                            <div className="flex items-center gap-1.5">
                                <EditModeIcon mode={webfetchPermissionSummary.mode} className="size-3.5" />
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {webfetchPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                    </div>

                    {hasCustomPrompt && (
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta text-muted-foreground/80">{t('chat.modelControls.customPrompt')}</span>
                            <Icon name="checkbox-circle" className="size-4 text-foreground" />
                        </div>
                    )}
                </div>
            </TooltipContent>
        );
    };

    const renderClaudeEffortSelector = () => {
        if (!isReady || pickerHarnessId !== 'claude-code') {
            return null;
        }
        return (
            <ClaudeEffortSelector
                claudeEffort={claudeEffort}
                onEffortChange={handleClaudeEffortChange}
                isCompact={isCompact}
                isMobile={isMobile}
                isDesktop={isDesktop}
                buttonHeight={buttonHeight}
                controlIconSize={controlIconSize}
                controlTextSize={controlTextSize}
                onOpenMobilePanel={() => setActiveMobilePanel('effort')}
            />
        );
    };

    const renderClaudeEffortMobilePanel = () => {
        if (!isCompact) return null;
        return (
            <ClaudeEffortMobilePanel
                claudeEffort={claudeEffort}
                onEffortChange={handleClaudeEffortChange}
                activeMobilePanel={activeMobilePanel}
                onClose={closeMobilePanel}
            />
        );
    };

    const renderVariantSelector = () => {
        if (!isReady || !hasVariants || pickerHarnessId === 'claude-code') {
            return null;
        }

        const displayVariant = currentVariant ?? t('chat.modelControls.default');
        const isDefault = !currentVariant;
        const colorClass = isDefault ? 'text-muted-foreground' : 'text-[color:var(--status-info)]';

        if (isCompact) {
            return (
                <button
                    type="button"
                    onClick={() => setActiveMobilePanel('variant')}
                    className={cn(
                        'model-controls__variant-trigger flex items-center gap-1.5 transition-opacity min-w-0 focus:outline-none',
                        buttonHeight,
                        'cursor-pointer hover:bg-transparent hover:opacity-70',
                    )}
                >
                    <Icon name="brain-ai-3" className={cn(controlIconSize, 'flex-shrink-0', colorClass)} />
                    <span className={cn(
                        'model-controls__variant-label',
                        controlTextSize,
                        'font-medium truncate min-w-0',
                        isMobile && 'max-w-[60px]',
                        colorClass
                    )}>
                        {displayVariant}
                    </span>
                </button>
            );
        }

        return (
            <Tooltip delayDuration={600}>
                <DropdownMenu>
                    <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                            <div
                                className={cn(
                                    'model-controls__variant-trigger flex items-center gap-1.5 transition-colors cursor-pointer hover:bg-transparent hover:opacity-70 min-w-0',
                                    buttonHeight,
                                )}
                            >
                                <Icon name="brain-ai-3" className={cn(controlIconSize, 'flex-shrink-0', colorClass)} />
                                <span
                                    className={cn(
                                        'model-controls__variant-label',
                                        controlTextSize,
                                        'font-medium min-w-0 truncate',
                                        isDesktop ? 'max-w-[180px]' : undefined,
                                        colorClass,
                                    )}
                                >
                                    {displayVariant}
                                </span>
                            </div>
                        </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <DropdownMenuContent align="end" alignOffset={-40} className="w-[min(180px,calc(100vw-2rem))]">
                        <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">{t('chat.modelControls.thinking')}</DropdownMenuLabel>
                        <DropdownMenuItem className="typography-meta" onSelect={() => handleVariantSelect(undefined)}>
                            <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                <span className="typography-meta font-medium text-foreground truncate min-w-0">{t('chat.modelControls.default')}</span>
                                {isDefault && <Icon name="check" className="size-4 text-primary flex-shrink-0" />}
                            </div>
                        </DropdownMenuItem>
                        {availableVariants.length > 0 && <DropdownMenuSeparator />}
                        {availableVariants.map((variant) => {
                            const selected = currentVariant === variant;
                            const label = variant.charAt(0).toUpperCase() + variant.slice(1);
                            return (
                                <DropdownMenuItem
                                    key={variant}
                                    className="typography-meta"
                                    onSelect={() => handleVariantSelect(variant)}
                                >
                                    <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                        <span className="typography-meta font-medium text-foreground truncate min-w-0">{label}</span>
                                        {selected && <Icon name="check" className="size-4 text-primary flex-shrink-0" />}
                                    </div>
                                </DropdownMenuItem>
                            );
                        })}
                    </DropdownMenuContent>
                </DropdownMenu>
                <TooltipContent side="top">
                    <p className="typography-meta">{t('chat.modelControls.thinkingValue', { value: displayVariant })}</p>
                </TooltipContent>
            </Tooltip>
        );
    };

    const renderAgentSelector = () => {
        // Native Claude agents mode: OpenCode agent picker does not apply.
        if (pickerHarnessId === 'claude-code' && claudeAgentsMode === 'claude') {
            return null;
        }
        if (!isCompact) {
            return (
                <div className="flex items-center gap-2 min-w-0">
                    <Tooltip delayDuration={600}>
                        <DropdownMenu open={isReady && isAgentSelectorOpen} onOpenChange={isReady ? setIsAgentSelectorOpen : undefined}>
                            <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                    <div className={cn(
                                        'flex items-center gap-1.5 transition-colors cursor-pointer hover:bg-transparent hover:opacity-70 min-w-0',
                                        buttonHeight
                                    )}>
                                        {!isReady ? (
                                            <>
                                                <Icon name="loader-4"
                                                    className={cn(
                                                        controlIconSize,
                                                        'flex-shrink-0 animate-spin text-muted-foreground'
                                                    )}
                                                />
                                                <span
                                                    className={cn(
                                                        'model-controls__agent-label',
                                                        controlTextSize,
                                                        'font-medium min-w-0 truncate text-muted-foreground'
                                                    )}
                                                >
                                                    {readinessLabel}
                                                </span>
                                            </>
                                        ) : (
                                            <>
                                                <Icon name="ai-agent"
                                                    className={cn(
                                                        controlIconSize,
                                                        'flex-shrink-0',
                                                        uiAgentName ? '' : 'text-muted-foreground'
                                                    )}
                                                    style={uiAgentName ? { color: `var(${getAgentColor(uiAgentName).var})` } : undefined}
                                                />
                                                <span
                                                    className={cn(
                                                        'model-controls__agent-label',
                                                        controlTextSize,
                                                        'font-medium min-w-0 truncate',
                                                        isDesktop ? 'max-w-[220px]' : undefined
                                                    )}
                                                    style={uiAgentName ? { color: `var(${getAgentColor(uiAgentName).var})` } : undefined}
                                                >
                                                    {getAgentDisplayName()}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <DropdownMenuContent align="end" alignOffset={-40} className="w-[min(280px,calc(100vw-2rem))] p-0 flex flex-col">
                                <div className="p-2 border-b border-border/40">
                                    <div className="relative">
                                        <Icon name="search" className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                                        <Input
                                            type="text"
                                            placeholder={t('chat.modelControls.searchAgents')}
                                            value={agentSearchQuery}
                                            onChange={(e) => setAgentSearchQuery(e.target.value)}
                                            onKeyDown={(e) => {
                                                e.stopPropagation();
                                            }}
                                            className="pl-8 h-8 typography-meta"
                                        />
                                    </div>
                                </div>
                                <ScrollableOverlay outerClassName="max-h-[min(400px,calc(100dvh-12rem))] flex-1">
                                    <div className="p-1">
                                        {!agentSearchQuery.trim() && defaultAgentName && (
                                            <>
                                                <DropdownMenuItem
                                                    className="typography-meta"
                                                    onSelect={() => handleAgentChange(defaultAgentName)}
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <Icon name="arrow-go-back" className="size-3.5 text-muted-foreground" />
                                                        <span className="font-medium">{t('chat.modelControls.resetToDefault')}</span>
                                                    </div>
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                            </>
                                        )}
                                        {sortedAndFilteredAgents.length === 0 ? (
                                            <div className="px-2 py-4 text-center typography-meta text-muted-foreground">
                                                No agents found
                                            </div>
                                        ) : (
                                            sortedAndFilteredAgents.map((agent) => (
                                                <DropdownMenuItem
                                                    key={agent.name}
                                                    className="typography-meta"
                                                    onSelect={() => handleAgentChange(agent.name)}
                                                >
                                                    <div className="flex flex-col gap-0.5">
                                                        <div className="flex items-center gap-1.5">
                                                            <div className={cn(
                                                                'h-1 w-1 rounded-full agent-dot',
                                                                getAgentColor(agent.name).class
                                                            )} />
                                                            <span className="font-medium">{capitalizeAgentName(agent.name)}</span>
                                                        </div>
                                                        {agent.description && (
                                                            <span className="typography-meta text-muted-foreground max-w-[200px] ml-2.5 break-words">
                                                                {agent.description}
                                                            </span>
                                                        )}
                                                    </div>
                                                </DropdownMenuItem>
                                            ))
                                        )}
                                    </div>
                                </ScrollableOverlay>
                            </DropdownMenuContent>
                        </DropdownMenu>
                        {renderAgentTooltipContent()}
                    </Tooltip>
                </div>
            );
        }

        return (
            <button
                type="button"
                onClick={isReady ? () => setActiveMobilePanel('agent') : undefined}
                onTouchStart={isReady ? () => handleLongPressStart('agent') : undefined}
                onTouchEnd={isReady ? handleLongPressEnd : undefined}
                onTouchCancel={isReady ? handleLongPressEnd : undefined}
                disabled={!isReady}
                className={cn(
                    'model-controls__agent-trigger flex items-center gap-1.5 transition-colors min-w-0 focus:outline-none',
                    buttonHeight,
                    isReady ? 'cursor-pointer hover:bg-transparent hover:opacity-70' : 'opacity-60 cursor-not-allowed',
                )}
            >
                {!isReady ? (
                    <>
                        <Icon name="loader-4"
                            className={cn(
                                controlIconSize,
                                'flex-shrink-0 animate-spin text-muted-foreground'
                            )}
                        />
                        <span
                            className={cn(
                                'model-controls__agent-label',
                                controlTextSize,
                                'font-medium truncate min-w-0 text-muted-foreground'
                            )}
                        >
                            {readinessLabel}
                        </span>
                    </>
                ) : (
                    <>
                        <Icon name="ai-agent"
                            className={cn(
                                controlIconSize,
                                'flex-shrink-0',
                                uiAgentName ? '' : 'text-muted-foreground'
                            )}
                            style={uiAgentName ? { color: `var(${getAgentColor(uiAgentName).var})` } : undefined}
                        />
                        <span
                            className={cn(
                                'model-controls__agent-label',
                                controlTextSize,
                                'font-medium truncate min-w-0',
                                isMobile && 'max-w-[60px]'
                            )}
                            style={uiAgentName ? { color: `var(${getAgentColor(uiAgentName).var})` } : undefined}
                        >
                            {getAgentDisplayName()}
                        </span>
                    </>
                )}
            </button>
        );
    };

    const inlineClassName = cn(
        '@container/model-controls flex items-center min-w-0',
        // Only force full-width + truncation behaviors on true mobile layouts.
        // VS Code also uses "compact" mode, but should keep its right-aligned inline sizing.
        isMobile && 'w-full',
        className,
    );

    return (
        <>
            <div className={inlineClassName}>
                <div
                    className={cn(
                        'flex items-center min-w-0 flex-1 justify-end',
                        inlineGapClass,
                        isMobile && 'overflow-hidden'
                    )}
                >
                    {renderClaudeEffortSelector()}
                    {renderClaudeEffortMobilePanel()}
                    {renderVariantSelector()}
                    {renderModelSelector()}
                    {renderAgentSelector()}
                </div>
            </div>

            {renderMobileModelPanel()}
            {renderMobileVariantPanel()}
            {renderMobileAgentPanel()}
            {renderMobileModelTooltip()}
            {renderMobileAgentTooltip()}
        </>
    );

};
