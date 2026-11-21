import { OPENCODE_TOOLS } from '@/lib/opencode/tools';
import React from 'react';
import { useChatColumnActions, useChatSessionSelection } from './chatColumnSession';
import { MobileModelButton } from './MobileModelButton';
import { useAgentMissingFromCatalog, useModelMissingFromCatalog } from './agentAvailability';
import type { EditPermissionMode } from '@/stores/types/sessionTypes';
import type { ModelMetadata } from '@/types';
import type { Agent, Message, PermissionRuleset, Session } from '@/lib/opencode/model';
import type { PermissionEffect } from '@/lib/opencode/model';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { handleDropdownNavigationKey } from '@/components/ui/dropdown-navigation';
import { isIMECompositionEvent } from '@/lib/ime';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow, MobileSheetSection, PICKER_SECTION_HEADER_CLASS } from '@/components/ui/MobileSheetList';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { Spinner } from "@/components/ui/spinner";
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import type { IconName } from "@/components/icon/icons";
import { ModelPickerCardBody, ModelPickerList, type ModelPickerEntry } from '@/components/model-picker/ModelPickerList';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { isDesktopShell } from '@/lib/desktop';
import { useAgentColors } from '@/hooks/useAgentColors';
import { useDeviceInfo } from '@/lib/device';
import { mergeModelMetadataWithLiveModel } from '@/lib/modelMetadata';
import { getModelDisplayName as getSharedModelDisplayName } from '@/lib/modelDisplay';
import { formatCompactNumber } from '@/lib/numberFormat';
import { getEditModeColors } from '@/lib/permissions/editModeColors';
import { cn } from '@/lib/utils';
import { usePopupSideOnOpen } from '@/components/ui/popup-side';
import { useWidthMorph } from '@/lib/motion/useSizeMorph';
import { agentLabel } from '@/lib/agentLabel';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import { useContextStore } from '@/stores/contextStore';
import { useConfigStore, isStaleAutoSelection, selectConfigAgentsForDirectory, selectKnownAgent, selectKnownCatalogModel, selectProvidersForDirectory } from '@/stores/useConfigStore';
import { filterVisibleAgents } from '@/stores/useAgentsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionMessagesSelector, useSessionRenderable, useSessionSelector } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import { useSync } from '@/sync/use-sync';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists } from '@/hooks/useModelLists';
import { useIsTextTruncated } from '@/hooks/useIsTextTruncated';
import { formatEffortLabel, getCycledPrimaryAgentName, getEffortTone, getEffortToneClass, isPrimaryMode, type MobileControlsPanel } from './mobileControlsUtils';
import { getCurrentIntlLocale, isRightToLeft, useI18n } from '@/lib/i18n';
import { useOpenCodeReadiness } from '@/hooks/useOpenCodeReadiness';
import { eventMatchesShortcut, formatShortcutForDisplay, getEffectiveShortcutCombo, normalizeCombo } from '@/lib/shortcuts';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { markStartupTrace } from '@/lib/startupTrace';
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, isAutoModel } from '@/lib/routing/autoModel';
import { selectAutoReady, useRoutingStore } from '@/stores/useRoutingStore';
import {
    areModelChoicesEqual,
    extractSessionRecordModelChoice,
    findLatestUserModelChoice,
    shouldPreserveManualModelOverride,
} from '@/lib/messages/userModelChoice';
import type { BtwSelection } from '@/stores/useBtwStore';
import { listModelVariantIds, type ModelVariantSource } from '@/lib/modelVariants';
import { effortMemoryKey, rememberEffort, resolveEffortChoice, resolveEffortForModelSelection } from '@/lib/modelEfforts';
import { restingAgentColor } from '@/lib/agentColors';

type IconComponent = IconName;

type ProviderModel = Record<string, unknown> & { id?: string; name?: string };


const buildModelRefKey = (providerID: string, modelID: string) => `${providerID}:${modelID}`;

const selectSessionRecordAgent = (session: Session | undefined): string | undefined => session?.agent?.trim() || undefined;
const selectLatestReplyModelChoice = (messages: Message[], state: State) => findLatestUserModelChoice(
    messages,
    (messageId) => state.part[messageId],
);


const AgentDescriptionTooltip: React.FC<{
    description?: string;
    children: React.ReactElement;
}> = ({ description, children }) => {
    if (!description) {
        return children;
    }

    return (
        <Tooltip delayDuration={450}>
            <TooltipTrigger asChild>{children}</TooltipTrigger>
            <TooltipContent
                side="right"
                sideOffset={8}
                className="max-w-xs text-start transition-none data-[starting-style]:opacity-100 data-[starting-style]:scale-100 data-[ending-style]:opacity-100 data-[ending-style]:scale-100"
            >
                <span className="typography-meta text-muted-foreground">{description}</span>
            </TooltipContent>
        </Tooltip>
    );
};

const AgentFavoriteToggle: React.FC<{
    favorite: boolean;
    onToggle: () => void;
    className?: string;
}> = ({ favorite, onToggle, className }) => {
    const { t } = useI18n();
    const label = favorite ? t('chat.modelControls.removeFromFavorites') : t('chat.modelControls.agentFavoriteAdd');
    const keepFromRow = (event: React.SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
    };
    return (
        <button
            type="button"
            aria-pressed={favorite}
            aria-label={label}
            title={label}
            onPointerDown={keepFromRow}
            onPointerUp={keepFromRow}
            onMouseUp={keepFromRow}
            onClick={(event) => {
                keepFromRow(event);
                onToggle();
            }}
            className={cn(
                'flex h-5 w-5 flex-shrink-0 items-center justify-center rounded hover:text-primary/80',
                favorite ? 'text-primary' : 'text-muted-foreground',
                className,
            )}
        >
            <Icon name={favorite ? 'star-fill' : 'star'} className="h-3.5 w-3.5" />
        </button>
    );
};

const agentSampling = (agent: Agent, key: 'temperature' | 'topP'): number | undefined => {
    const value = agent.request?.body?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const agentTemperature = (agent: Agent): number | undefined => agentSampling(agent, 'temperature');
const agentTopP = (agent: Agent): number | undefined => agentSampling(agent, 'topP');

const resolveWildcardPermissionEffect = (rules: PermissionRuleset, action: string): PermissionEffect | undefined => {
    for (let i = rules.length - 1; i >= 0; i -= 1) {
        const rule = rules[i];
        if (rule.action === action && rule.resource === '*') {
            return rule.effect;
        }
    }

    for (let i = rules.length - 1; i >= 0; i -= 1) {
        const rule = rules[i];
        if (rule.action === '*' && rule.resource === '*') {
            return rule.effect;
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

const formatUsdCurrency = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 2,
}).format(value);

const formatKnowledgeDate = (value: Date) => new Intl.DateTimeFormat(getCurrentIntlLocale(), { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(value);

const formatReleaseDate = (value: Date, timeZone?: string) => new Intl.DateTimeFormat(getCurrentIntlLocale(), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone,
}).format(value);


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

    return formatReleaseDate(parsedDate, /^\d{4}-\d{2}-\d{2}$/.test(value) ? 'UTC' : undefined);
};

type ModelControlsProps = {
    className?: string;
    mobilePanel?: MobileControlsPanel;
    onMobilePanelChange?: (panel: MobileControlsPanel) => void;
    onRunInParallel?: () => void;
    agentOnly?: boolean;
    rememberVariantPicks?: boolean;
} & (
    | { selection?: never; sessionId?: never; modelSelectorOpen?: never; onModelSelectorOpenChange?: never }
    | {
        selection: BtwSelection;
        sessionId: string | null;
        modelSelectorOpen?: boolean;
        onModelSelectorOpenChange?: (open: boolean) => void;
    }
);

const ReadinessMark: React.FC<{ unavailable: boolean; className: string }> = ({ unavailable, className }) => (
    unavailable ? <Icon name="error-warning" className={className} /> : <Spinner className={className} />
);

export const ModelControls: React.FC<ModelControlsProps> = ({
    className,
    mobilePanel,
    onMobilePanelChange,
    onRunInParallel,
    agentOnly = false,
    selection,
    sessionId: controlledSessionId,
    rememberVariantPicks = true,
    modelSelectorOpen: controlledModelSelectorOpen,
    onModelSelectorOpenChange,
}) => {
    const { t } = useI18n();
    const { focusInput: focusColumnInput } = useChatColumnActions();
    const columnDirectory = useChatSessionSelection().directory;
    const catalogDirectory = selection ? columnDirectory ?? undefined : undefined;
    const { isReady, isUnavailable } = useOpenCodeReadiness('models', catalogDirectory);
    const { isReady: canSelectAgent } = useOpenCodeReadiness('agents', catalogDirectory);
    const readinessLabel = isUnavailable ? t('common.unavailable') : t('common.loading');
    const providers = useConfigStore((state) => selectProvidersForDirectory(state, catalogDirectory));
    const catalogAgents = useConfigStore((state) => selectConfigAgentsForDirectory(state, catalogDirectory));
    const loadCatalogProviders = useConfigStore((state) => state.loadProviders);
    const loadCatalogAgents = useConfigStore((state) => state.loadAgents);
    React.useEffect(() => {
        if (!catalogDirectory) return;
        if (!isReady) void loadCatalogProviders({ directory: catalogDirectory, source: 'ModelControls:column' });
        if (!canSelectAgent) void loadCatalogAgents({ directory: catalogDirectory, source: 'ModelControls:column' });
    }, [canSelectAgent, catalogDirectory, isReady, loadCatalogAgents, loadCatalogProviders]);
    const getAgentColor = useAgentColors();
    const favoriteAgents = useUIStore((state) => state.favoriteAgents);
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const answersModelShortcuts = !selection || onModelSelectorOpenChange !== undefined;
    const modelShortcut = answersModelShortcuts ? formatShortcutForDisplay(getEffectiveShortcutCombo('open_model_selector', shortcutOverrides), '') : undefined;
    const agentShortcut = selection ? undefined : formatShortcutForDisplay(getEffectiveShortcutCombo('cycle_agent', shortcutOverrides), '');
    const thinkingShortcut = answersModelShortcuts ? formatShortcutForDisplay(getEffectiveShortcutCombo('cycle_thinking_variant', shortcutOverrides), '') : undefined;
    const toggleFavoriteAgent = useUIStore((state) => state.toggleFavoriteAgent);
    const currentProviderId = useConfigStore((state) => selection ? selection.model?.providerId ?? '' : state.currentProviderId);
    const currentModelId = useConfigStore((state) => selection ? selection.model?.modelId ?? '' : state.currentModelId);
    const effectiveCurrentVariant = useConfigStore((state) => state.currentVariant);
    const currentVariantSelection = useConfigStore((state) => state.currentVariantSelection);
    let currentVariant = currentVariantSelection.override === null
        ? undefined
        : currentVariantSelection.override ?? effectiveCurrentVariant;
    if (selection) currentVariant = selection.variant ?? undefined;
    const currentAgentName = useConfigStore((state) => selection ? selection.agent : state.currentAgentName);
    const settingsDefaultModel = useConfigStore((state) => state.settingsDefaultModel);
    const settingsDefaultVariant = useConfigStore((state) => state.settingsDefaultVariant);
    const getDefaultVariantForModel = useConfigStore((state) => state.getDefaultVariantForModel);
    const settingsDefaultAgent = useConfigStore((state) => state.settingsDefaultAgent);
    const defaultsLoaded = useConfigStore((state) => state.settingsDefaultsLoaded);
    const agentsResolved = useConfigStore((state) => state.agentsLoaded);
    const providersResolved = useConfigStore((state) => state.providersLoaded);
    const modelSelectionReady = Boolean(currentModelId) || (selection ? isReady : defaultsLoaded && providersResolved && agentsResolved);
    const agentSelectionReady = Boolean(currentAgentName) || (selection ? canSelectAgent : defaultsLoaded && agentsResolved);
    const setProvider = useConfigStore((state) => state.setProvider);
    const requestProviderConnect = useUIStore((state) => state.setSettingsProvidersConnectRequested);
    const setModel = useConfigStore((state) => state.setModel);
    const setCurrentVariant = useConfigStore((state) => state.setCurrentVariant);
    const setCurrentVariantOverride = useConfigStore((state) => state.setCurrentVariantOverride);
    const getCurrentModelVariants = useConfigStore((state) => state.getCurrentModelVariants);
    const setAgent = useConfigStore((state) => state.setAgent);
    const getCurrentProvider = useConfigStore((state) => state.getCurrentProvider);
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    const getCurrentAgent = useConfigStore((state) => state.getCurrentAgent);
    const agents = React.useMemo(() => filterVisibleAgents(catalogAgents), [catalogAgents]);
    const primaryAgents = React.useMemo(() => agents.filter((agent) => agent.mode === 'primary'), [agents]);
    const tracedReadyRef = React.useRef(false);

    React.useEffect(() => {
        if (selection || tracedReadyRef.current || !isReady) return;
        tracedReadyRef.current = true;
        markStartupTrace('ModelControls:ready', {
            providers: providers.length,
            agents: agents.length,
            currentProviderId,
            currentModelId,
            currentAgentName,
        });
    }, [agents.length, currentAgentName, currentModelId, currentProviderId, isReady, providers.length, selection]);

    const currentSessionId = useSessionUIStore((s) => selection ? null : s.currentSessionId);
    const getDirectoryForSession = useSessionUIStore((s) => s.getDirectoryForSession);
    const sync = useSync();

    const getSessionModelSelection = useSelectionStore((state) => state.getSessionModelSelection);
    const saveSessionModelSelection = useSelectionStore((state) => state.saveSessionModelSelection);
    const saveSessionAgentSelection = useSelectionStore((state) => state.saveSessionAgentSelection);
    const pickSessionAgent = useSelectionStore((state) => state.pickSessionAgent);
    const saveAgentModelForSession = useSelectionStore((state) => state.saveAgentModelForSession);
    const getAgentModelForSession = useSelectionStore((state) => state.getAgentModelForSession);
    const saveAgentModelVariantForSession = useSelectionStore((state) => state.saveAgentModelVariantForSession);
    const getAgentModelVariantForSession = useSelectionStore((state) => state.getAgentModelVariantForSession);

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

    const uiAgentName = currentSessionId
        ? (sessionSavedAgentName || stickySessionAgentName || currentAgentName)
        : currentAgentName;
    const agentUnavailable = useAgentMissingFromCatalog(uiAgentName);
    const agentUnavailableText = agentUnavailable && uiAgentName
        ? t('chat.modelControls.agentUnavailable', { agent: uiAgentName })
        : undefined;
    const knownAgent = useConfigStore((state) => (
        state.agents.length > 0 ? undefined : selectKnownAgent(state, uiAgentName || settingsDefaultAgent || 'build')
    ));

    const toggleFavoriteModel = useUIStore((state) => state.toggleFavoriteModel);
    const reorderFavoriteModel = useUIStore((state) => state.reorderFavoriteModel);
    const providerOrder = useUIStore((state) => state.providerOrder);
    const setProviderOrder = useUIStore((state) => state.setProviderOrder);
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const setLastSelectedModel = useUIStore((state) => state.setLastSelectedModel);
    const addRecentAgent = useUIStore((state) => state.addRecentAgent);
    const addRecentEffort = useUIStore((state) => state.addRecentEffort);
    const lastUsedEfforts = useUIStore((state) => state.lastUsedEfforts);
    const globalModelSelectorOpen = useUIStore((state) => !selection && state.isModelSelectorOpen);
    const [localModelSelectorOpen, setLocalModelSelectorOpen] = React.useState(false);
    const isModelSelectorOpen = selection ? controlledModelSelectorOpen ?? localModelSelectorOpen : globalModelSelectorOpen;
    const setModelSelectorOpen = useUIStore((state) => state.setModelSelectorOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    const setSettingsPage = useUIStore((state) => state.setSettingsPage);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const cycleAgentShortcutOverride = useUIStore((state) => state.shortcutOverrides.cycle_agent);
    const cycleAgentShortcut = React.useMemo(() => (
        getEffectiveShortcutCombo('cycle_agent', cycleAgentShortcutOverride ? { cycle_agent: cycleAgentShortcutOverride } : undefined)
    ), [cycleAgentShortcutOverride]);

    const [isAgentSelectorOpen, setIsAgentSelectorOpen] = React.useState(false);
    const { favoriteModelsList, recentModelsList } = useModelLists(catalogDirectory);
    const autoReady = useRoutingStore(selectAutoReady);
    const autoEntry = React.useMemo<ModelPickerEntry | null>(() => (autoReady
        ? { providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, model: { id: AUTO_MODEL_ID, name: t('chat.modelControls.autoModel') } }
        : null), [autoReady, t]);
    const isAutoSelected = isAutoModel(currentProviderId, currentModelId);
    const modelUnavailable = useModelMissingFromCatalog(catalogDirectory, currentProviderId, currentModelId);

    const { isMobile: deviceIsMobile } = useDeviceInfo();
    const uiIsMobile = useUIStore((state) => state.isMobile);
    const isMobile = deviceIsMobile || uiIsMobile;
    const isDesktop = React.useMemo(() => isDesktopShell(), []);
    const isVSCodeRuntime = useIsVSCodeRuntime();
    const isCompact = isMobile;
    const [localMobilePanel, setLocalMobilePanel] = React.useState<MobileControlsPanel>(null);
    const usingExternalMobilePanel = mobilePanel !== undefined && typeof onMobilePanelChange === 'function';
    const activeMobilePanel = usingExternalMobilePanel ? mobilePanel : localMobilePanel;
    const setActiveMobilePanel = usingExternalMobilePanel ? onMobilePanelChange : setLocalMobilePanel;
    const [mobileTooltipOpen, setMobileTooltipOpen] = React.useState<'model' | 'agent' | null>(null);
    const [mobileModelQuery, setMobileModelQuery] = React.useState('');
    const [mobileDetailsEntry, setMobileDetailsEntry] = React.useState<ModelPickerEntry | null>(null);
    const manualVariantSelectionRef = React.useRef(false);
    const closeMobilePanel = React.useCallback(() => setActiveMobilePanel(null), [setActiveMobilePanel]);
    const closeMobileTooltip = React.useCallback(() => setMobileTooltipOpen(null), []);
    const longPressTimerRef = React.useRef<NodeJS.Timeout | undefined>(undefined);
    const agentMenuOpen = isModelSelectorOpen;
    const modelTriggerRef = React.useRef<HTMLDivElement>(null);
    const agentTriggerRef = React.useRef<HTMLDivElement>(null);
    const agentListRef = React.useRef<HTMLDivElement>(null);
    const modelMenuSide = usePopupSideOnOpen(agentMenuOpen, modelTriggerRef, 'top');
    const agentMenuSide = usePopupSideOnOpen(isAgentSelectorOpen, agentTriggerRef, 'top');
    const variantTriggerRef = React.useRef<HTMLDivElement>(null);
    useWidthMorph(modelTriggerRef);
    useWidthMorph(agentTriggerRef);
    useWidthMorph(variantTriggerRef);
    const setAgentMenuOpen = selection ? onModelSelectorOpenChange ?? setLocalModelSelectorOpen : setModelSelectorOpen;
    const openAddProviderSettings = React.useCallback(() => {
        requestProviderConnect(true);
        setSettingsPage('providers');
        setSettingsDialogOpen(true);
        setAgentMenuOpen(false);
        closeMobilePanel();
    }, [requestProviderConnect, setSettingsPage, setSettingsDialogOpen, setAgentMenuOpen, closeMobilePanel]);
    const [desktopModelQuery, setDesktopModelQuery] = React.useState('');
    const keyboardOwnsModelSelectionRef = React.useRef(false);
    const lastModelPointerPositionRef = React.useRef<{ x: number; y: number } | null>(null);
    const activeModelPickerEntryRef = React.useRef<ModelPickerEntry | undefined>(undefined);
    const [pendingThinkingVariants, setPendingThinkingVariants] = React.useState<Map<string, string | undefined>>(new Map());
    const [adjustedThinkingModels, setAdjustedThinkingModels] = React.useState<Set<string>>(new Set());
    const [modelPickerRenderVersion, setModelPickerRenderVersion] = React.useState(0);

    React.useEffect(() => {
        if (activeMobilePanel !== 'model') {
            setMobileModelQuery('');
        }
    }, [activeMobilePanel]);

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

            if (wasOpen && !isCompact) {
                requestAnimationFrame(focusColumnInput);
            }
        }
    }, [focusColumnInput, isModelSelectorOpen, isCompact]);

    const [agentSearchQuery, setAgentSearchQuery] = React.useState('');
    React.useEffect(() => {
        if (isAgentSelectorOpen) return;
        setAgentSearchQuery('');
        if (!selection && !isCompact) requestAnimationFrame(focusColumnInput);
    }, [focusColumnInput, isAgentSelectorOpen, isCompact, selection]);

    const selectableDesktopAgents = React.useMemo(() => {
        return agents.filter((agent) => isPrimaryMode(agent.mode));
    }, [agents]);

    const sortedAndFilteredAgents = React.useMemo(() => {
        const sorted = [...selectableDesktopAgents].sort((a, b) => a.name.localeCompare(b.name));
        return rankByQuery(sorted, agentSearchQuery, (agent) => [agent.name, agent.displayName, agent.description]);
    }, [selectableDesktopAgents, agentSearchQuery]);

    const currentAgent = React.useMemo(() => {
        if (uiAgentName) {
            return agents.find((agent) => agent.name === uiAgentName);
        }
        return getCurrentAgent?.();
    }, [agents, getCurrentAgent, uiAgentName]);

    const sizeVariant: 'mobile' | 'vscode' | 'default' = isMobile ? 'mobile' : isVSCodeRuntime ? 'vscode' : 'default';
    const buttonHeight = sizeVariant === 'mobile' ? 'h-9' : sizeVariant === 'vscode' ? 'h-6' : 'h-8';
    const controlIconSize = sizeVariant === 'mobile' ? 'size-5' : sizeVariant === 'vscode' ? 'size-4' : 'size-4';
    const providerLogoSize = sizeVariant === 'mobile' ? 'size-[21px]' : 'size-[17px]';
    const controlTextSize = isCompact ? 'typography-micro' : 'typography-meta';
    const inlineGapClass = sizeVariant === 'mobile' ? 'gap-x-1' : sizeVariant === 'vscode' ? 'gap-x-2' : 'gap-x-4';

    const currentProvider = selection ? providers.find((provider) => provider.id === currentProviderId) : getCurrentProvider();
    const models = Array.isArray(currentProvider?.models) ? currentProvider.models : [];

    const currentModelForMetadata = currentModelId
        ? models.find((model: ProviderModel) => model.id === currentModelId)
        : undefined;
    const knownCurrentModel = useConfigStore((state) => (
        currentModelForMetadata ? undefined : selectKnownCatalogModel(state, currentProviderId, currentModelId)
    ));
    const displayCurrentModel = currentModelForMetadata ?? knownCurrentModel;
    const currentMetadata = currentProviderId && currentModelId && currentModelForMetadata
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

    const rawAvailableVariants = selection
        ? listModelVariantIds(currentProvider?.models.find((model) => model.id === currentModelId)?.variants)
        : getCurrentModelVariants();
    const availableVariantsKey = rawAvailableVariants.join('\u0000');
    const availableVariants = React.useMemo(
        () => (availableVariantsKey ? availableVariantsKey.split('\u0000') : []),
        [availableVariantsKey],
    );
    const displayVariants = React.useMemo(
        () => (availableVariants.length > 0 || !knownCurrentModel
            ? availableVariants
            : listModelVariantIds(knownCurrentModel.variants)),
        [availableVariants, knownCurrentModel],
    );
    const hasVariants = displayVariants.length > 0;

    const costRows = [
        { label: 'Input', value: formatCost(currentMetadata?.cost?.input) },
        { label: 'Output', value: formatCost(currentMetadata?.cost?.output) },
        { label: 'Cache read', value: formatCost(currentMetadata?.cost?.cache_read) },
        { label: 'Cache write', value: formatCost(currentMetadata?.cost?.cache_write) },
    ];

    const limitRows = [
        { label: 'Context', value: formatTokens(currentMetadata?.limit?.context) },
        { label: 'Output', value: formatTokens(currentMetadata?.limit?.output) },
    ];

    const prevAgentNameRef = React.useRef<string | undefined>(undefined);
    const latestLoadedUserChoiceRestoreRef = React.useRef<string | null>(null);
    const restoredSessionSelectionRef = React.useRef<string | null>(null);

    const currentSessionDirectory = currentSessionId ? getDirectoryForSession(currentSessionId) : undefined;
    const hasRenderableCurrentSessionSnapshot = useSessionRenderable(
        currentSessionId ?? '',
        currentSessionDirectory ?? undefined,
    );
    const sessionRecordAgent = useSessionSelector(
        currentSessionId ?? undefined,
        currentSessionDirectory ?? undefined,
        selectSessionRecordAgent,
    );
    const sessionRecordChoice = useSessionSelector(
        currentSessionId ?? undefined,
        currentSessionDirectory ?? undefined,
        extractSessionRecordModelChoice,
        areModelChoicesEqual,
    );
    const latestReplyChoice = useSessionMessagesSelector(
        currentSessionId ?? '',
        currentSessionDirectory ?? undefined,
        selectLatestReplyModelChoice,
        areModelChoicesEqual,
        true,
    );
    const latestLoadedUserChoice = React.useMemo(() => {
        if (selection) return null;
        if (sessionRecordChoice) return sessionRecordChoice;
        return latestReplyChoice && sessionRecordAgent ? { ...latestReplyChoice, agent: undefined } : latestReplyChoice;
    }, [latestReplyChoice, selection, sessionRecordAgent, sessionRecordChoice]);

    const tryApplyModelSelection = React.useCallback(
        (providerId: string, modelId: string, agentName?: string): ModelApplyResult => {
            if (selection) {
                if (controlledSessionId) {
                    saveSessionModelSelection(controlledSessionId, providerId, modelId);
                    if (selection.agent) saveAgentModelForSession(controlledSessionId, selection.agent, providerId, modelId);
                }
                return 'applied';
            }
            if (!providerId || !modelId) {
                return 'model-missing';
            }

            const isAuto = isAutoModel(providerId, modelId);
            if (isAuto && !selectAutoReady(useRoutingStore.getState())) {
                return 'provider-missing';
            }
            const provider = providers.find(p => p.id === providerId);
            if (!provider && !isAuto) {
                return 'provider-missing';
            }

            const providerModels = Array.isArray(provider?.models) ? provider.models : [];
            const modelExists = isAuto || providerModels.find((m: ProviderModel) => m.id === modelId);
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
        [providers, currentProviderId, currentModelId, setProvider, setModel, currentSessionId, saveAgentModelForSession, saveSessionModelSelection, controlledSessionId, selection],
    );

    const getModelVariantOptions = React.useCallback((providerId: string, modelId: string) => {
        const provider = providers.find((entry) => entry.id === providerId);
        // SAFETY: the catalog model's `variants` is v2's `{ id, settings }[]`
        // (or the v1 keyed object on an older record); only the ids are read.
        const model = provider?.models.find((entry) => entry.id === modelId) as { variants?: ModelVariantSource } | undefined;
        return listModelVariantIds(model?.variants);
    }, [providers]);

    const resolveInheritedVariantForModel = React.useCallback((providerId: string, modelId: string, agentName?: string | null) => {
        const variantOptions = getModelVariantOptions(providerId, modelId);
        if (variantOptions.length === 0) return undefined;

        let currentInherited: string | null | undefined;
        if (currentProviderId === providerId && currentModelId === modelId) {
            currentInherited = currentVariantSelection.inherited !== undefined
                ? currentVariantSelection.inherited
                : (currentVariantSelection.override === null || currentVariantSelection.override === undefined
                    ? effectiveCurrentVariant
                    : undefined);
        }

        const effectiveAgentName = agentName ?? uiAgentName ?? currentAgentName;
        return resolveEffortChoice(
            [resolveEffortForModelSelection({
                providerID: providerId, modelID: modelId, variants: variantOptions,
                agents, agentName: effectiveAgentName,
                configuredVariant: getDefaultVariantForModel(providerId, modelId),
                rememberedEffort: lastUsedEfforts?.[effortMemoryKey(providerId, modelId)],
            }), currentInherited],
            variantOptions,
        );
    }, [agents, currentAgentName, currentModelId, currentProviderId, currentVariantSelection, effectiveCurrentVariant, getDefaultVariantForModel, getModelVariantOptions, lastUsedEfforts, uiAgentName]);

    const resolveModelVariantSelection = React.useCallback((
        providerId: string,
        modelId: string,
        options?: { includeInherited?: boolean },
    ): string | null | undefined => {
        const variantOptions = getModelVariantOptions(providerId, modelId);
        if (variantOptions.length === 0) {
            return undefined;
        }

        const effectiveAgentName = uiAgentName || currentAgentName;
        const selectionSessionId = selection ? controlledSessionId : currentSessionId;
        if (selectionSessionId && effectiveAgentName) {
            const savedVariant = getAgentModelVariantForSession(selectionSessionId, effectiveAgentName, providerId, modelId);
            if (savedVariant === null) {
                return null;
            }
            if (savedVariant && variantOptions.includes(savedVariant)) {
                return savedVariant;
            }
        }

        if (options?.includeInherited === false) {
            return undefined;
        }

        if (currentProviderId === providerId && currentModelId === modelId) {
            if (selection) return selection.variant ?? null;
            if (currentVariant && variantOptions.includes(currentVariant)) return currentVariant;
        }

        return resolveEffortForModelSelection({
            providerID: providerId, modelID: modelId, variants: variantOptions,
            agents, agentName: effectiveAgentName,
            configuredVariant: getDefaultVariantForModel(providerId, modelId),
            rememberedEffort: lastUsedEfforts?.[effortMemoryKey(providerId, modelId)],
        });
    }, [
        agents,
        currentAgentName,
        currentModelId,
        currentProviderId,
        currentSessionId,
        currentVariant,
        getAgentModelVariantForSession,
        getDefaultVariantForModel,
        getModelVariantOptions,
        lastUsedEfforts,
        uiAgentName,
        controlledSessionId,
        selection,
    ]);

    const resolveLiveAgentName = React.useCallback(() => {
        if (selection) return selection.agent;
        const liveConfigAgentName = useConfigStore.getState().currentAgentName;
        if (currentSessionId) {
            return useSelectionStore.getState().getSessionAgentSelection(currentSessionId)
                || stickySessionAgentRef.current
                || liveConfigAgentName
                || currentAgentName;
        }
        return liveConfigAgentName || currentAgentName;
    }, [currentAgentName, currentSessionId, selection]);

    const rememberVariantForModel = React.useCallback((providerId: string, modelId: string, variant: string | null | undefined) => {
        if (!rememberVariantPicks) return;
        rememberEffort(providerId, modelId, variant ?? null);
    }, [rememberVariantPicks]);

    const commitVariantSelectionForModel = React.useCallback((providerId: string, modelId: string, variant: string | null | undefined, agentNameOverride?: string | null) => {
        if (selection) {
            if (controlledSessionId && selection.agent) {
                saveAgentModelVariantForSession(controlledSessionId, selection.agent, providerId, modelId, variant);
            }
            return;
        }
        const variantOptions = getModelVariantOptions(providerId, modelId);
        if (variantOptions.length === 0) {
            manualVariantSelectionRef.current = false;
            setCurrentVariant(undefined);
            return;
        }

        manualVariantSelectionRef.current = true;
        setCurrentVariantOverride(
            variant,
            resolveInheritedVariantForModel(providerId, modelId, agentNameOverride),
        );
        addRecentEffort(providerId, modelId, variant ?? undefined);

        const effectiveAgentName = agentNameOverride ?? resolveLiveAgentName();
        if (currentSessionId && effectiveAgentName) {
            saveAgentModelVariantForSession(currentSessionId, effectiveAgentName, providerId, modelId, variant);
        }
    }, [
        addRecentEffort,
        currentSessionId,
        getModelVariantOptions,
        resolveInheritedVariantForModel,
        resolveLiveAgentName,
        saveAgentModelVariantForSession,
        setCurrentVariant,
        setCurrentVariantOverride,
        controlledSessionId,
        selection,
    ]);

    const applyModelSelectionWithVariant = React.useCallback((providerId: string, modelId: string, variant: string | null | undefined, agentNameOverride?: string | null) => {
        const effectiveAgentName = agentNameOverride ?? resolveLiveAgentName() ?? undefined;
        const result = tryApplyModelSelection(providerId, modelId, effectiveAgentName);
        if (result !== 'applied') {
            return result;
        }

        if (!selection) addRecentModel(providerId, modelId);
        commitVariantSelectionForModel(providerId, modelId, variant, effectiveAgentName);
        return 'applied';
    }, [addRecentModel, commitVariantSelectionForModel, resolveLiveAgentName, tryApplyModelSelection, selection]);

    React.useEffect(() => {
        if (!currentSessionId || !contextHydrated || !sessionRecordAgent) return;
        if (!useSelectionStore.getState().followSessionAgent(currentSessionId, sessionRecordAgent)) return;
        if (useConfigStore.getState().currentAgentName === sessionRecordAgent) return;
        prevAgentNameRef.current = sessionRecordAgent;
        setAgent(sessionRecordAgent, { keepModel: true });
    }, [contextHydrated, currentSessionId, sessionRecordAgent, setAgent]);

    React.useEffect(() => {
        if (!currentSessionId) {
            latestLoadedUserChoiceRestoreRef.current = null;
            return;
        }

        const snapshotReady = hasRenderableCurrentSessionSnapshot || Boolean(sessionRecordChoice);
        if (!contextHydrated || providers.length === 0 || !snapshotReady || !latestLoadedUserChoice?.providerID || !latestLoadedUserChoice.modelID) {
            return;
        }

        const restoreKey = [
            currentSessionId,
            latestLoadedUserChoice.id,
            latestLoadedUserChoice.agent ?? sessionRecordAgent ?? '',
            latestLoadedUserChoice.providerID,
            latestLoadedUserChoice.modelID,
            latestLoadedUserChoice.variant ?? '',
        ].join('|');

        if (latestLoadedUserChoiceRestoreRef.current === restoreKey) {
            return;
        }

        const restoreAgentName = latestLoadedUserChoice.agent || resolveLiveAgentName() || undefined;

        const recordModelKey = sessionRecordChoice && latestLoadedUserChoice === sessionRecordChoice
            ? `${sessionRecordChoice.providerID}/${sessionRecordChoice.modelID}#${sessionRecordChoice.variant ?? ''}`
            : null;
        const recordModelSwitched = recordModelKey !== null
            && useSelectionStore.getState().isSessionModelSwitched(currentSessionId, recordModelKey);
        const markRecordModelFollowed = () => {
            if (recordModelKey) useSelectionStore.getState().markSessionModelFollowed(currentSessionId, recordModelKey);
        };

        const savedSessionModel = getSessionModelSelection(currentSessionId);
        const savedAuto = Boolean(savedSessionModel) && isAutoModel(savedSessionModel!.providerId, savedSessionModel!.modelId);
        if (savedAuto && isStaleAutoSelection(savedSessionModel!.providerId, savedSessionModel!.modelId)) {
            useConfigStore.getState().dropStaleAutoSelection();
        } else if (savedAuto) {
            if (!autoReady) return;
            tryApplyModelSelection(AUTO_PROVIDER_ID, AUTO_MODEL_ID, restoreAgentName);
            markRecordModelFollowed();
            latestLoadedUserChoiceRestoreRef.current = restoreKey;
            return;
        } else if (!recordModelSwitched && shouldPreserveManualModelOverride({
            selectionSource: useConfigStore.getState().selectionSource,
            savedSessionModel,
            candidate: latestLoadedUserChoice,
        })) {
            if (savedSessionModel) {
                applyModelSelectionWithVariant(
                    savedSessionModel.providerId,
                    savedSessionModel.modelId,
                    resolveModelVariantSelection(savedSessionModel.providerId, savedSessionModel.modelId, { includeInherited: false }),
                    restoreAgentName,
                );
            }
            markRecordModelFollowed();
            latestLoadedUserChoiceRestoreRef.current = restoreKey;
            return;
        }

        if (restoreAgentName && useConfigStore.getState().currentAgentName !== restoreAgentName) {
            setAgent(restoreAgentName);
        }

        const historicalVariant = latestLoadedUserChoice.variant
            && getModelVariantOptions(latestLoadedUserChoice.providerID, latestLoadedUserChoice.modelID).includes(latestLoadedUserChoice.variant)
            ? latestLoadedUserChoice.variant
            : undefined;
        const savedVariant = currentSessionId && restoreAgentName
            ? getAgentModelVariantForSession(
                currentSessionId,
                restoreAgentName,
                latestLoadedUserChoice.providerID,
                latestLoadedUserChoice.modelID,
            )
            : undefined;
        let restoredVariant: string | null | undefined = savedVariant !== undefined ? savedVariant : historicalVariant;
        if (recordModelSwitched && historicalVariant) restoredVariant = historicalVariant;
        const applyResult = applyModelSelectionWithVariant(
            latestLoadedUserChoice.providerID,
            latestLoadedUserChoice.modelID,
            restoredVariant,
            restoreAgentName,
        );
        if (applyResult !== 'applied') {
            return;
        }

        if (latestLoadedUserChoice.agent) {
            saveSessionAgentSelection(currentSessionId, latestLoadedUserChoice.agent);
        }
        saveSessionModelSelection(currentSessionId, latestLoadedUserChoice.providerID, latestLoadedUserChoice.modelID);
        markRecordModelFollowed();
        latestLoadedUserChoiceRestoreRef.current = restoreKey;
        restoredSessionSelectionRef.current = currentSessionId;

    }, [
        currentSessionId,
        currentAgentName,
        contextHydrated,
        providers,
        hasRenderableCurrentSessionSnapshot,
        latestLoadedUserChoice,
        sessionRecordAgent,
        sessionRecordChoice,
        autoReady,
        resolveLiveAgentName,
        setAgent,
        applyModelSelectionWithVariant,
        tryApplyModelSelection,
        getAgentModelVariantForSession,
        getModelVariantOptions,
        getSessionModelSelection,
        resolveModelVariantSelection,
        saveSessionAgentSelection,
        saveSessionModelSelection,
    ]);

    React.useEffect(() => {
        if (!currentSessionId) {
            latestLoadedUserChoiceRestoreRef.current = null;
            restoredSessionSelectionRef.current = null;
            return;
        }

        if (restoredSessionSelectionRef.current === currentSessionId) {
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
                const savedModel = getAgentModelForSession(currentSessionId, savedAgentName);
                if (savedModel) {
                    const result = tryApplyModelSelection(savedModel.providerId, savedModel.modelId, savedAgentName);
                    if (result === 'applied') {
                        if (currentAgentName !== savedAgentName) {
                            setAgent(savedAgentName);
                        }
                        return 'resolved';
                    }
                    if (result === 'provider-missing') {
                        return 'waiting';
                    }
                } else {
                    const savedAgent = agents.find((agent) => agent.name === savedAgentName);
                    if (currentAgentName !== savedAgentName) {
                        setAgent(savedAgentName);
                    }
                    if (savedAgent?.model?.providerID && savedAgent.model.id) {
                        return 'resolved';
                    }
                }
            }

            if (savedSessionModel && !isStaleAutoSelection(savedSessionModel.providerId, savedSessionModel.modelId)) {
                const result = tryApplyModelSelection(savedSessionModel.providerId, savedSessionModel.modelId, savedAgentName ?? undefined);
                if (result === 'applied') {
                    if (savedAgentName && currentAgentName !== savedAgentName) {
                        setAgent(savedAgentName);
                    }
                    return 'resolved';
                }
                return 'waiting';
            }

            for (const agent of agents) {
                const selection = getAgentModelForSession(currentSessionId, agent.name);
                if (!selection) {
                    continue;
                }

                const result = tryApplyModelSelection(selection.providerId, selection.modelId, agent.name);
                if (result === 'applied') {
                    if (currentAgentName !== agent.name) {
                        setAgent(agent.name);
                    }
                    const existingSelection = useSelectionStore.getState().getSessionAgentSelection(currentSessionId) || stickySessionAgentRef.current;
                    if (!existingSelection) {
                        saveSessionAgentSelection(currentSessionId, agent.name);
                    }
                    return 'resolved';
                }
                return 'waiting';
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

            if (fallbackAgent.model?.providerID && fallbackAgent.model?.id) {
                tryApplyModelSelection(fallbackAgent.model.providerID, fallbackAgent.model.id, fallbackAgent.name);
            }
        };

        const savedOutcome = applySavedSelections();
        if (savedOutcome === 'resolved') {
            restoredSessionSelectionRef.current = currentSessionId;
            return;
        }
        if (savedOutcome === 'waiting') {
            return;
        }

        if (!hasRenderableCurrentSessionSnapshot) {
            const sessionDirectory = currentSessionDirectory ?? undefined;
            if (!sync.isLoading(currentSessionId, sessionDirectory)) {
                void sync.ensureSessionRenderable(currentSessionId, false, sessionDirectory);
            }
            return;
        }

        if (latestLoadedUserChoice) {
            return;
        }

        applyFallbackAgent();
        restoredSessionSelectionRef.current = currentSessionId;
    }, [
        currentSessionId,
        currentSessionDirectory,
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
        if (selection || !currentSessionId || !contextHydrated || !agentsResolved) return;
        const sessionAgentName = useSelectionStore.getState().getSessionAgentSelection(currentSessionId);
        if (!sessionAgentName || sessionAgentName === useConfigStore.getState().currentAgentName) return;
        if (!agents.some((agent) => agent.name === sessionAgentName)) return;
        setAgent(sessionAgentName, { keepModel: isAutoSelected });
    }, [agents, agentsResolved, contextHydrated, currentAgentName, currentSessionId, isAutoSelected, selection, sessionSavedAgentName, setAgent]);

    React.useEffect(() => {
        if (selection || !contextHydrated) {
            return;
        }
        const abortController = new AbortController();

        const handleAgentSwitch = async () => {
            try {
                if (currentAgentName !== prevAgentNameRef.current) {
                    prevAgentNameRef.current = currentAgentName;

                    if (currentAgentName && currentSessionId) {
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
        currentAgentName,
        currentSessionId,
        getAgentModelForSession,
        tryApplyModelSelection,
        contextHydrated,
        selection,
    ]);

    React.useEffect(() => {
        manualVariantSelectionRef.current = false;
    }, [currentProviderId, currentModelId]);

    React.useEffect(() => {
        if (selection) return;
        if (!contextHydrated || !currentAgentName || (currentModelId && !currentModelForMetadata)) return;

        if (!currentProviderId || !currentModelId) {
            if (!providersResolved) return;
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
            setCurrentVariantOverride(undefined, resolveInheritedVariantForModel(currentProviderId, currentModelId));
            return;
        }

        if (!currentSessionId) {
            if (currentVariantSelection.override === undefined && !manualVariantSelectionRef.current) {
                const desired = resolveInheritedVariantForModel(currentProviderId, currentModelId);
                setCurrentVariantOverride(undefined, desired);
            }
            return;
        }

        const savedVariant = getAgentModelVariantForSession(
            currentSessionId,
            currentAgentName,
            currentProviderId,
            currentModelId,
        );

        const inheritedVariant = resolveInheritedVariantForModel(currentProviderId, currentModelId);
        if (savedVariant && availableVariants.includes(savedVariant)) {
            setCurrentVariantOverride(savedVariant, inheritedVariant);
        } else if (savedVariant === null || currentVariantSelection.override === null) {
            setCurrentVariantOverride(null, inheritedVariant);
        } else {
            setCurrentVariantOverride(undefined, inheritedVariant);
        }
        manualVariantSelectionRef.current = false;
    }, [
        availableVariants,
        currentModelForMetadata,
        contextHydrated,
        currentSessionId,
        currentAgentName,
        currentProviderId,
        currentModelId,
        currentVariant,
        currentVariantSelection.override,
        effectiveCurrentVariant,
        getAgentModelVariantForSession,
        providersResolved,
        resolveInheritedVariantForModel,
        setCurrentVariant,
        setCurrentVariantOverride,
        settingsDefaultModel,
        settingsDefaultVariant,
        selection,
    ]);

    const handleVariantSelect = React.useCallback((variant: string | undefined) => {
        if (currentProviderId && currentModelId) {
            commitVariantSelectionForModel(currentProviderId, currentModelId, variant ?? null);
            rememberVariantForModel(currentProviderId, currentModelId, variant ?? null);
        }
    }, [commitVariantSelectionForModel, currentModelId, currentProviderId, rememberVariantForModel]);

    const handleAgentChange = React.useCallback((agentName: string, options?: { closeModelSelector?: boolean }) => {
        if (selection) {
            if (!controlledSessionId) return;
            pickSessionAgent(controlledSessionId, agentName);
            if (
                currentProviderId && currentModelId && selection.variant !== undefined
                && getAgentModelVariantForSession(controlledSessionId, agentName, currentProviderId, currentModelId) === undefined
            ) {
                saveAgentModelVariantForSession(controlledSessionId, agentName, currentProviderId, currentModelId, selection.variant);
            }
            addRecentAgent(agentName);
            if (options?.closeModelSelector ?? true) {
                setAgentMenuOpen(false);
            }
            if (isCompact) {
                closeMobilePanel();
            }
            return;
        }
        try {
            if (currentSessionId) {
                pickSessionAgent(currentSessionId, agentName);
            }
            setAgent(agentName);
            addRecentAgent(agentName);
            if (options?.closeModelSelector ?? true) {
                setAgentMenuOpen(false);
            }
            if (isCompact) {
                closeMobilePanel();
            }
        } catch (error) {
            console.error('[ModelControls] Handle agent change error:', error);
        }
    }, [
        addRecentAgent,
        closeMobilePanel,
        controlledSessionId,
        currentModelId,
        currentProviderId,
        currentSessionId,
        getAgentModelVariantForSession,
        isCompact,
        pickSessionAgent,
        saveAgentModelVariantForSession,
        setAgent,
        setAgentMenuOpen,
        selection,
    ]);

    const handleCycleAgentFromModelPicker = React.useCallback((direction: 1 | -1) => {
        if (isAutoSelected) return;
        const nextAgentName = getCycledPrimaryAgentName(agents, currentAgentName, direction, useUIStore.getState().favoriteAgents);
        if (!nextAgentName) {
            return;
        }
        handleAgentChange(nextAgentName, { closeModelSelector: false });
    }, [agents, currentAgentName, handleAgentChange, isAutoSelected]);

    const getCycleAgentDirectionFromEvent = React.useCallback((event: KeyboardEvent | React.KeyboardEvent): 1 | -1 | null => {
        if (selection) return null;
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
    }, [cycleAgentShortcut, selection]);

    const handleProviderAndModelChange = (
        providerId: string,
        modelId: string,
        options?: { applyVariant?: boolean; variant?: string | undefined; agentName?: string | null },
    ) => {
        try {
            const effectiveAgentName = options?.agentName ?? resolveLiveAgentName() ?? undefined;
            const result = options?.applyVariant
                ? applyModelSelectionWithVariant(providerId, modelId, options.variant ?? null, effectiveAgentName)
                : selection
                    ? applyModelSelectionWithVariant(providerId, modelId, resolveModelVariantSelection(providerId, modelId) ?? null, effectiveAgentName)
                    : tryApplyModelSelection(providerId, modelId, effectiveAgentName);
            if (result !== 'applied') {
                if (result === 'provider-missing') {
                    console.error('[ModelControls] Provider not available for selection:', providerId);
                } else if (result === 'model-missing') {
                    console.error('[ModelControls] Model not available for selection:', { providerId, modelId });
                }
                return;
            }
            if (options?.applyVariant) {
                rememberVariantForModel(providerId, modelId, options.variant ?? null);
            }
            const pickedSessionId = selection ? controlledSessionId : currentSessionId;
            if (pickedSessionId) useSelectionStore.getState().pickSessionModel(pickedSessionId, providerId, modelId);
            if (!selection && !options?.applyVariant && !isAutoModel(providerId, modelId)) {
                addRecentModel(providerId, modelId);
            }
            if (!selection) {
                setLastSelectedModel(providerId, modelId);
            }
            setAgentMenuOpen(false);
            if (isCompact) {
                closeMobilePanel();
            }
            requestAnimationFrame(focusColumnInput);
        } catch (error) {
            console.error('[ModelControls] Handle model change error:', error);
        }
    };

    const getModelDisplayName = (model: ProviderModel | undefined, fallbackModelId?: string) => {
        return getSharedModelDisplayName(model, fallbackModelId, { maxLength: 40 });
    };

    const getProviderDisplayName = () => {
        const provider = providers.find(p => p.id === currentProviderId);
        return provider?.name || currentProviderId;
    };

    const getCurrentModelDisplayName = () => {
        if (!currentModelId) return t('chat.modelControls.selectModel');
        if (isAutoSelected) return t('chat.modelControls.autoModel');
        return getModelDisplayName(displayCurrentModel, currentModelId) || t('chat.modelControls.selectModel');
    };

    const currentModelDisplayName = getCurrentModelDisplayName();
    const modelUnavailableText = modelUnavailable
        ? t('chat.modelControls.modelUnavailable', { model: currentModelDisplayName })
        : undefined;
    const modelLabelRef = React.useRef<HTMLSpanElement>(null);
    const isModelLabelTruncated = useIsTextTruncated(modelLabelRef, [currentModelDisplayName, isCompact]);

    const getAgentDisplayName = () => {
        if (!uiAgentName) {
            const buildAgent = primaryAgents.find(agent => agent.name === 'build');
            const defaultAgent = buildAgent || primaryAgents[0];
            const shownAgent = defaultAgent ?? knownAgent;
            return shownAgent ? agentLabel(shownAgent) : t('chat.modelControls.selectAgent');
        }
        const agent = agents.find(a => a.name === uiAgentName) ?? knownAgent;
        return agent ? agentLabel(agent) : agentLabel({ name: uiAgentName, displayName: '' });
    };


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

    const modelPickerLabels = {
        searchPlaceholder: t('chat.modelControls.searchModels'),
        list: t('chat.modelControls.modelListAria'),
        noResults: t('chat.modelControls.noModelsFound'),
        favorites: t('chat.modelControls.favorites'),
        recent: t('chat.modelControls.recent'),
        keyboardHint: t('chat.modelControls.keyboardHintNavigate'),
        favorite: t('chat.modelControls.favoriteAria'),
        unfavorite: t('chat.modelControls.unfavoriteAria'),
        provider: t('chat.modelControls.provider'),
        capabilities: t('chat.modelControls.capabilities'),
        capabilityToolCalling: t('chat.modelControls.capability.toolCalling'),
        capabilityReasoning: t('chat.modelControls.capability.reasoning'),
        input: t('chat.modelControls.input'),
        output: t('chat.modelControls.output'),
        costPerMillion: t('chat.modelControls.costPerMillion'),
    };

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
                    <div className="oc-tile rounded-lg px-3 py-2">
                            <div className="typography-micro text-muted-foreground mb-0.5">{t('chat.modelControls.provider')}</div>
                        <div className="typography-meta text-foreground font-medium">{getProviderDisplayName()}</div>
                    </div>

                    {}
                    {currentCapabilityIcons.length > 0 && (
                        <div className="oc-tile rounded-lg px-3 py-2">
                            <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.capabilities')}</div>
                            <div className="flex flex-wrap gap-1.5">
                                {currentCapabilityIcons.map(({ key, icon, label }) => (
                                    <div key={key} className="flex items-center gap-1.5">
                                        <IconBadge key={`cap-${key}`} iconName={icon} label={label} />
                                        <span className="typography-meta text-foreground">{label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {}
                    {(inputModalityIcons.length > 0 || outputModalityIcons.length > 0) && (
                        <div className="oc-tile rounded-lg px-3 py-2">
                            <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.modalities')}</div>
                            <div className="flex flex-col gap-1">
                                {inputModalityIcons.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="typography-meta text-muted-foreground w-12">{t('chat.modelControls.input')}</span>
                                        <div className="flex gap-1">
                                            {inputModalityIcons.map(({ key, icon, label }) => <IconBadge key={`input-${key}`} iconName={icon} label={`${label} input`} />)}
                                        </div>
                                    </div>
                                )}
                                {outputModalityIcons.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="typography-meta text-muted-foreground w-12">{t('chat.modelControls.output')}</span>
                                        <div className="flex gap-1">
                                            {outputModalityIcons.map(({ key, icon, label }) => <IconBadge key={`output-${key}`} iconName={icon} label={`${label} output`} />)}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {}
                    <div className="oc-tile rounded-lg px-3 py-2">
                        <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.limits')}</div>
                        <div className="flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.context')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatTokens(currentMetadata?.limit?.context)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.output')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatTokens(currentMetadata?.limit?.output)}</span>
                            </div>
                        </div>
                    </div>

                    {}
                    <div className="oc-tile rounded-lg px-3 py-2">
                        <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.metadata')}</div>
                        <div className="flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.knowledge')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatKnowledge(currentMetadata?.knowledge)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.release')}</span>
                                <span className="typography-meta font-medium text-foreground">{formatDate(currentMetadata?.release_date)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderMobileAgentTooltip = () => {
        if (!isCompact || mobileTooltipOpen !== 'agent' || !currentAgent) return null;

        const hasCustomPrompt = Boolean(currentAgent.system && currentAgent.system.trim().length > 0);
        const hasModelConfig = currentAgent.model?.providerID && currentAgent.model?.id;
        const hasTemperatureOrTopP = agentTemperature(currentAgent) !== undefined || agentTopP(currentAgent) !== undefined;

        const summarizePermission = (permissionName: string): { mode: EditPermissionMode; label: string } => {
            const rules = currentAgent.permissions ?? [];
            const hasCustom = rules.some((rule) => rule.action === permissionName && rule.resource !== '*');
            const action = resolveWildcardPermissionEffect(rules, permissionName) ?? 'ask';

            if (hasCustom) {
                return { mode: 'ask', label: t('chat.modelControls.permissionLabel.custom') };
            }

            if (action === 'allow') return { mode: 'allow', label: t('chat.modelControls.permissionLabel.allow') };
            if (action === 'deny') return { mode: 'deny', label: t('chat.modelControls.permissionLabel.deny') };
            return { mode: 'ask', label: t('chat.modelControls.permissionLabel.ask') };
        };

        const editPermissionSummary = summarizePermission('edit');
        const bashPermissionSummary = summarizePermission(OPENCODE_TOOLS.shell);
        const webfetchPermissionSummary = summarizePermission(OPENCODE_TOOLS.webfetch);

        return (
            <MobileOverlayPanel
                open={true}
                onClose={closeMobileTooltip}
                title={agentLabel(currentAgent)}
            >
                <div className="flex flex-col gap-1.5">
                    {}
                    {currentAgent.description && (
                        <div className="oc-tile rounded-lg px-3 py-2">
                            <div className="typography-meta text-foreground">{currentAgent.description}</div>
                        </div>
                    )}

                    {}
                    <div className="oc-tile rounded-lg px-3 py-2">
                        <div className="typography-micro text-muted-foreground mb-0.5">{t('chat.modelControls.mode')}</div>
                        <div className="typography-meta text-foreground font-medium">
                            {currentAgent.mode === 'primary'
                                ? t('chat.modelControls.modeValue.primary')
                                : currentAgent.mode === 'subagent'
                                    ? t('chat.modelControls.modeValue.subagent')
                                    : currentAgent.mode === 'all'
                                        ? t('chat.modelControls.modeValue.all')
                                        : t('chat.modelControls.modeValue.none')}
                        </div>
                    </div>

                    {}
                    {(hasModelConfig || hasTemperatureOrTopP) && (
                        <div className="oc-tile rounded-lg px-3 py-2">
                            <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.model')}</div>
                            {hasModelConfig && (
                                <div className="typography-meta text-foreground font-medium mb-1">
                                    {currentAgent.model!.providerID} / {currentAgent.model!.id}
                                </div>
                            )}
                            {hasTemperatureOrTopP && (
                                <div className="flex flex-col gap-0.5">
                                    {agentTemperature(currentAgent) !== undefined && (
                                        <div className="flex items-center justify-between">
                                            <span className="typography-meta text-muted-foreground">{t('chat.modelControls.temperature')}</span>
                                            <span className="typography-meta font-medium text-foreground">{agentTemperature(currentAgent)}</span>
                                        </div>
                                    )}
                                    {agentTopP(currentAgent) !== undefined && (
                                        <div className="flex items-center justify-between">
                                            <span className="typography-meta text-muted-foreground">{t('chat.modelControls.topP')}</span>
                                            <span className="typography-meta font-medium text-foreground">{agentTopP(currentAgent)}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {}
                    <div className="oc-tile rounded-lg px-3 py-2">
                        <div className="typography-micro text-muted-foreground mb-1">{t('chat.modelControls.permissions')}</div>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.edit')}</span>
                                <div className="flex items-center gap-1.5">
                                    <EditModeIcon mode={editPermissionSummary.mode} className="size-3.5" />
                                    <span className="typography-meta font-medium text-foreground">
                                        {editPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.bash')}</span>
                                <div className="flex items-center gap-1.5">
                                    <EditModeIcon mode={bashPermissionSummary.mode} className="size-3.5" />
                                    <span className="typography-meta font-medium text-foreground">
                                        {bashPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.webFetch')}</span>
                                <div className="flex items-center gap-1.5">
                                    <EditModeIcon mode={webfetchPermissionSummary.mode} className="size-3.5" />
                                    <span className="typography-meta font-medium text-foreground">
                                        {webfetchPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {}
                    {hasCustomPrompt && (
                        <div className="oc-tile rounded-lg px-3 py-2">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.customPrompt')}</span>
                                <Icon name="checkbox-circle" className="size-4 text-foreground" />
                            </div>
                        </div>
                    )}
                </div>
            </MobileOverlayPanel>
        );
    };

    const handleMobileModelApply = (providerId: string, modelId: string) => {
        const result = selection
            ? applyModelSelectionWithVariant(providerId, modelId, resolveModelVariantSelection(providerId, modelId) ?? null)
            : tryApplyModelSelection(providerId, modelId);
        if (result !== 'applied') {
            if (result === 'provider-missing') {
                console.error('[ModelControls] Provider not available for selection:', providerId);
            } else if (result === 'model-missing') {
                console.error('[ModelControls] Model not available for selection:', { providerId, modelId });
            }
            return;
        }
        const pickedSessionId = selection ? controlledSessionId : currentSessionId;
        if (pickedSessionId) useSelectionStore.getState().pickSessionModel(pickedSessionId, providerId, modelId);
        if (!selection) setLastSelectedModel(providerId, modelId);
        setMobileDetailsEntry(null);
        closeMobilePanel();
        requestAnimationFrame(focusColumnInput);
    };

    const renderMobileModelPanel = () => {
        if (!isCompact) return null;

        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'model'}
                onClose={closeMobilePanel}
                title={t('chat.modelControls.selectModel')}
                scrollContent={false}
            >
                <ModelPickerList
                    providers={providers}
                    providerOrder={providerOrder}
                    favoriteModels={favoriteModelsList}
                    recentModels={recentModelsList}
                    hiddenModels={hiddenModels}
                    searchQuery={mobileModelQuery}
                    onSearchQueryChange={setMobileModelQuery}
                    onSelect={(entry) => handleMobileModelApply(entry.providerID, entry.modelID)}
                    labels={modelPickerLabels}
                    selectedModel={currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null}
                    leadingEntry={autoEntry}
                    searchAction={selection ? null : { label: t('chat.modelControls.addNewProvider'), icon: 'add', onSelect: openAddProviderSettings }}
                    isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
                    onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
                    onEntryDetails={(entry) => {
                        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                        setMobileDetailsEntry(entry);
                    }}
                    providersStartCollapsed
                    sheetCaptions
                    autoFocus={false}
                    tooltipsEnabled={false}
                    maxHeightClassName="min-h-0 flex-1"
                    showKeyboardHints={false}
                    onEscape={() => {
                        if (mobileDetailsEntry) setMobileDetailsEntry(null);
                        else closeMobilePanel();
                    }}
                />
            </MobileOverlayPanel>
        );
    };

    const renderMobileModelDetails = () => {
        if (!isCompact || !mobileDetailsEntry) return null;
        const { providerID, modelID, model } = mobileDetailsEntry;
        const auto = isAutoModel(providerID, modelID);
        const favorite = isFavoriteModel(providerID, modelID);
        const metadata = mergeModelMetadataWithLiveModel(providerID, model, getModelMetadata(providerID, modelID));
        const providerName = auto ? null : providers.find((provider) => provider.id === providerID)?.name || providerID;
        return (
            <MobileOverlayPanel
                open
                onClose={() => setMobileDetailsEntry(null)}
                title={getModelDisplayName(model)}
                footer={(
                    <div className="flex flex-col gap-2">
                        <Button size="lg" className="w-full" onClick={() => handleMobileModelApply(providerID, modelID)}>
                            {t('chat.modelControls.useModel')}
                        </Button>
                        {!auto ? (
                            <Button variant="outline" size="lg" className="w-full gap-1.5" onClick={() => toggleFavoriteModel(providerID, modelID)}>
                                <Icon name={favorite ? 'star-fill' : 'star'} className={cn('size-4', favorite && 'text-primary')} />
                                {favorite ? t('chat.modelControls.removeFromFavorites') : t('chat.modelControls.addToFavorites')}
                            </Button>
                        ) : null}
                    </div>
                )}
            >
                <div className="px-1 py-1">
                    <ModelPickerCardBody metadata={metadata} providerName={providerName} labels={modelPickerLabels} />
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderMobileVariantPanel = () => {
        if (!isCompact) return null;

        const targetProviderId = currentProviderId;
        const targetModelId = currentModelId;
        if (!targetProviderId || !targetModelId) return null;

        const targetVariants = getModelVariantOptions(targetProviderId, targetModelId);
        if (targetVariants.length === 0) return null;

        const selectedVariant = resolveModelVariantSelection(targetProviderId, targetModelId);
        const isDefault = !selectedVariant;

        const handleSelect = (variant: string | undefined) => {
            const result = applyModelSelectionWithVariant(targetProviderId, targetModelId, variant ?? null);
            if (result !== 'applied') {
                return;
            }

            rememberVariantForModel(targetProviderId, targetModelId, variant ?? null);
            closeMobilePanel();
            requestAnimationFrame(focusColumnInput);
        };

        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'variant'}
                onClose={closeMobilePanel}
                title={t('chat.modelControls.thinking')}
            >
                <MobileSheetRow selected={isDefault} onClick={() => handleSelect(undefined)}>
                    {t('chat.modelControls.default')}
                </MobileSheetRow>
                {targetVariants.map((variant) => (
                    <MobileSheetRow key={variant} selected={selectedVariant === variant} onClick={() => handleSelect(variant)}>
                        {formatEffortLabel(variant)}
                    </MobileSheetRow>
                ))}
            </MobileOverlayPanel>
        );
    };

    const renderMobileAgentPanel = () => {
        if (!isCompact) return null;

        const isFavoriteAgent = (agent: Agent) => favoriteAgents.includes(agent.name);
        const favoriteAgentRows = selectableDesktopAgents.filter(isFavoriteAgent);
        const otherAgentRows = [...selectableDesktopAgents]
            .filter((agent) => !isFavoriteAgent(agent))
            .sort((a, b) => a.name.localeCompare(b.name));

        const renderAgentRow = (agent: Agent) => (
            <MobileSheetRow
                key={agent.name}
                selected={agent.name === uiAgentName}
                leading={<span className="size-1.5 flex-shrink-0 rounded-full" style={{ background: getAgentColor(agent.name).color }} />}
                action={(
                    <AgentFavoriteToggle
                        className="h-7 w-7 [@media(pointer:coarse)]:h-9 [@media(pointer:coarse)]:w-9"
                        favorite={isFavoriteAgent(agent)}
                        onToggle={() => toggleFavoriteAgent(agent.name)}
                    />
                )}
                onClick={() => handleAgentChange(agent.name)}
            >
                {agentLabel(agent)}
            </MobileSheetRow>
        );

        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'agent'}
                onClose={closeMobilePanel}
                title={t('chat.modelControls.selectAgent')}
                contentMaxHeightClassName="max-h-[min(60dvh,420px)]"
            >
                {favoriteAgentRows.length > 0 ? (
                    <>
                        <MobileSheetSection title={t('chat.modelControls.favorites')} hint={t('chat.modelControls.favoriteAgentsTapHint')}>
                            {favoriteAgentRows.map(renderAgentRow)}
                        </MobileSheetSection>
                        {otherAgentRows.length > 0 ? (
                            <MobileSheetSection title={t('chat.modelControls.agentsSection')}>
                                {otherAgentRows.map(renderAgentRow)}
                            </MobileSheetSection>
                        ) : null}
                    </>
                ) : otherAgentRows.map(renderAgentRow)}
            </MobileOverlayPanel>
        );
    };

    const renderModelTooltipContent = () => modelUnavailableText ? (
        <TooltipContent align="start" sideOffset={8} className="max-w-[280px]">
            <div className="min-w-[200px] typography-meta text-foreground">
                <TooltipLabelWithShortcut label={modelUnavailableText} shortcut={modelShortcut} />
            </div>
        </TooltipContent>
    ) : (
        <TooltipContent align="start" sideOffset={8} className="max-w-[320px]">
            {currentMetadata ? (
                <div className="flex min-w-[240px] flex-col gap-3">
                    <div className="flex flex-col gap-0.5">
                        <span className="typography-micro font-semibold text-foreground">
                            <TooltipLabelWithShortcut label={currentMetadata.name || getCurrentModelDisplayName()} shortcut={modelShortcut} />
                        </span>
                        <span className="typography-meta text-muted-foreground">{getProviderDisplayName()}</span>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">{t('chat.modelControls.capabilities')}</span>
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
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">{t('chat.modelControls.modalities')}</span>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground">{t('chat.modelControls.input')}</span>
                                <div className="flex items-center gap-1.5">
                                    {inputModalityIcons.length > 0
                                        ? inputModalityIcons.map(({ key, icon, label }) =>
                                              <IconBadge key={`input-${key}`} iconName={icon} label={`${label} input`} />
                                          )
                                        : <span className="typography-meta text-muted-foreground">-</span>}
                                </div>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground">{t('chat.modelControls.output')}</span>
                                <div className="flex items-center gap-1.5">
                                    {outputModalityIcons.length > 0
                                        ? outputModalityIcons.map(({ key, icon, label }) =>
                                              <IconBadge key={`output-${key}`} iconName={icon} label={`${label} output`} />
                                          )
                                        : <span className="typography-meta text-muted-foreground">-</span>}
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">{t('chat.modelControls.costPerMillion')}</span>
                        {costRows.map((row) => (
                            <div key={row.label} className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground">{row.label}</span>
                                <span className="typography-meta font-medium text-foreground">{row.value}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">{t('chat.modelControls.limits')}</span>
                        {limitRows.map((row) => (
                            <div key={row.label} className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground">{row.label}</span>
                                <span className="typography-meta font-medium text-foreground">{row.value}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">{t('chat.modelControls.metadata')}</span>
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta font-medium text-muted-foreground">{t('chat.modelControls.knowledge')}</span>
                            <span className="typography-meta font-medium text-foreground">{formatKnowledge(currentMetadata.knowledge)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta font-medium text-muted-foreground">{t('chat.modelControls.release')}</span>
                            <span className="typography-meta font-medium text-foreground">{formatDate(currentMetadata.release_date)}</span>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="min-w-[200px] typography-meta text-muted-foreground"><TooltipLabelWithShortcut label={t('chat.modelControls.metadataUnavailable')} shortcut={modelShortcut} /></div>
            )}
        </TooltipContent>
    );

    const renderModelSelector = () => {
        if (isCompact && selection) {
            return <MobileModelButton
                model={selection.model}
                onOpenModel={() => setActiveMobilePanel('model')}
                className="model-controls__model-trigger min-w-0"
            />;
        }
        const handleThinkingVariantKey = (e: React.KeyboardEvent, selectedItem: ModelPickerEntry) => {
            keyboardOwnsModelSelectionRef.current = true;
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return false;

            const { providerID, modelID } = selectedItem;
            const variantKeys = getModelVariantOptions(providerID, modelID);
            if (variantKeys.length === 0) return false;

            e.preventDefault();
            e.stopPropagation();

            const mapKey = buildModelRefKey(providerID, modelID);
            const hasPendingVariant = pendingThinkingVariants.has(mapKey);
            const currentPending = pendingThinkingVariants.get(mapKey);
            const activeModelVariant = hasPendingVariant
                ? currentPending
                : resolveModelVariantSelection(providerID, modelID) ?? undefined;

            const variantsWithDefault: Array<string | undefined> = [undefined, ...variantKeys];
            const currentVariantIndex = variantsWithDefault.indexOf(activeModelVariant);
            const safeCurrentIndex = currentVariantIndex >= 0 ? currentVariantIndex : 0;
            const forwardKey = isRightToLeft(e.currentTarget) ? 'ArrowLeft' : 'ArrowRight';
            const direction = e.key === forwardKey ? 1 : -1;
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
            rememberVariantForModel(providerID, modelID, nextVariant ?? null);
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


        const renderThinkingSlot = (entry: ModelPickerEntry, { isHighlighted, isSelected }: { isHighlighted: boolean; isSelected: boolean }) => {
            const hasThinkingVariants = getModelVariantOptions(entry.providerID, entry.modelID).length > 0;
            const mapKey = buildModelRefKey(entry.providerID, entry.modelID);
            const wasAdjusted = adjustedThinkingModels.has(mapKey);
            if (!hasThinkingVariants || (!isHighlighted && !isSelected)) return null;

            const hasPendingVariant = pendingThinkingVariants.has(mapKey);
            const pendingVariant = pendingThinkingVariants.get(mapKey);
            const effectiveVariant = hasPendingVariant
                ? pendingVariant
                : resolveModelVariantSelection(entry.providerID, entry.modelID) ?? undefined;
            const displayLabel = effectiveVariant ? formatEffortLabel(effectiveVariant) : t('chat.modelControls.default');

            return (
                <span className={cn(
                    'typography-micro whitespace-nowrap lowercase',
                    isHighlighted
                        ? (wasAdjusted ? 'text-interactive-selection-foreground' : 'text-interactive-selection-foreground/70')
                        : (wasAdjusted ? 'text-foreground' : 'text-muted-foreground'),
                )}>
                    <span aria-hidden="true" className="opacity-60">/ </span>{displayLabel}
                </span>
            );
        };

        return (
            <Tooltip delayDuration={600}>
                {!isCompact ? (
                    <DropdownMenu open={isReady && agentMenuOpen} onOpenChange={isReady ? handleModelMenuOpenChange : undefined}>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild nativeButton={false}>
                                <div
                                    ref={modelTriggerRef}
                                    aria-label={modelUnavailableText}
                                    className={cn(
                                        'model-controls__model-trigger flex items-center gap-1.5 cursor-pointer select-none hover:bg-transparent hover:opacity-70 min-w-0 overflow-hidden',
                                        buttonHeight
                                    )}
                                >
                                    {!modelSelectionReady ? (
                                        <>
                                            <ReadinessMark unavailable={isUnavailable} className={cn(controlIconSize, 'text-muted-foreground flex-shrink-0')} />
                                            <span className={cn(
                                                'model-controls__model-label',
                                                controlTextSize,
                                                'font-medium whitespace-nowrap text-muted-foreground min-w-0'
                                            )}>
                                                {readinessLabel}
                                            </span>
                                        </>
                                    ) : isAutoSelected ? (
                                        <Icon name="openchamber" className={cn(controlIconSize, 'flex-shrink-0')} />
                                    ) : modelUnavailable ? (
                                        <Icon name="error-warning" className={cn(controlIconSize, 'flex-shrink-0 text-[var(--status-warning)]')} />
                                    ) : currentProviderId ? (
                                        <>
                                            <ProviderLogo
                                                providerId={currentProviderId}
                                                className={cn(providerLogoSize, 'flex-shrink-0')}
                                            />
                                            <Icon name="pencil-ai" className={cn(controlIconSize, 'text-primary/60 hidden')} />
                                        </>
                                    ) : (
                                        <Icon name="pencil-ai" className={cn(controlIconSize, 'text-muted-foreground')} />
                                    )}
                                    {modelSelectionReady && (
                                        <span
                                            ref={modelLabelRef}
                                            key={`${currentProviderId}-${currentModelId}`}
                                            className={cn(
                                                'model-controls__model-label overflow-hidden text-ellipsis',
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
                            side={modelMenuSide}
                            className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col overflow-hidden"
                            align="end"
                            alignOffset={-40}
                            constrainToMain
                            collisionAvoidance={{ side: 'none', align: 'shift' }}
                            onKeyDownCapture={handleModelShortcutKeyDownCapture}
                        >
                            <ModelPickerList
                                providers={providers}
                                favoriteModels={favoriteModelsList}
                                recentModels={recentModelsList}
                                searchQuery={desktopModelQuery}
                                onSearchQueryChange={setDesktopModelQuery}
                                onSelect={handleSharedModelSelect}
                                labels={modelPickerLabels}
                                selectedModel={currentProviderId && currentModelId ? { providerID: currentProviderId, modelID: currentModelId } : null}
                                leadingEntry={autoEntry}
                                searchAction={selection ? null : { label: t('chat.modelControls.addNewProvider'), icon: 'add', onSelect: openAddProviderSettings }}
                                leadingAction={onRunInParallel ? {
                                    label: t('chat.modelControls.runInParallel'),
                                    icon: <ArrowsMerge className="h-3.5 w-3.5 flex-shrink-0" />,
                                    onSelect: () => {
                                        setModelSelectorOpen(false);
                                        onRunInParallel();
                                    },
                                } : null}
                                hiddenModels={hiddenModels}
                                onActiveKeyDown={handleModelPickerKeyDown}
                                onActiveEntryChange={(entry) => { activeModelPickerEntryRef.current = entry; }}
                                onVariantKey={handleThinkingVariantKey}
                                isFavorite={(entry) => isFavoriteModel(entry.providerID, entry.modelID)}
                                onToggleFavorite={(entry) => toggleFavoriteModel(entry.providerID, entry.modelID)}
                                renderRowEnd={renderThinkingSlot}
                                renderVersion={modelPickerRenderVersion}
                                onReorderFavorite={(active, over) => reorderFavoriteModel(
                                    active.providerID,
                                    active.modelID,
                                    over.providerID,
                                    over.modelID,
                                )}
                                providerOrder={providerOrder}
                                onReorderProvider={setProviderOrder}
                                reorderProviderTitle={t('chat.modelControls.reorderProviderTitle')}
                                footerContent={(activeEntry) => {
                                    const activeHasThinkingVariants = activeEntry
                                        ? getModelVariantOptions(activeEntry.providerID, activeEntry.modelID).length > 0
                                        : false;

                                    return (
                                        <div className="flex items-center gap-x-4 whitespace-nowrap overflow-hidden">
                                            <span>{t('chat.modelControls.keyboardHintNavigate')}</span>
                                            {agentShortcut ? <span>{t('chat.modelControls.keyboardHintSwitchAgent', { shortcut: agentShortcut })}</span> : null}
                                            {activeHasThinkingVariants ? <span>{t('chat.modelControls.keyboardHintThinking')}</span> : null}
                                        </div>
                                    );
                                }}
                                maxHeightClassName="max-h-[min(400px,calc(var(--available-height)-4rem))] flex-1"
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
                        aria-label={modelUnavailableText}
                        className={cn(
                            'model-controls__model-trigger flex items-center gap-1.5 min-w-0 focus:outline-none',
                            isReady ? 'cursor-pointer hover:bg-transparent hover:opacity-70' : 'opacity-60 cursor-not-allowed',
                            buttonHeight
                        )}
                    >
                        {!modelSelectionReady ? (
                            <>
                                <ReadinessMark unavailable={isUnavailable} className={cn(controlIconSize, 'text-muted-foreground flex-shrink-0')} />
                                <span className="typography-micro font-medium text-muted-foreground min-w-0">
                                    {readinessLabel}
                                </span>
                            </>
                        ) : (
                            <>
                                {isAutoSelected ? (
                                    <Icon name="openchamber" className={cn(controlIconSize, 'flex-shrink-0')} />
                                ) : modelUnavailable ? (
                                    <Icon name="error-warning" className={cn(controlIconSize, 'flex-shrink-0 text-[var(--status-warning)]')} />
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
                                        'model-controls__model-label typography-micro font-medium overflow-hidden text-ellipsis whitespace-nowrap min-w-0',
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
        if (agentUnavailableText) {
            return (
                <TooltipContent align="start" sideOffset={8} className="max-w-[280px]">
                    <div className="min-w-[200px] typography-meta text-foreground"><TooltipLabelWithShortcut label={agentUnavailableText} shortcut={agentShortcut} /></div>
                </TooltipContent>
            );
        }
        if (!currentAgent) {
            return (
                <TooltipContent align="start" sideOffset={8} className="max-w-[320px]">
                    <div className="min-w-[200px] typography-meta text-muted-foreground"><TooltipLabelWithShortcut label={t('chat.modelControls.noAgentSelected')} shortcut={agentShortcut} /></div>
                </TooltipContent>
            );
        }

        const hasCustomPrompt = Boolean(currentAgent.system && currentAgent.system.trim().length > 0);
        const hasModelConfig = currentAgent.model?.providerID && currentAgent.model?.id;
        const hasTemperatureOrTopP = agentTemperature(currentAgent) !== undefined || agentTopP(currentAgent) !== undefined;

        const summarizePermission = (permissionName: string): { mode: EditPermissionMode; label: string } => {
            const rules = currentAgent.permissions ?? [];
            const hasCustom = rules.some((rule) => rule.action === permissionName && rule.resource !== '*');
            const action = resolveWildcardPermissionEffect(rules, permissionName) ?? 'ask';

            if (hasCustom) {
                                return { mode: 'ask', label: t('chat.modelControls.permissionLabel.custom') };
                            }

            if (action === 'allow') return { mode: 'allow', label: t('chat.modelControls.permissionLabel.allow') };
            if (action === 'deny') return { mode: 'deny', label: t('chat.modelControls.permissionLabel.deny') };
            return { mode: 'ask', label: t('chat.modelControls.permissionLabel.ask') };
        };

        const editPermissionSummary = summarizePermission('edit');
        const bashPermissionSummary = summarizePermission(OPENCODE_TOOLS.shell);
        const webfetchPermissionSummary = summarizePermission(OPENCODE_TOOLS.webfetch);

        return (
            <TooltipContent align="start" sideOffset={8} className="max-w-[280px]">
                <div className="flex min-w-[200px] flex-col gap-2.5">
                    <div className="flex flex-col gap-0.5">
                        <span className="typography-micro font-semibold text-foreground">
                            <TooltipLabelWithShortcut label={agentLabel(currentAgent)} shortcut={agentShortcut} />
                        </span>
                        {currentAgent.description && (
                            <span className="typography-meta text-muted-foreground">{currentAgent.description}</span>
                        )}
                    </div>

                    <div className="flex flex-col gap-1">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">{t('chat.modelControls.mode')}</span>
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
                            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">{t('chat.modelControls.model')}</span>
                            {hasModelConfig ? (
                                <span className="typography-meta text-foreground">
                                    {currentAgent.model!.providerID} / {currentAgent.model!.id}
                                </span>
                            ) : (
                                <span className="typography-meta text-muted-foreground">{t('chat.modelControls.modeValue.none')}</span>
                            )}
                            {hasTemperatureOrTopP && (
                                <div className="flex flex-col gap-0.5 mt-0.5">
                                    {agentTemperature(currentAgent) !== undefined && (
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="typography-meta text-muted-foreground">{t('chat.modelControls.temperature')}</span>
                                            <span className="typography-meta font-medium text-foreground">{agentTemperature(currentAgent)}</span>
                                        </div>
                                    )}
                                    {agentTopP(currentAgent) !== undefined && (
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="typography-meta text-muted-foreground">{t('chat.modelControls.topP')}</span>
                                            <span className="typography-meta font-medium text-foreground">{agentTopP(currentAgent)}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="flex flex-col gap-1">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground">{t('chat.modelControls.permissions')}</span>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground w-16">{t('chat.modelControls.edit')}</span>
                            <div className="flex items-center gap-1.5">
                                <EditModeIcon mode={editPermissionSummary.mode} className="size-3.5" />
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {editPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground w-16">{t('chat.modelControls.bash')}</span>
                            <div className="flex items-center gap-1.5">
                                <EditModeIcon mode={bashPermissionSummary.mode} className="size-3.5" />
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {bashPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground w-16">{t('chat.modelControls.webFetch')}</span>
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
                            <span className="typography-meta text-muted-foreground">{t('chat.modelControls.customPrompt')}</span>
                            <Icon name="checkbox-circle" className="size-4 text-foreground" />
                        </div>
                    )}
                </div>
            </TooltipContent>
        );
    };

    const renderVariantSelector = () => {
        if (!isReady || !hasVariants || isAutoSelected) {
            return null;
        }

        const displayVariant = currentVariant ? formatEffortLabel(currentVariant) : t('chat.modelControls.default');
        const isDefault = !currentVariant;
        const isGreyEffort = getEffortTone(currentVariant) === 'default';
        const triggerLabel = (
            <>
                <Icon name="brain-ai-3" className={cn('model-controls__variant-icon flex-shrink-0 text-muted-foreground group-hover:text-foreground', controlIconSize)} />
                <span aria-hidden="true" className={cn('model-controls__variant-slash text-muted-foreground/60', controlTextSize)}>/</span>
                <span
                    className={cn(
                        'model-controls__variant-label',
                        controlTextSize,
                        'font-medium min-w-0 truncate lowercase',
                        getEffortToneClass(currentVariant),
                        isGreyEffort ? 'group-hover:text-foreground' : 'group-hover:opacity-100',
                        isMobile && 'max-w-[60px]',
                        isDesktop && 'max-w-[180px]',
                    )}
                >
                    {displayVariant}
                </span>
            </>
        );
        const isInherited = !selection && !isDefault && currentVariantSelection.override === undefined;
        const agentVariant = currentAgent?.model?.providerID === currentProviderId
            && currentAgent.model.id === currentModelId
            ? currentAgent.model.variant
            : undefined;
        const hasConfiguredInherited = [agentVariant, getDefaultVariantForModel(currentProviderId, currentModelId)]
            .some((candidate) => candidate !== undefined && displayVariants.includes(candidate));
        const rememberedVariant = lastUsedEfforts?.[effortMemoryKey(currentProviderId, currentModelId)];
        const isRemembered = isInherited
            && currentVariant === rememberedVariant
            && !hasConfiguredInherited;
        const tooltipText = isRemembered
            ? t('chat.modelControls.rememberedVariantTooltip', { variant: displayVariant })
            : isInherited
                ? t('chat.modelControls.inheritedVariantTooltip', { variant: displayVariant })
                : `${t('chat.modelControls.thinking')}: ${displayVariant}`;

        if (isCompact) {
            return (
                <button
                    type="button"
                    onClick={() => setActiveMobilePanel('variant')}
                    onMouseDown={(event) => event.preventDefault()}
                    onPointerDownCapture={(event) => {
                        if (event.pointerType === 'touch') event.preventDefault();
                    }}
                    aria-label={tooltipText}
                    className={cn(
                        'model-controls__variant-trigger group -my-[5px] flex flex-shrink-0 items-center gap-1 px-1.5 focus:outline-none',
                        buttonHeight,
                        'cursor-pointer hover:bg-transparent',
                    )}
                >
                    {triggerLabel}
                </button>
            );
        }

        return (
            <Tooltip delayDuration={600}>
                <DropdownMenu>
                    <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild nativeButton={false}>
                            <div
                                ref={variantTriggerRef}
                                aria-label={tooltipText}
                                className={cn(
                                    'model-controls__variant-trigger group flex flex-shrink-0 items-center gap-1 cursor-pointer select-none hover:bg-transparent overflow-hidden',
                                    buttonHeight,
                                )}
                            >
                                {triggerLabel}
                            </div>
                        </DropdownMenuTrigger>
                    </TooltipTrigger>
                    <DropdownMenuContent side="top" align="end" alignOffset={-40} className="w-max max-w-[calc(100vw-2rem)]">
                        <DropdownMenuLabel className={PICKER_SECTION_HEADER_CLASS}>{t('chat.modelControls.thinking')}</DropdownMenuLabel>
                        <DropdownMenuItem className="typography-meta" onSelect={() => handleVariantSelect(undefined)}>
                            <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                <span className="typography-meta font-medium text-foreground truncate min-w-0 lowercase">{t('chat.modelControls.default')}</span>
                                {isDefault && <Icon name="check" className="size-4 text-inherit flex-shrink-0" />}
                            </div>
                        </DropdownMenuItem>
                        {displayVariants.map((variant) => {
                            const selected = currentVariant === variant;
                            const label = formatEffortLabel(variant);
                            return (
                                <DropdownMenuItem
                                    key={variant}
                                    className="typography-meta"
                                    onSelect={() => handleVariantSelect(variant)}
                                >
                                    <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                        <span className="typography-meta font-medium text-foreground truncate min-w-0 lowercase">{label}</span>
                                        {selected && <Icon name="check" className="size-4 text-inherit flex-shrink-0" />}
                                    </div>
                                </DropdownMenuItem>
                            );
                        })}
                        <div className="-mx-1 -mb-1 mt-1 flex items-center gap-x-4 overflow-hidden whitespace-nowrap border-t border-edge-muted px-3 pt-1 pb-1.5 typography-micro text-muted-foreground">
                            <span>{t('chat.modelControls.keyboardHintNavigate')}</span>
                            {thinkingShortcut ? <span>{t('chat.modelControls.keyboardHintSwitchThinking', { shortcut: thinkingShortcut })}</span> : null}
                        </div>
                    </DropdownMenuContent>
                </DropdownMenu>
                <TooltipContent side="top">
                    <TooltipLabelWithShortcut label={tooltipText} shortcut={thinkingShortcut} />
                </TooltipContent>
            </Tooltip>
        );
    };

    const renderAgentMark = () => agentUnavailable ? (
        <Icon name="error-warning" className={cn(controlIconSize, 'flex-shrink-0 text-[var(--status-warning)]')} />
    ) : (
        <Icon name="ai-agent"
            className={cn(
                controlIconSize,
                'flex-shrink-0',
                uiAgentName ? '' : 'text-muted-foreground'
            )}
            style={uiAgentName ? { color: restingAgentColor(getAgentColor(uiAgentName).color) } : undefined}
        />
    );

    const renderAgentSelector = () => {
        if (!isCompact) {
            const isFavoriteAgent = (agent: Agent) => favoriteAgents.includes(agent.name);
            const favoriteAgentRows = agentSearchQuery.trim() ? [] : selectableDesktopAgents.filter(isFavoriteAgent);
            const otherAgentRows = favoriteAgentRows.length > 0
                ? sortedAndFilteredAgents.filter((agent) => !isFavoriteAgent(agent))
                : sortedAndFilteredAgents;
            const focusFirstAgentItem = () => {
                agentListRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
            };
            const handleAgentSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
                if (handleDropdownNavigationKey(event, (key) => { if (key === 'ArrowDown') focusFirstAgentItem(); })) return;
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    focusFirstAgentItem();
                } else if (event.key === 'Enter' && !isIMECompositionEvent(event)) {
                    const topAgent = favoriteAgentRows[0] ?? otherAgentRows[0];
                    if (topAgent) {
                        event.preventDefault();
                        handleAgentChange(topAgent.name);
                        setIsAgentSelectorOpen(false);
                    }
                }
                event.stopPropagation();
            };
            const renderAgentMenuItem = (agent: Agent) => (
                <AgentDescriptionTooltip key={agent.name} description={agent.description}>
                    <DropdownMenuItem
                        className="typography-meta"
                        onSelect={() => handleAgentChange(agent.name)}
                    >
                        <div className="flex w-full items-center gap-1.5">
                            <div className="h-1 w-1 rounded-full" style={{ background: getAgentColor(agent.name).color }} />
                            <span className="min-w-0 truncate font-medium">{agentLabel(agent)}</span>
                            <span className="ms-auto flex flex-shrink-0 items-center gap-1.5">
                                {agent.name === uiAgentName ? <Icon name="check" className="size-4 text-inherit" /> : null}
                                <AgentFavoriteToggle
                                    favorite={isFavoriteAgent(agent)}
                                    onToggle={() => toggleFavoriteAgent(agent.name)}
                                />
                            </span>
                        </div>
                    </DropdownMenuItem>
                </AgentDescriptionTooltip>
            );
            return (
                <div className="flex flex-shrink-0 items-center gap-2">
                    <Tooltip delayDuration={600}>
                        <DropdownMenu open={canSelectAgent && isAgentSelectorOpen} onOpenChange={canSelectAgent ? setIsAgentSelectorOpen : undefined}>
                            <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild nativeButton={false}>
                                    <div ref={agentTriggerRef} aria-label={agentUnavailableText} className={cn(
                                        'flex items-center gap-1.5 transition-colors cursor-pointer select-none hover:bg-transparent hover:opacity-70 min-w-0 overflow-hidden',
                                        buttonHeight
                                    )}>
                                        {!agentSelectionReady ? (
                                            <>
                                                <ReadinessMark unavailable={isUnavailable}
                                                    className={cn(
                                                        controlIconSize,
                                                        'flex-shrink-0 text-muted-foreground'
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
                                                {renderAgentMark()}
                                                <span
                                                    className={cn(
                                                        'model-controls__agent-label',
                                                        controlTextSize,
                                                        'font-medium min-w-0 truncate text-foreground',
                                                        isDesktop ? 'max-w-[220px]' : undefined
                                                    )}
                                                >
                                                    {getAgentDisplayName()}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <DropdownMenuContent side={agentMenuSide} align="end" alignOffset={-40} constrainToMain collisionAvoidance={{ side: 'none', align: 'shift' }} className="w-[min(280px,calc(100vw-2rem))] p-0 flex flex-col overflow-hidden">
                                <div className="px-2 py-1 border-b border-edge-muted">
                                    <div className="relative">
                                        <Icon name="search" className="absolute inset-s-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
                                        <Input
                                            type="text"
                                            placeholder={t('chat.modelControls.searchAgents')}
                                            value={agentSearchQuery}
                                            onChange={(e) => setAgentSearchQuery(e.target.value)}
                                            onKeyDown={handleAgentSearchKeyDown}
                                            className="h-7 rounded-none bg-transparent ps-8 pe-0 typography-meta ring-0 hover:[&:not(:focus)]:bg-transparent hover:[&:not(:focus)]:[background-image:none] focus:ring-0 focus-visible:ring-0"
                                        />
                                    </div>
                                </div>
                                <ScrollableOverlay outerClassName="max-h-[min(400px,calc(var(--available-height)-4rem))] flex-1">
                                    <div ref={agentListRef} className="p-1">
                                        {sortedAndFilteredAgents.length === 0 ? (
                                            <div className="px-2 py-4 text-center typography-meta text-muted-foreground">
                                                {t('chat.modelControls.noAgentsFound')}
                                            </div>
                                        ) : favoriteAgentRows.length > 0 ? (
                                            <>
                                                <div role="group" aria-label={t('chat.modelControls.favorites')}>
                                                    <div className={PICKER_SECTION_HEADER_CLASS}>
                                                        <span className="min-w-0 truncate">{t('chat.modelControls.favorites')}</span>
                                                        {agentShortcut ? (
                                                            <span className="ms-auto flex-shrink-0 normal-case tracking-normal font-normal">
                                                                {t('chat.modelControls.favoriteAgentsCycleHint', { shortcut: agentShortcut })}
                                                            </span>
                                                        ) : null}
                                                    </div>
                                                    {favoriteAgentRows.map(renderAgentMenuItem)}
                                                </div>
                                                {otherAgentRows.length > 0 ? (
                                                    <>
                                                        <div className="h-px bg-edge-muted my-1" />
                                                        <div role="group" aria-label={t('chat.modelControls.agentsSection')}>
                                                            <div className={PICKER_SECTION_HEADER_CLASS}>{t('chat.modelControls.agentsSection')}</div>
                                                            {otherAgentRows.map(renderAgentMenuItem)}
                                                        </div>
                                                    </>
                                                ) : null}
                                            </>
                                        ) : (
                                            sortedAndFilteredAgents.map(renderAgentMenuItem)
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
                onClick={canSelectAgent ? () => setActiveMobilePanel('agent') : undefined}
                onTouchStart={canSelectAgent ? () => handleLongPressStart('agent') : undefined}
                onTouchEnd={canSelectAgent ? handleLongPressEnd : undefined}
                onTouchCancel={canSelectAgent ? handleLongPressEnd : undefined}
                disabled={!canSelectAgent}
                aria-label={agentUnavailableText}
                className={cn(
                    'model-controls__agent-trigger -my-[5px] flex flex-shrink-0 items-center gap-1.5 transition-colors min-w-0 focus:outline-none',
                    buttonHeight,
                    canSelectAgent ? 'cursor-pointer hover:bg-transparent hover:opacity-70' : 'opacity-60 cursor-not-allowed',
                )}
            >
                {!agentSelectionReady ? (
                    <>
                        <ReadinessMark unavailable={isUnavailable}
                            className={cn(
                                controlIconSize,
                                'flex-shrink-0 text-muted-foreground'
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
                        {agentUnavailable ? renderAgentMark() : null}
                        <span
                            className={cn(
                                'model-controls__agent-label',
                                controlTextSize,
                                'font-medium truncate min-w-0',
                                (agentUnavailable || !uiAgentName) && 'text-foreground',
                            )}
                            style={!agentUnavailable && uiAgentName ? { color: restingAgentColor(getAgentColor(uiAgentName).color) } : undefined}
                        >
                            {getAgentDisplayName()}
                        </span>
                    </>
                )}
            </button>
        );
    };

    const inlineMobileSelection = isMobile && Boolean(selection);
    const inlineClassName = cn(
        'flex items-center min-w-0',
        !isMobile && '@container/model-controls',
        isMobile && 'w-full',
        className,
    );

    if (agentOnly) {
        return <div className={cn(inlineClassName, 'justify-end')}>{renderAgentSelector()}</div>;
    }

    return (
        <>
            <div className={inlineClassName}>
                <div
                    className={cn(
                        'flex items-center min-w-0 flex-1',
                        inlineMobileSelection ? 'justify-between' : 'justify-end',
                        inlineGapClass,
                        sizeVariant === 'default' && 'model-controls__row pe-3',
                    )}
                >
                    <div className={cn('flex items-center min-w-0', isMobile ? 'gap-x-0.5' : sizeVariant === 'vscode' ? 'gap-x-2' : 'gap-x-1.5')}>
                        {renderModelSelector()}
                        {renderVariantSelector()}
                    </div>
                    {!isAutoSelected && renderAgentSelector()}
                </div>
            </div>

            {renderMobileModelPanel()}
            {renderMobileModelDetails()}
            {renderMobileVariantPanel()}
            {!isAutoSelected && renderMobileAgentPanel()}
            {renderMobileModelTooltip()}
            {!isAutoSelected && renderMobileAgentTooltip()}
        </>
    );

};
