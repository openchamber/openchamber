import React from 'react';
import type { ComponentType } from 'react';
import {
    RiAddLine,
    RiAiAgentLine,
    RiArrowDownSLine,
    RiArrowGoBackLine,
    RiArrowRightSLine,
    RiBrainAi3Line,
    RiCheckLine,
    RiCheckboxCircleLine,
    RiCloseCircleLine,
    RiFileImageLine,
    RiFileMusicLine,
    RiFilePdfLine,
    RiFileVideoLine,
    RiPencilAiLine,
    RiQuestionLine,
    RiSearchLine,
    RiStarFill,
    RiStarLine,
    RiText,
    RiTimeLine,
    RiToolsLine,
} from '@remixicon/react';
import type { EditPermissionMode } from '@/stores/types/sessionTypes';
import type { ModelMetadata } from '@/types';
import type { Provider } from '@opencode-ai/sdk/v2';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { BackendIcon } from '@/components/ui/BackendIcon';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { TextLoop } from '@/components/ui/TextLoop';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useIsVSCodeRuntime } from '@/hooks/useRuntimeAPIs';
import { isDesktopShell } from '@/lib/desktop';
import { opencodeClient } from '@/lib/opencode/client';
import { getAgentColor } from '@/lib/agentColors';
import { useDeviceInfo } from '@/lib/device';
import { getEditModeColors } from '@/lib/permissions/editModeColors';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useContextStore } from '@/stores/contextStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useDirectorySync, useSession, useSessionMessages } from '@/sync/sync-context';
import { useSync } from '@/sync/use-sync';
import { useUIStore } from '@/stores/useUIStore';
import { useModelLists } from '@/hooks/useModelLists';
import { useIsTextTruncated } from '@/hooks/useIsTextTruncated';
import type { BackendControlSurface, BackendControlSurfaceOption, BackendDescriptor } from '@/lib/api/types';
import type { MobileControlsPanel } from './mobileControlsUtils';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type IconComponent = ComponentType<any>;

type ProviderModel = Provider["models"][string];

type PermissionAction = 'allow' | 'ask' | 'deny';
type PermissionRule = { permission: string; pattern: string; action: PermissionAction };

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

const BackendMenuLogo: React.FC<{
    backendId: string;
    className?: string;
}> = ({ backendId, className }) => {
    return <BackendIcon backendId={backendId} className={className} />;
};

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
    {
        key: 'tool_call',
        icon: RiToolsLine,
        label: 'Tool calling',
        isActive: (metadata) => metadata?.tool_call === true,
    },
    {
        key: 'reasoning',
        icon: RiBrainAi3Line,
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
    text: { icon: RiText, label: 'Text' },
    image: { icon: RiFileImageLine, label: 'Image' },
    video: { icon: RiFileVideoLine, label: 'Video' },
    audio: { icon: RiFileMusicLine, label: 'Audio' },
    pdf: { icon: RiFilePdfLine, label: 'PDF' },
};

const normalizeModality = (value: string) => value.trim().toLowerCase();

const getModalityIcons = (metadata: ModelMetadata | undefined, direction: 'input' | 'output'): ModalityIcon[] => {
    const modalityList = direction === 'input' ? metadata?.modalities?.input : metadata?.modalities?.output;
    if (!Array.isArray(modalityList) || modalityList.length === 0) {
        return [];
    }

    const uniqueValues = Array.from(new Set(modalityList.map((item) => normalizeModality(item))));

    return uniqueValues
        .map((modality) => {
            const definition = MODALITY_ICON_MAP[modality];
            if (!definition) {
                return null;
            }
            return {
                key: modality,
                icon: definition.icon,
                label: definition.label,
            } satisfies ModalityIcon;
        })
        .filter((entry): entry is ModalityIcon => Boolean(entry));
};

const COMPACT_NUMBER_FORMATTER = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    compactDisplay: 'short',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
});

const CURRENCY_FORMATTER = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 4,
    minimumFractionDigits: 2,
});

const ADD_PROVIDER_ID = '__add_provider__';

const formatTokens = (value?: number | null) => {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '—';
    }

    if (value === 0) {
        return '0';
    }

    const formatted = COMPACT_NUMBER_FORMATTER.format(value);
    return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const formatCost = (value?: number | null) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '—';
    }

    return CURRENCY_FORMATTER.format(value);
};

const formatCompactPrice = (metadata?: ModelMetadata): string | null => {
    if (!metadata?.cost) {
        return null;
    }

    const inputCost = metadata.cost.input;
    const outputCost = metadata.cost.output;
    const hasInput = typeof inputCost === 'number' && Number.isFinite(inputCost);
    const hasOutput = typeof outputCost === 'number' && Number.isFinite(outputCost);

    if (hasInput && hasOutput) {
        return `In ${formatCost(inputCost)} · Out ${formatCost(outputCost)}`;
    }
    if (hasInput) {
        return `In ${formatCost(inputCost)}`;
    }
    if (hasOutput) {
        return `Out ${formatCost(outputCost)}`;
    }
    return null;
};

const getCapabilityIcons = (metadata?: ModelMetadata) => {
    return CAPABILITY_DEFINITIONS.filter((definition) => definition.isActive(metadata)).map((definition) => ({
        key: definition.key,
        icon: definition.icon,
        label: definition.label,
    }));
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
            return new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(knowledgeDate);
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

    return new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
    }).format(parsedDate);
};

interface ModelControlsProps {
    className?: string;
    mobilePanel?: MobileControlsPanel;
    onMobilePanelChange?: (panel: MobileControlsPanel) => void;
    onMobilePanelSelection?: () => void;
    onAgentPanelSelection?: () => void;
}

export const ModelControls: React.FC<ModelControlsProps> = ({
    className,
    mobilePanel,
    onMobilePanelChange,
    onMobilePanelSelection,
    onAgentPanelSelection,
}) => {
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
    const setVirtualProviders = useConfigStore((state) => state.setVirtualProviders);
    const setCurrentVariant = useConfigStore((state) => state.setCurrentVariant);
    const getCurrentModelVariants = useConfigStore((state) => state.getCurrentModelVariants);
    const setAgent = useConfigStore((state) => state.setAgent);
    const setCurrentAgentName = useConfigStore((state) => state.setCurrentAgentName);
    const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
    const getCurrentAgent = useConfigStore((state) => state.getCurrentAgent);
    const getVisibleAgents = useConfigStore((state) => state.getVisibleAgents);

    // Use visible agents (excludes hidden internal agents)
    const agents = getVisibleAgents();
    const primaryAgents = React.useMemo(() => agents.filter((agent) => agent.mode === 'primary'), [agents]);

    const currentSessionId = useSessionUIStore((s) => s.currentSessionId);
    const getDirectoryForSession = useSessionUIStore((s) => s.getDirectoryForSession);
    const currentSessionDirectory = currentSessionId ? getDirectoryForSession(currentSessionId) : undefined;
    const sync = useSync();

    const getSessionModelSelection = useSelectionStore((state) => state.getSessionModelSelection);
    const saveSessionModelSelection = useSelectionStore((state) => state.saveSessionModelSelection);
    const saveSessionAgentSelection = useSelectionStore((state) => state.saveSessionAgentSelection);
    const saveAgentModelForSession = useSelectionStore((state) => state.saveAgentModelForSession);
    const getAgentModelForSession = useSelectionStore((state) => state.getAgentModelForSession);
    const saveAgentModelVariantForSession = useSelectionStore((state) => state.saveAgentModelVariantForSession);
    const getAgentModelVariantForSession = useSelectionStore((state) => state.getAgentModelVariantForSession);
    const saveSessionBackendSelection = useSelectionStore((state) => state.saveSessionBackendSelection);
    const draftBackendId = useSelectionStore((state) => state.draftBackendId);
    const lastUsedBackendId = useSelectionStore((state) => state.lastUsedBackendId);
    const setDraftBackendId = useSelectionStore((state) => state.setDraftBackendId);

    const contextHydrated = useContextStore((state) => state.hasHydrated);

    const sessionSavedAgentName = useSelectionStore((state) =>
        currentSessionId ? state.sessionAgentSelections.get(currentSessionId) ?? null : null
    );
    const sessionSavedBackendId = useSelectionStore((state) =>
        currentSessionId ? state.sessionBackendSelections.get(currentSessionId) ?? null : null
    );
    const currentSession = useSession(currentSessionId ?? undefined, currentSessionDirectory ?? undefined);

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
    const isFavoriteModel = useUIStore((state) => state.isFavoriteModel);
    const collapsedModelProviders = useUIStore((state) => state.collapsedModelProviders);
    const toggleModelProviderCollapsed = useUIStore((state) => state.toggleModelProviderCollapsed);
    const addRecentModel = useUIStore((state) => state.addRecentModel);
    const addRecentAgent = useUIStore((state) => state.addRecentAgent);
    const addRecentEffort = useUIStore((state) => state.addRecentEffort);
    const isModelSelectorOpen = useUIStore((state) => state.isModelSelectorOpen);
    const setModelSelectorOpen = useUIStore((state) => state.setModelSelectorOpen);
    const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
    const setSettingsPage = useUIStore((state) => state.setSettingsPage);
    const hiddenModels = useUIStore((state) => state.hiddenModels);
    const collapsedProviderSet = React.useMemo(
        () => new Set(collapsedModelProviders.map((providerId) => providerId.trim()).filter(Boolean)),
        [collapsedModelProviders]
    );

    // Separate state for agent selector to avoid conflict with model selector
    const [isAgentSelectorOpen, setIsAgentSelectorOpen] = React.useState(false);
    const [availableBackends, setAvailableBackends] = React.useState<BackendDescriptor[]>([]);
    const [backendControlSurface, setBackendControlSurface] = React.useState<BackendControlSurface | null>(null);
    const [defaultBackendId, setDefaultBackendId] = React.useState('');
    const { favoriteModelsList, recentModelsList } = useModelLists();

    const { isMobile } = useDeviceInfo();
    const isDesktop = React.useMemo(() => isDesktopShell(), []);
    const isVSCodeRuntime = useIsVSCodeRuntime();
    // Only use mobile panels on actual mobile devices, VSCode uses desktop dropdowns
    const isCompact = isMobile;
    const [localMobilePanel, setLocalMobilePanel] = React.useState<MobileControlsPanel>(null);
    const authoritativeSessionBackendId =
        (currentSession as { backendId?: string | null } | undefined)?.backendId
        ?? backendControlSurface?.backendId
        ?? null;
    const currentBackendId = currentSessionId
        ? (authoritativeSessionBackendId || sessionSavedBackendId || defaultBackendId || '')
        : (draftBackendId || lastUsedBackendId || defaultBackendId || '');
    const currentBackend = React.useMemo(
        () => availableBackends.find((backend) => backend.id === currentBackendId) || null,
        [availableBackends, currentBackendId],
    );
    const usingExternalMobilePanel = mobilePanel !== undefined && typeof onMobilePanelChange === 'function';
    const activeMobilePanel = usingExternalMobilePanel ? mobilePanel : localMobilePanel;
    const setActiveMobilePanel = usingExternalMobilePanel ? onMobilePanelChange : setLocalMobilePanel;
    const [mobileTooltipOpen, setMobileTooltipOpen] = React.useState<'model' | 'agent' | null>(null);
    const [mobileModelQuery, setMobileModelQuery] = React.useState('');
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
    const [desktopModelQuery, setDesktopModelQuery] = React.useState('');
    const [modelSelectedIndex, setModelSelectedIndex] = React.useState(0);
    const modelItemRefs = React.useRef<(HTMLDivElement | null)[]>([]);
    const [pendingThinkingVariants, setPendingThinkingVariants] = React.useState<Map<string, string | undefined>>(new Map());
    const [adjustedThinkingModels, setAdjustedThinkingModels] = React.useState<Set<string>>(new Set());

    React.useEffect(() => {
        let cancelled = false;

        void opencodeClient.getHarnessBackends()
            .then((payload: { defaultBackend: string; backends: BackendDescriptor[] }) => {
                if (cancelled) {
                    return;
                }
                setAvailableBackends(payload.backends);
                setDefaultBackendId(payload.defaultBackend || '');
                if (!currentSessionId && !draftBackendId && payload.defaultBackend) {
                    setDraftBackendId(payload.defaultBackend);
                }
            })
            .catch((error: unknown) => {
                console.warn('[ModelControls] Failed to load harness backends:', error);
            });

        return () => {
            cancelled = true;
        };
    }, [currentSessionId, draftBackendId, setDraftBackendId]);

    React.useEffect(() => {
        let cancelled = false;

        void opencodeClient.getHarnessControlSurface({
            ...(currentSessionId ? { sessionId: currentSessionId } : { backendId: currentBackendId }),
            ...(currentProviderId ? { providerId: currentProviderId } : {}),
            ...(currentModelId ? { modelId: currentModelId } : {}),
        })
            .then((payload) => {
                if (!cancelled) {
                    setBackendControlSurface(payload);
                }
            })
            .catch((error: unknown) => {
                if (!cancelled) {
                    console.warn('[ModelControls] Failed to load harness control surface:', error);
                    setBackendControlSurface(null);
                }
            });

        return () => {
            cancelled = true;
        };
    }, [currentBackendId, currentModelId, currentProviderId, currentSessionId, currentSessionDirectory]);

    React.useEffect(() => {
        if (!currentSessionId || !authoritativeSessionBackendId) {
            return;
        }
        if (sessionSavedBackendId === authoritativeSessionBackendId) {
            return;
        }
        saveSessionBackendSelection(currentSessionId, authoritativeSessionBackendId);
    }, [authoritativeSessionBackendId, currentSessionId, saveSessionBackendSelection, sessionSavedBackendId]);

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
        if (activeMobilePanel !== 'model') {
            setMobileModelQuery('');
        }
    }, [activeMobilePanel]);

    // Handle model selector close behavior (separate from agent selector)
    const prevModelSelectorOpenRef = React.useRef(isModelSelectorOpen);
    React.useEffect(() => {
        const wasOpen = prevModelSelectorOpenRef.current;
        prevModelSelectorOpenRef.current = isModelSelectorOpen;

        if (!isModelSelectorOpen) {
            setDesktopModelQuery('');
            setModelSelectedIndex(0);
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

    // Reset selected index when search query changes
    React.useEffect(() => {
        setModelSelectedIndex(0);
    }, [desktopModelQuery]);

    const selectableDesktopAgents = React.useMemo(() => {
        return agents.filter((agent) => agent.mode !== 'subagent');
    }, [agents]);

    const backendModeSelector = backendControlSurface?.modeSelector ?? null;
    const backendModelSelector = backendControlSurface?.modelSelector ?? null;
    const backendEffortSelector = backendControlSurface?.effortSelector ?? null;
    const primarySelectorKind = backendModeSelector?.kind ?? 'agent';
    const primarySelectorLabel = backendModeSelector?.label ?? 'Agent';
    const modelSelectorLabel = backendModelSelector?.label ?? 'Model';
    const effortSelectorLabel = backendEffortSelector?.label ?? 'Thinking';
    const backendModelProviderId = backendModelSelector?.providerId || currentBackendId || 'backend';
    const backendModeItems = React.useMemo<BackendControlSurfaceOption[]>(() => {
        if (backendModeSelector?.items?.length) {
            return backendModeSelector.items;
        }
        return selectableDesktopAgents.map((agent) => ({
            id: agent.name,
            label: agent.name.charAt(0).toUpperCase() + agent.name.slice(1),
            ...(agent.description ? { description: agent.description } : {}),
            ...(agent.color ? { color: agent.color } : {}),
        }));
    }, [backendModeSelector, selectableDesktopAgents]);
    const backendModelOptions = React.useMemo<ProviderModel[]>(() => {
        if (backendModelSelector?.source !== 'backend' || !backendModelSelector.options?.length) {
            return [];
        }

        const variants = backendEffortSelector?.options?.length
            ? Object.fromEntries(backendEffortSelector.options.map((option) => [option.id, {}]))
            : undefined;

        return backendModelSelector.options.map((option) => ({
            id: option.id,
            providerID: backendModelProviderId,
            api: {
                id: currentBackendId || 'backend',
                url: '',
                npm: '',
            },
            name: option.label,
            family: undefined,
            capabilities: {
                temperature: false,
                reasoning: Boolean(variants),
                attachment: true,
                toolcall: false,
                input: {
                    text: true,
                    audio: false,
                    image: true,
                    video: false,
                    pdf: true,
                },
                output: {
                    text: true,
                    audio: false,
                    image: false,
                    video: false,
                    pdf: false,
                },
                interleaved: false,
            },
            cost: {
                input: 0,
                output: 0,
                cache: {
                    read: 0,
                    write: 0,
                },
            },
            limit: {
                context: 0,
                output: 0,
            },
            status: 'active',
            options: {},
            headers: {},
            release_date: '',
            ...(variants ? { variants } : {}),
        }));
    }, [backendEffortSelector, backendModelProviderId, backendModelSelector, currentBackendId]);
    const usesBackendModelCatalog = backendModelSelector?.source === 'backend' && backendModelOptions.length > 0;
    const effectiveProviders = React.useMemo(() => {
        if (!usesBackendModelCatalog) {
            return providers;
        }

        return [{
            id: backendModelProviderId,
            name: currentBackend?.label || currentBackendId || 'Backend',
            models: backendModelOptions,
        }];
    }, [backendModelOptions, backendModelProviderId, currentBackend, currentBackendId, providers, usesBackendModelCatalog]);

    React.useEffect(() => {
        if (!usesBackendModelCatalog) {
            setVirtualProviders([]);
            return;
        }

        setVirtualProviders([
            {
                id: backendModelProviderId,
                name: currentBackend?.label || currentBackendId || 'Backend',
                source: 'api',
                env: [],
                options: {},
                models: backendModelOptions,
            },
        ]);
    }, [
        backendModelOptions,
        backendModelProviderId,
        currentBackend,
        currentBackendId,
        setVirtualProviders,
        usesBackendModelCatalog,
    ]);

    const sortedAndFilteredAgents = React.useMemo(() => {
        const sorted = [...backendModeItems].sort((a, b) => a.label.localeCompare(b.label));
        if (!agentSearchQuery.trim()) {
            return sorted;
        }
        return sorted.filter((agent) =>
            fuzzyMatch(agent.label, agentSearchQuery) ||
            (agent.description && fuzzyMatch(agent.description, agentSearchQuery))
        );
    }, [agentSearchQuery, backendModeItems]);

    const defaultAgentName = React.useMemo(() => {
        if (primarySelectorKind === 'agent' && settingsDefaultAgent) {
            const found = backendModeItems.find((item) => item.id === settingsDefaultAgent);
            if (found) return found.id;
        }
        const buildAgent = backendModeItems.find((item) => item.id === 'build');
        if (buildAgent) return buildAgent.id;
        return backendModeItems[0]?.id;
    }, [backendModeItems, primarySelectorKind, settingsDefaultAgent]);

    const currentAgent = React.useMemo(() => {
        if (uiAgentName) {
            return agents.find((agent) => agent.name === uiAgentName);
        }
        return getCurrentAgent?.();
    }, [agents, getCurrentAgent, uiAgentName]);

    const sizeVariant: 'mobile' | 'vscode' | 'default' = isMobile ? 'mobile' : isVSCodeRuntime ? 'vscode' : 'default';
    const buttonHeight = sizeVariant === 'mobile' ? 'h-9' : sizeVariant === 'vscode' ? 'h-6' : 'h-8';
    const editToggleIconClass = sizeVariant === 'mobile' ? 'h-5 w-5' : sizeVariant === 'vscode' ? 'h-4 w-4' : 'h-4 w-4';
    const controlIconSize = sizeVariant === 'mobile' ? 'h-5 w-5' : sizeVariant === 'vscode' ? 'h-4 w-4' : 'h-4 w-4';
    const controlTextSize = isCompact ? 'typography-micro' : 'typography-meta';
    const inlineGapClass = sizeVariant === 'mobile' ? 'gap-x-1' : sizeVariant === 'vscode' ? 'gap-x-2' : 'gap-x-3';
    const renderEditModeIcon = React.useCallback((mode: EditPermissionMode, iconClass = editToggleIconClass) => {
        const combinedClassName = cn(iconClass, 'flex-shrink-0');
        const modeColors = getEditModeColors(mode);
        const iconColor = modeColors ? modeColors.text : 'var(--foreground)';
        const iconStyle = { color: iconColor };

        if (mode === 'full') {
            return <RiPencilAiLine className={combinedClassName} style={iconStyle} />;
        }
        if (mode === 'allow') {
            return <RiCheckboxCircleLine className={combinedClassName} style={iconStyle} />;
        }
        if (mode === 'deny') {
            return <RiCloseCircleLine className={combinedClassName} style={iconStyle} />;
        }
        return <RiQuestionLine className={combinedClassName} style={iconStyle} />;
    }, [editToggleIconClass]);

    const currentProvider = React.useMemo(() => {
        if (!currentProviderId) {
            return null;
        }
        return effectiveProviders.find((provider) => String(provider.id) === currentProviderId) || null;
    }, [currentProviderId, effectiveProviders]);
    const models = Array.isArray(currentProvider?.models) ? currentProvider.models : [];

    const visibleProviders = React.useMemo(() => {
        return effectiveProviders
            .map((provider) => {
                const providerModels = Array.isArray(provider.models) ? provider.models : [];
                const visibleModels = providerModels.filter((model: ProviderModel) => {
                    const modelId = typeof model?.id === 'string' ? model.id : '';
                    return !hiddenModels.some(
                        (item) => item.providerID === String(provider.id) && item.modelID === modelId
                    );
                });
                return { ...provider, models: visibleModels };
            })
            .filter((provider) => provider.models.length > 0);
    }, [effectiveProviders, hiddenModels]);

    const currentMetadata =
        currentProviderId && currentModelId ? getModelMetadata(currentProviderId, currentModelId) : undefined;
    const currentCapabilityIcons = getCapabilityIcons(currentMetadata);
    const inputModalityIcons = getModalityIcons(currentMetadata, 'input');
    const outputModalityIcons = getModalityIcons(currentMetadata, 'output');

    // Compute from current model each render to avoid stale variants
    // in draft/session transitions.
    const availableVariants = backendEffortSelector?.options?.length
        ? backendEffortSelector.options.map((option) => option.id)
        : getCurrentModelVariants();
    const hasVariants = availableVariants.length > 0;

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

    const hasCurrentSessionMessagesEntry = useDirectorySync(
        React.useCallback(
            (state) => (currentSessionId ? state.message[currentSessionId] !== undefined : false),
            [currentSessionId],
        ),
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

            const provider = effectiveProviders.find(p => p.id === providerId);
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
        [effectiveProviders, currentProviderId, currentModelId, setProvider, setModel, currentSessionId, saveAgentModelForSession, saveSessionModelSelection],
    );

    React.useEffect(() => {
        if (!currentSessionId) {
            latestLoadedUserChoiceRestoreRef.current = null;
            return;
        }

        if (!contextHydrated || effectiveProviders.length === 0 || !hasCurrentSessionMessagesEntry || !latestLoadedUserChoice?.providerID || !latestLoadedUserChoice.modelID) {
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

        const applyResult = tryApplyModelSelection(
            latestLoadedUserChoice.providerID,
            latestLoadedUserChoice.modelID,
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
                latestLoadedUserChoice.variant,
            );
        }
        saveSessionModelSelection(currentSessionId, latestLoadedUserChoice.providerID, latestLoadedUserChoice.modelID);
        latestLoadedUserChoiceRestoreRef.current = restoreKey;

    }, [
        currentSessionId,
        currentAgentName,
        contextHydrated,
        effectiveProviders,
        hasCurrentSessionMessagesEntry,
        latestLoadedUserChoice,
        setAgent,
        tryApplyModelSelection,
        saveSessionAgentSelection,
        saveAgentModelVariantForSession,
        saveSessionModelSelection,
    ]);

    React.useEffect(() => {
        if (!currentSessionId) {
            latestLoadedUserChoiceRestoreRef.current = null;
            return;
        }

        if (!contextHydrated || effectiveProviders.length === 0 || agents.length === 0) {
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

        if (!hasCurrentSessionMessagesEntry) {
            if (!sync.isLoading(currentSessionId)) {
                void sync.syncSession(currentSessionId);
            }
            return;
        }

        if (latestLoadedUserChoice) {
            return;
        }

        applyFallbackAgent();
    }, [
        currentSessionId,
        hasCurrentSessionMessagesEntry,
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
        effectiveProviders,
        sync,
    ]);

    React.useEffect(() => {
        if (backendModelSelector?.source !== 'backend' || backendModelOptions.length === 0) {
            return;
        }

        const desiredProviderId = backendModelProviderId;
        const desiredModelId = backendModelOptions.some((model) => model.id === currentModelId)
            ? currentModelId
            : (backendModelSelector.defaultOptionId || String(backendModelOptions[0]?.id || ''));

        if (currentProviderId !== desiredProviderId) {
            setProvider(desiredProviderId);
        }

        if (desiredModelId && currentModelId !== desiredModelId) {
            setModel(desiredModelId);
        }
    }, [
        backendModelOptions,
        backendModelProviderId,
        backendModelSelector,
        currentModelId,
        currentProviderId,
        setModel,
        setProvider,
    ]);

    React.useEffect(() => {
        if (primarySelectorKind !== 'mode' || backendModeItems.length === 0) {
            return;
        }

        const desiredModeId = backendModeItems.some((item) => item.id === uiAgentName)
            ? uiAgentName
            : defaultAgentName;

        if (!desiredModeId || currentAgentName === desiredModeId) {
            return;
        }

        setCurrentAgentName(desiredModeId);
    }, [
        backendModeItems,
        currentAgentName,
        defaultAgentName,
        primarySelectorKind,
        setCurrentAgentName,
        uiAgentName,
    ]);

    React.useEffect(() => {
        if (!contextHydrated) {
            return;
        }

        const handleAgentSwitch = async () => {
            try {
                if (currentAgentName !== prevAgentNameRef.current) {
                    prevAgentNameRef.current = currentAgentName;

                    if (currentAgentName && currentSessionId) {
                        await new Promise(resolve => setTimeout(resolve, 50));

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

                        const agent = agents.find(a => a.name === currentAgentName);
                        if (agent?.model?.providerID && agent?.model?.modelID) {
                            const result = tryApplyModelSelection(
                                agent.model.providerID,
                                agent.model.modelID,
                                currentAgentName,
                            );
                            if (result === 'provider-missing') {
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
    }, [currentAgentName, currentSessionId, getAgentModelForSession, tryApplyModelSelection, agents, contextHydrated]);

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
        manualVariantSelectionRef.current = true;
        setCurrentVariant(variant);

        if (currentProviderId && currentModelId) {
            addRecentEffort(currentProviderId, currentModelId, variant);
        }

        if (currentSessionId && currentAgentName && currentProviderId && currentModelId) {
            saveAgentModelVariantForSession(
                currentSessionId,
                currentAgentName,
                currentProviderId,
                currentModelId,
                variant,
            );
        }
    }, [
        addRecentEffort,
        currentAgentName,
        currentModelId,
        currentProviderId,
        currentSessionId,
        saveAgentModelVariantForSession,
        setCurrentVariant,
    ]);

    const handleAgentChange = React.useCallback((agentName: string) => {
        try {
            setAgent(agentName);
            addRecentAgent(agentName);
            setAgentMenuOpen(false);

            if (currentSessionId) {
                saveSessionAgentSelection(currentSessionId, agentName);
            }
            if (isCompact) {
                closeMobilePanel();
                const callback = onAgentPanelSelection || onMobilePanelSelection;
                if (callback) {
                    requestAnimationFrame(() => {
                        callback();
                    });
                }
            }
        } catch (error) {
            console.error('[ModelControls] Handle agent change error:', error);
        }
    }, [
        addRecentAgent,
        closeMobilePanel,
        currentSessionId,
        isCompact,
        onAgentPanelSelection,
        onMobilePanelSelection,
        saveSessionAgentSelection,
        setAgent,
        setAgentMenuOpen,
    ]);

    const handlePrimarySelectorChange = React.useCallback((itemId: string) => {
        if (primarySelectorKind === 'mode') {
            setCurrentAgentName(itemId);
            addRecentAgent(itemId);
            setAgentMenuOpen(false);

            if (currentSessionId) {
                saveSessionAgentSelection(currentSessionId, itemId);
            }
            if (isCompact) {
                closeMobilePanel();
                const callback = onAgentPanelSelection || onMobilePanelSelection;
                if (callback) {
                    requestAnimationFrame(() => {
                        callback();
                    });
                }
            }
            return;
        }
        handleAgentChange(itemId);
    }, [
        addRecentAgent,
        closeMobilePanel,
        currentSessionId,
        handleAgentChange,
        isCompact,
        onAgentPanelSelection,
        onMobilePanelSelection,
        primarySelectorKind,
        saveSessionAgentSelection,
        setAgentMenuOpen,
        setCurrentAgentName,
    ]);

    const handleBackendChange = React.useCallback((backendId: string) => {
        const descriptor = availableBackends.find((backend) => backend.id === backendId);
        if (!descriptor || !descriptor.available) {
            return;
        }

        if (currentSessionId) {
            saveSessionBackendSelection(currentSessionId, backendId);
        } else {
            setDraftBackendId(backendId);
        }

        if (isCompact) {
            closeMobilePanel();
        }
    }, [
        availableBackends,
        closeMobilePanel,
        currentSessionId,
        isCompact,
        saveSessionBackendSelection,
        setDraftBackendId,
    ]);

    const handleProviderAndModelChange = (providerId: string, modelId: string) => {
        try {
            const result = tryApplyModelSelection(providerId, modelId, currentAgentName || undefined);
            if (result !== 'applied') {
                if (result === 'provider-missing') {
                    console.error('[ModelControls] Provider not available for selection:', providerId);
                } else if (result === 'model-missing') {
                    console.error('[ModelControls] Model not available for selection:', { providerId, modelId });
                }
                return;
            }
            // Add to recent models on successful selection
            addRecentModel(providerId, modelId);
            setAgentMenuOpen(false);
            if (isCompact) {
                closeMobilePanel();
                if (onMobilePanelSelection) {
                    requestAnimationFrame(() => {
                        onMobilePanelSelection();
                    });
                }
            }
            if (!isCompact || !onMobilePanelSelection) {
                // Restore focus to chat input after model selection
                requestAnimationFrame(() => {
                    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
                    textarea?.focus();
                });
            }
        } catch (error) {
            console.error('[ModelControls] Handle model change error:', error);
        }
    };

    const getModelDisplayName = (model: ProviderModel | undefined) => {
        const name = (typeof model?.name === 'string' ? model.name : (typeof model?.id === 'string' ? model.id : ''));
        if (name.length > 40) {
            return name.substring(0, 37) + '...';
        }
        return name;
    };

    const getProviderDisplayName = () => {
        const provider = effectiveProviders.find(p => p.id === currentProviderId);
        return provider?.name || currentProviderId;
    };

    const getCurrentModelDisplayName = () => {
        if (!currentProviderId || !currentModelId) return 'Not selected';
        if (models.length === 0) return 'Not selected';
        const currentModel = models.find((m: ProviderModel) => m.id === currentModelId);
        return getModelDisplayName(currentModel);
    };

    const currentModelDisplayName = getCurrentModelDisplayName();
    const modelLabelRef = React.useRef<HTMLSpanElement>(null);
    const isModelLabelTruncated = useIsTextTruncated(modelLabelRef, [currentModelDisplayName, isCompact]);

    const getAgentDisplayName = () => {
        const selectedMode = uiAgentName
            ? backendModeItems.find((item) => item.id === uiAgentName)
            : null;
        if (selectedMode) {
            return selectedMode.label;
        }
        if (!uiAgentName) {
            const buildAgent = backendModeItems.find((item) => item.id === 'build');
            const defaultAgent = buildAgent || backendModeItems[0];
            return defaultAgent ? defaultAgent.label : `Select ${primarySelectorLabel}`;
        }
        const agent = agents.find(a => a.name === uiAgentName);
        return agent ? capitalizeAgentName(agent.name) : capitalizeAgentName(uiAgentName);
    };

    const capitalizeAgentName = (name: string) => {
        return name.charAt(0).toUpperCase() + name.slice(1);
    };

    const renderIconBadge = (IconComp: IconComponent, label: string, key: string) => (
        <span
            key={key}
            className="flex h-5 w-5 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground"
            title={label}
            aria-label={label}
            role="img"
        >
            <IconComp className="h-3.5 w-3.5" />
        </span>
    );

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
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-0.5">Provider</div>
                        <div className="typography-meta text-foreground font-medium">{getProviderDisplayName()}</div>
                    </div>

                    {}
                    {currentCapabilityIcons.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-micro text-muted-foreground mb-1">Capabilities</div>
                            <div className="flex flex-wrap gap-1.5">
                                {currentCapabilityIcons.map(({ key, icon, label }) => (
                                    <div key={key} className="flex items-center gap-1.5">
                                        {renderIconBadge(icon, label, `cap-${key}`)}
                                        <span className="typography-meta text-foreground">{label}</span>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}

                    {}
                    {(inputModalityIcons.length > 0 || outputModalityIcons.length > 0) && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-micro text-muted-foreground mb-1">Modalities</div>
                            <div className="flex flex-col gap-1">
                                {inputModalityIcons.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="typography-meta text-muted-foreground/80 w-12">Input</span>
                                        <div className="flex gap-1">
                                            {inputModalityIcons.map(({ key, icon, label }) => renderIconBadge(icon, `${label} input`, `input-${key}`))}
                                        </div>
                                    </div>
                                )}
                                {outputModalityIcons.length > 0 && (
                                    <div className="flex items-center gap-2">
                                        <span className="typography-meta text-muted-foreground/80 w-12">Output</span>
                                        <div className="flex gap-1">
                                            {outputModalityIcons.map(({ key, icon, label }) => renderIconBadge(icon, `${label} output`, `output-${key}`))}
                                        </div>
                                    </div>
                                )}
                            </div>
                        </div>
                    )}

                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-1">Limits</div>
                        <div className="flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">Context</span>
                                <span className="typography-meta font-medium text-foreground">{formatTokens(currentMetadata?.limit?.context)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">Output</span>
                                <span className="typography-meta font-medium text-foreground">{formatTokens(currentMetadata?.limit?.output)}</span>
                            </div>
                        </div>
                    </div>

                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-1">Metadata</div>
                        <div className="flex flex-col gap-0.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">Knowledge</span>
                                <span className="typography-meta font-medium text-foreground">{formatKnowledge(currentMetadata?.knowledge)}</span>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">Release</span>
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

        const hasCustomPrompt = Boolean(currentAgent.prompt && currentAgent.prompt.trim().length > 0);
        const hasModelConfig = currentAgent.model?.providerID && currentAgent.model?.modelID;
        const hasTemperatureOrTopP = currentAgent.temperature !== undefined || currentAgent.topP !== undefined;

        const summarizePermission = (permissionName: string): { mode: EditPermissionMode; label: string } => {
            const rules = asPermissionRuleset(currentAgent.permission) ?? [];
            const hasCustom = rules.some((rule) => rule.permission === permissionName && rule.pattern !== '*');
            const action = resolveWildcardPermissionAction(rules, permissionName) ?? 'ask';

            if (hasCustom) {
                return { mode: 'ask', label: 'Custom' };
            }

            if (action === 'allow') return { mode: 'allow', label: 'Allow' };
            if (action === 'deny') return { mode: 'deny', label: 'Deny' };
            return { mode: 'ask', label: 'Ask' };
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
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-meta text-foreground">{currentAgent.description}</div>
                        </div>
                    )}

                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-0.5">Mode</div>
                        <div className="typography-meta text-foreground font-medium">
                            {currentAgent.mode === 'primary' ? 'Primary' : currentAgent.mode === 'subagent' ? 'Subagent' : currentAgent.mode === 'all' ? 'All' : '—'}
                        </div>
                    </div>

                    {}
                    {(hasModelConfig || hasTemperatureOrTopP) && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="typography-micro text-muted-foreground mb-1">Model</div>
                            {hasModelConfig && (
                                <div className="typography-meta text-foreground font-medium mb-1">
                                    {currentAgent.model!.providerID} / {currentAgent.model!.modelID}
                                </div>
                            )}
                            {hasTemperatureOrTopP && (
                                <div className="flex flex-col gap-0.5">
                                    {currentAgent.temperature !== undefined && (
                                        <div className="flex items-center justify-between">
                                            <span className="typography-meta text-muted-foreground/80">Temperature</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.temperature}</span>
                                        </div>
                                    )}
                                    {currentAgent.topP !== undefined && (
                                        <div className="flex items-center justify-between">
                                            <span className="typography-meta text-muted-foreground/80">Top P</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.topP}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}


                    {}
                    <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                        <div className="typography-micro text-muted-foreground mb-1">Permissions</div>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">Edit</span>
                                <div className="flex items-center gap-1.5">
                                    {renderEditModeIcon(editPermissionSummary.mode, 'h-3.5 w-3.5')}
                                    <span className="typography-meta font-medium text-foreground">
                                        {editPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">Bash</span>
                                <div className="flex items-center gap-1.5">
                                    {renderEditModeIcon(bashPermissionSummary.mode, 'h-3.5 w-3.5')}
                                    <span className="typography-meta font-medium text-foreground">
                                        {bashPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">WebFetch</span>
                                <div className="flex items-center gap-1.5">
                                    {renderEditModeIcon(webfetchPermissionSummary.mode, 'h-3.5 w-3.5')}
                                    <span className="typography-meta font-medium text-foreground">
                                        {webfetchPermissionSummary.label}
                                    </span>
                                </div>
                            </div>
                        </div>
                    </div>

                    {}
                    {hasCustomPrompt && (
                        <div className="rounded-xl border border-border/40 bg-sidebar/30 px-2 py-1.5">
                            <div className="flex items-center justify-between">
                                <span className="typography-meta text-muted-foreground/80">Custom Prompt</span>
                                <RiCheckboxCircleLine className="h-4 w-4 text-foreground" />
                            </div>
                        </div>
                    )}
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderBackendSelector = () => {
        const backends = availableBackends.length > 0 ? availableBackends : [{
            id: defaultBackendId || 'default',
            label: defaultBackendId ? (defaultBackendId.charAt(0).toUpperCase() + defaultBackendId.slice(1)) : 'Backend',
            available: true,
            capabilities: {
                chat: true,
                sessions: true,
                models: true,
                agents: true,
                providers: true,
                commands: true,
                config: true,
                skills: true,
            },
        } satisfies BackendDescriptor];

        const displayLabel = currentBackend?.label || currentBackendId || 'Backend';
        const isLockedToSession = Boolean(currentSessionId);

        if (isLockedToSession) {
            return (
                <div
                    className={cn(
                        'model-controls__backend-trigger flex items-center gap-1.5 min-w-0',
                        buttonHeight,
                        'cursor-default opacity-70',
                    )}
                    aria-label={`Backend: ${displayLabel}`}
                    title={`Backend: ${displayLabel}`}
                >
                    <RiArrowGoBackLine className={cn(controlIconSize, 'flex-shrink-0 text-muted-foreground')} />
                    <span
                        className={cn(
                            'model-controls__backend-label',
                            controlTextSize,
                            'font-medium min-w-0 truncate text-foreground',
                            isDesktop ? 'max-w-[140px]' : undefined,
                        )}
                    >
                        {displayLabel}
                    </span>
                </div>
            );
        }

        return (
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        className={cn(
                            'model-controls__backend-trigger flex items-center gap-1.5 transition-colors min-w-0 focus:outline-none',
                            buttonHeight,
                            'cursor-pointer hover:bg-transparent hover:opacity-70',
                        )}
                    >
                        <RiArrowGoBackLine className={cn(controlIconSize, 'flex-shrink-0 text-muted-foreground')} />
                        <span
                            className={cn(
                                'model-controls__backend-label',
                                controlTextSize,
                                'font-medium min-w-0 truncate text-foreground',
                                isDesktop ? 'max-w-[140px]' : undefined,
                            )}
                        >
                            {displayLabel}
                        </span>
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" alignOffset={-40} className="w-[min(220px,calc(100vw-2rem))]">
                    <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">Backend</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {backends.map((backend) => {
                        const isSelected = backend.id === currentBackendId;
                        const isDisabled = !backend.available;
                        return (
                            <DropdownMenuItem
                                key={backend.id}
                                disabled={isDisabled}
                                onSelect={() => handleBackendChange(backend.id)}
                                className="typography-meta"
                            >
                                <div className="flex w-full items-center justify-between gap-2 min-w-0">
                                    <div className="flex min-w-0 items-center gap-2.5">
                                        <BackendMenuLogo
                                            backendId={backend.id}
                                            className={cn('h-4.5 w-4.5 flex-shrink-0', isDisabled && 'opacity-80')}
                                        />
                                        <span className="truncate font-medium text-foreground">{backend.label}</span>
                                    </div>
                                    <div className="flex flex-shrink-0 items-center gap-1.5">
                                        {backend.comingSoon && (
                                            <span className="inline-flex items-center rounded-full border border-border/60 bg-muted/35 px-1.5 py-[1px] text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                                                Coming soon
                                            </span>
                                        )}
                                        {isSelected && <RiCheckLine className="h-4 w-4 text-primary flex-shrink-0" />}
                                    </div>
                                </div>
                            </DropdownMenuItem>
                        );
                    })}
                </DropdownMenuContent>
            </DropdownMenu>
        );
    };

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

    const renderMobileModelPanel = () => {
        if (!isCompact) return null;

        const normalizedQuery = mobileModelQuery.trim();
        const visibleProviderIds = new Set(visibleProviders.map((provider) => String(provider.id)));
        const mobileFavorites = usesBackendModelCatalog
            ? favoriteModelsList.filter(({ providerID }) => visibleProviderIds.has(providerID))
            : favoriteModelsList;
        const mobileRecents = usesBackendModelCatalog
            ? recentModelsList.filter(({ providerID }) => visibleProviderIds.has(providerID))
            : recentModelsList;
        const filteredProviders = visibleProviders
            .map((provider) => {
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
                return { provider, providerModels: matchingModels, matchesProvider };
            })
            .filter(({ matchesProvider, providerModels }) => matchesProvider || providerModels.length > 0);

        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'model'}
                onClose={closeMobilePanel}
                title={`Select ${modelSelectorLabel.toLowerCase()}`}
            >
                <div className="flex flex-col gap-2">
                    <div>
                        <div className="relative">
                            <RiSearchLine className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                            <Input
                                value={mobileModelQuery}
                                onChange={(event) => setMobileModelQuery(event.target.value)}
                                placeholder="Search providers or models"
                                className="pl-7 h-9 rounded-xl border-border/40 bg-[var(--surface-elevated)] typography-meta"
                            />
                            {mobileModelQuery && (
                                <button
                                    type="button"
                                    onClick={() => setMobileModelQuery('')}
                                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                                    aria-label="Clear search"
                                >
                                    <RiCloseCircleLine className="h-4 w-4" />
                                </button>
                            )}
                        </div>
                    </div>

                    {filteredProviders.length === 0 && (
                        <div className="px-3 py-8 text-center typography-meta text-muted-foreground">
                            No providers or models match your search.
                        </div>
                    )}

                    {/* Favorites Section for Mobile */}
                    {!mobileModelQuery && mobileFavorites.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                <RiStarFill className="h-3 w-3 inline-block mr-1.5 text-primary" />
                                Favorites
                            </div>
                            <div className="flex flex-col border-t border-border/30">
                                {mobileFavorites.map(({ model, providerID, modelID }) => {
                                    const isSelected = providerID === currentProviderId && modelID === currentModelId;
                                    const metadata = getModelMetadata(providerID, modelID);

                                    return (
                                        <button
                                            key={`fav-mobile-${providerID}-${modelID}`}
                                            type="button"
                                            onClick={() => handleProviderAndModelChange(providerID, modelID)}
                                            className={cn(
                                                'flex w-full items-start gap-2 border-b border-border/30 px-2 py-1.5 text-left last:border-b-0',
                                                'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                                                'first:rounded-t-xl last:rounded-b-xl transition-colors',
                                                 isSelected ? 'bg-interactive-selection/15 text-interactive-selection-foreground' : 'hover:bg-interactive-hover'
                                            )}
                                        >
                                            <div className="flex items-center gap-2 min-w-0">
                                                <ProviderLogo providerId={providerID} className="h-3.5 w-3.5 flex-shrink-0" />
                                                <span className="typography-meta font-medium text-foreground truncate">
                                                    {getModelDisplayName(model)}
                                                </span>
                                            </div>
                                            <div className="ml-auto flex items-center gap-2">
                                                {(metadata?.limit?.context || metadata?.limit?.output) && (
                                                    <div className="typography-micro text-muted-foreground whitespace-nowrap">
                                                        {metadata?.limit?.context ? `${formatTokens(metadata?.limit?.context)} ctx` : ''}
                                                        {metadata?.limit?.context && metadata?.limit?.output ? ' • ' : ''}
                                                        {metadata?.limit?.output ? `${formatTokens(metadata?.limit?.output)} out` : ''}
                                                    </div>
                                                )}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Recent Section for Mobile */}
                    {!mobileModelQuery && mobileRecents.length > 0 && (
                        <div className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
                            <div className="px-2 py-1.5 text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                                <RiTimeLine className="h-3 w-3 inline-block mr-1.5" />
                                Recent
                            </div>
                            <div className="flex flex-col border-t border-border/30">
                                {mobileRecents.map(({ model, providerID, modelID }) => {
                                    const isSelected = providerID === currentProviderId && modelID === currentModelId;
                                    const metadata = getModelMetadata(providerID, modelID);

                                    return (
                                        <button
                                            key={`recent-mobile-${providerID}-${modelID}`}
                                            type="button"
                                            onClick={() => handleProviderAndModelChange(providerID, modelID)}
                                            className={cn(
                                                'flex w-full items-start gap-2 border-b border-border/30 px-2 py-1.5 text-left last:border-b-0',
                                                'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary',
                                                'first:rounded-t-xl last:rounded-b-xl transition-colors',
                                                 isSelected ? 'bg-interactive-selection/15 text-interactive-selection-foreground' : 'hover:bg-interactive-hover'
                                            )}
                                        >
                                            <div className="flex items-center gap-2 min-w-0">
                                                <ProviderLogo providerId={providerID} className="h-3.5 w-3.5 flex-shrink-0" />
                                                <span className="typography-meta font-medium text-foreground truncate">
                                                    {getModelDisplayName(model)}
                                                </span>
                                            </div>
                                            <div className="ml-auto flex items-center gap-2">
                                                {(metadata?.limit?.context || metadata?.limit?.output) && (
                                                    <div className="typography-micro text-muted-foreground whitespace-nowrap">
                                                        {metadata?.limit?.context ? `${formatTokens(metadata?.limit?.context)} ctx` : ''}
                                                        {metadata?.limit?.context && metadata?.limit?.output ? ' • ' : ''}
                                                        {metadata?.limit?.output ? `${formatTokens(metadata?.limit?.output)} out` : ''}
                                                    </div>
                                                )}
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {filteredProviders.map(({ provider, providerModels }) => {
                        if (providerModels.length === 0 && !normalizedQuery.length) {
                            return null;
                        }

                        const isActiveProvider = provider.id === currentProviderId;
                        const isExpanded = expandedMobileProviders.has(provider.id) || normalizedQuery.length > 0;

                         return (
                             <div key={provider.id} className="rounded-xl border border-border/40 bg-[var(--surface-elevated)] overflow-hidden">
                                <button
                                    type="button"
                                    onClick={() => toggleMobileProviderExpansion(provider.id)}
                                    className="flex w-full items-center justify-between gap-1.5 px-2 py-1.5 text-left"
                                    aria-expanded={isExpanded}
                                >
                                    <div className="flex items-center gap-2">
                                        <ProviderLogo
                                            providerId={provider.id}
                                            className="h-3.5 w-3.5"
                                        />
                                        <span className="typography-meta font-medium text-foreground">
                                            {provider.name}
                                        </span>
                                        {isActiveProvider && (
                                            <span className="typography-micro text-primary/80">Current</span>
                                        )}
                                    </div>
                                    {isExpanded ? (
                                        <RiArrowDownSLine className="h-3 w-3 text-muted-foreground" />
                                    ) : (
                                        <RiArrowRightSLine className="h-3 w-3 text-muted-foreground" />
                                    )}
                                </button>

                                {isExpanded && providerModels.length > 0 && (
                                    <div className="flex flex-col border-t border-border/30">
                                        {providerModels.map((model: ProviderModel) => {
                                            const isSelected = isActiveProvider && model.id === currentModelId;
                                            const metadata = getModelMetadata(provider.id, model.id!);
                                            const capabilityIcons = getCapabilityIcons(metadata).slice(0, 3);
                                            const inputIcons = getModalityIcons(metadata, 'input');

                                            return (
                                                <div
                                                    key={model.id}
                                                    className={cn(
                                                        'flex w-full items-start gap-2 border-b border-border/30 px-2 py-1.5 last:border-b-0',
                                                        'rounded-lg transition-colors',
                                                        !isSelected && 'hover:bg-interactive-hover',
                                                        isSelected
                                                            ? 'bg-interactive-selection/15 text-interactive-selection-foreground'
                                                            : ''
                                                    )}
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={() => handleProviderAndModelChange(provider.id as string, model.id as string)}
                                                        className={cn(
                                                            'flex flex-1 min-w-0 items-start gap-2 text-left',
                                                            'focus:outline-none focus-visible:ring-1 focus-visible:ring-primary'
                                                        )}
                                                    >
                                                        <div className="flex min-w-0 flex-col">
                                                            <span className="typography-meta font-medium text-foreground">
                                                                {getModelDisplayName(model)}
                                                            </span>
                                                        </div>
                                                        <div className="ml-auto flex flex-col items-end gap-1 text-right">
                                                            {(metadata?.limit?.context || metadata?.limit?.output) && (
                                                                <div className="flex items-center gap-1 typography-micro text-muted-foreground">
                                                                    {metadata?.limit?.context ? <span>{formatTokens(metadata?.limit?.context)} ctx</span> : null}
                                                                    {metadata?.limit?.context && metadata?.limit?.output ? <span>•</span> : null}
                                                                    {metadata?.limit?.output ? <span>{formatTokens(metadata?.limit?.output)} out</span> : null}
                                                                </div>
                                                            )}
                                                            {(capabilityIcons.length > 0 || inputIcons.length > 0) && (
                                                                <div className="flex items-center justify-end gap-1">
                                                                    {[...capabilityIcons, ...inputIcons].map(({ key, icon: IconComponent, label }) => (
                                                                        <span
                                                                            key={`meta-${provider.id}-${model.id}-${key}`}
                                                                            className="flex h-4 w-4 items-center justify-center text-muted-foreground"
                                                                            title={label}
                                                                            aria-label={label}
                                                                        >
                                                                            <IconComponent className="h-3 w-3" />
                                                                        </span>
                                                                    ))}
                                                                </div>
                                                            )}
                                                        </div>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={(e) => {
                                                            e.preventDefault();
                                                            e.stopPropagation();
                                                            toggleFavoriteModel(provider.id as string, model.id as string);
                                                        }}
                                                        className={cn(
                                                            "model-favorite-button flex h-5 w-5 items-center justify-center hover:text-primary/80 flex-shrink-0",
                                                            isFavoriteModel(provider.id as string, model.id as string)
                                                                ? "text-primary"
                                                                : "text-muted-foreground"
                                                        )}
                                                        aria-label={isFavoriteModel(provider.id as string, model.id as string) ? "Unfavorite" : "Favorite"}
                                                        title={isFavoriteModel(provider.id as string, model.id as string) ? "Remove from favorites" : "Add to favorites"}
                                                    >
                                                        {isFavoriteModel(provider.id as string, model.id as string) ? (
                                                            <RiStarFill className="h-4 w-4" />
                                                        ) : (
                                                            <RiStarLine className="h-4 w-4" />
                                                        )}
                                                    </button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderMobileVariantPanel = () => {
        if (!isCompact || !hasVariants) return null;

        const isDefault = !currentVariant;

        const handleSelect = (variant: string | undefined) => {
            handleVariantSelect(variant);
            closeMobilePanel();
            if (onMobilePanelSelection) {
                requestAnimationFrame(() => {
                    onMobilePanelSelection();
                });
                return;
            }
            requestAnimationFrame(() => {
                const textarea = document.querySelector<HTMLTextAreaElement>('textarea[data-chat-input="true"]');
                textarea?.focus();
            });
        };

        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'variant'}
                onClose={closeMobilePanel}
                title={effortSelectorLabel}
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
                        <span className="typography-meta font-medium text-foreground">Default</span>
                        {isDefault && <RiCheckLine className="h-4 w-4 text-primary flex-shrink-0" />}
                    </button>

                    {availableVariants.map((variant) => {
                        const selected = currentVariant === variant;
                        const label = variant.charAt(0).toUpperCase() + variant.slice(1);

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
                                {selected && <RiCheckLine className="h-4 w-4 text-primary flex-shrink-0" />}
                            </button>
                        );
                    })}
                </div>
            </MobileOverlayPanel>
        );
    };

    const renderMobileAgentPanel = () => {
        if (!isCompact) return null;
 
        return (
            <MobileOverlayPanel
                open={activeMobilePanel === 'agent'}
                onClose={closeMobilePanel}
                title={`Select ${primarySelectorLabel.toLowerCase()}`}
                contentMaxHeightClassName="max-h-[min(52dvh,360px)]"
            >
                <div className="flex flex-col gap-2">
                    {backendModeItems.map((agent) => {
                        const isSelected = agent.id === uiAgentName;
                        const agentColor = primarySelectorKind === 'agent' ? getAgentColor(agent.id) : null;
                        return (
                            <button
                                key={agent.id}
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
                                onClick={() => handlePrimarySelectorChange(agent.id)}
                            >
                                <div className="flex items-center gap-2">
                                    {agentColor ? <div className={cn('h-2.5 w-2.5 rounded-full flex-shrink-0', agentColor.class)} /> : null}
                                    <span
                                        className="typography-ui-label font-semibold"
                                        style={isSelected && agentColor ? { color: `var(${agentColor.var})` } : undefined}
                                    >
                                        {agent.label}
                                    </span>
                                    {isSelected && (
                                        <RiCheckLine className="h-4 w-4 text-primary ml-auto flex-shrink-0" />
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
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">Capabilities</span>
                        <div className="flex flex-wrap items-center gap-1.5">
                            {currentCapabilityIcons.length > 0 ? (
                                currentCapabilityIcons.map(({ key, icon, label }) =>
                                    renderIconBadge(icon, label, `cap-${key}`)
                                )
                            ) : (
                                <span className="typography-meta text-muted-foreground">—</span>
                            )}
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">Modalities</span>
                        <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">Input</span>
                                <div className="flex items-center gap-1.5">
                                    {inputModalityIcons.length > 0
                                        ? inputModalityIcons.map(({ key, icon, label }) =>
                                              renderIconBadge(icon, `${label} input`, `input-${key}`)
                                          )
                                        : <span className="typography-meta text-muted-foreground">—</span>}
                                </div>
                            </div>
                            <div className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">Output</span>
                                <div className="flex items-center gap-1.5">
                                    {outputModalityIcons.length > 0
                                        ? outputModalityIcons.map(({ key, icon, label }) =>
                                              renderIconBadge(icon, `${label} output`, `output-${key}`)
                                          )
                                        : <span className="typography-meta text-muted-foreground">—</span>}
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">Cost ($/1M tokens)</span>
                        {costRows.map((row) => (
                            <div key={row.label} className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{row.label}</span>
                                <span className="typography-meta font-medium text-foreground">{row.value}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">Limits</span>
                        {limitRows.map((row) => (
                            <div key={row.label} className="flex items-center justify-between gap-3">
                                <span className="typography-meta font-medium text-muted-foreground/80">{row.label}</span>
                                <span className="typography-meta font-medium text-foreground">{row.value}</span>
                            </div>
                        ))}
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">Metadata</span>
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta font-medium text-muted-foreground/80">Knowledge</span>
                            <span className="typography-meta font-medium text-foreground">{formatKnowledge(currentMetadata.knowledge)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta font-medium text-muted-foreground/80">Release</span>
                            <span className="typography-meta font-medium text-foreground">{formatDate(currentMetadata.release_date)}</span>
                        </div>
                    </div>
                </div>
            ) : (
                <div className="min-w-[200px] typography-meta text-muted-foreground">Model metadata unavailable.</div>
            )}
        </TooltipContent>
    );

    // Helper to render a single model row in the flat dropdown
    const renderModelRow = (
        model: ProviderModel,
        providerID: string,
        modelID: string,
        keyPrefix: string,
        flatIndex: number,
        isHighlighted: boolean
    ) => {
        const metadata = getModelMetadata(providerID, modelID);
        const capabilityIcons = getCapabilityIcons(metadata).map((icon) => ({
            ...icon,
            id: `cap-${icon.key}`,
        }));
        const modalityIcons = [
            ...getModalityIcons(metadata, 'input'),
            ...getModalityIcons(metadata, 'output'),
        ];
        const uniqueModalityIcons = Array.from(
            new Map(modalityIcons.map((icon) => [icon.key, icon])).values()
        ).map((icon) => ({ ...icon, id: `mod-${icon.key}` }));
        const indicatorIcons = [...capabilityIcons, ...uniqueModalityIcons];
        const contextTokens = formatTokens(metadata?.limit?.context);
        const isSelected = currentProviderId === providerID && currentModelId === modelID;
        const isFavorite = isFavoriteModel(providerID, modelID);

        const showProviderLogo = keyPrefix === 'fav' || keyPrefix === 'recent';

        // Check if model supports thinking variants - variants are on the model object, not metadata
        const modelVariants = (model as { variants?: Record<string, unknown> } | undefined)?.variants;
        const hasThinkingVariants = modelVariants && Object.keys(modelVariants).length > 0;
        const mapKey = `${providerID}:${modelID}`;
        const wasAdjusted = adjustedThinkingModels.has(mapKey);
        const pendingVariant = pendingThinkingVariants.get(mapKey);
        const effectiveVariant = pendingVariant ?? (isSelected ? currentVariant : undefined);

        // Build thinking variant display - only show for models that were adjusted with arrow keys
        let thinkingDisplay: React.ReactNode = null;
        if (hasThinkingVariants && wasAdjusted && (isHighlighted || isSelected)) {
            const displayLabel = effectiveVariant
                ? effectiveVariant.charAt(0).toUpperCase() + effectiveVariant.slice(1)
                : 'Default';
            thinkingDisplay = (
                <span key="thinking" className="typography-micro text-muted-foreground whitespace-nowrap">
                    {effortSelectorLabel}: {displayLabel}
                </span>
            );
        }

        // Build animated metadata slides for desktop (price/capabilities) - only shown when not showing thinking
        const priceText = formatCompactPrice(metadata);
        const hasPrice = priceText !== null;
        const hasCapabilities = indicatorIcons.length > 0;

        const slides: React.ReactNode[] = [];
        if (hasPrice) {
            slides.push(
                <span key="price" className="typography-micro text-muted-foreground whitespace-nowrap">
                    {priceText}
                </span>
            );
        }
        if (hasCapabilities) {
            slides.push(
                <div key="capabilities" className="flex items-center gap-0.5">
                    {indicatorIcons.map(({ id, icon: Icon, label }) => (
                        <span
                            key={id}
                            className="flex h-3.5 w-3.5 items-center justify-center text-muted-foreground"
                            aria-label={label}
                            role="img"
                            title={label}
                        >
                            <Icon className="h-2.5 w-2.5" />
                        </span>
                    ))}
                </div>
            );
        }

        const supportsRotatingMetadata = !isVSCodeRuntime;
        const shouldShowThinking = hasThinkingVariants && wasAdjusted;
        const shouldAnimate = supportsRotatingMetadata && slides.length > 1 && (isHighlighted || isSelected) && !shouldShowThinking;
        const staticSlideIndex = !supportsRotatingMetadata && hasCapabilities && hasPrice ? 1 : 0;
        const staticMetadataSlide = slides[staticSlideIndex];

        return (
            <div
                key={`${keyPrefix}-${providerID}-${modelID}`}
                ref={(el) => { modelItemRefs.current[flatIndex] = el; }}
                className={cn(
                    "typography-meta group flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer",
                     isHighlighted ? "bg-interactive-selection" : "hover:bg-interactive-hover/50"
                )}
                onClick={() => handleProviderAndModelChange(providerID, modelID)}
                onMouseEnter={() => setModelSelectedIndex(flatIndex)}
            >
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    {showProviderLogo && (
                        <ProviderLogo providerId={providerID} className="h-3.5 w-3.5 flex-shrink-0" />
                    )}
                    <span className="font-medium truncate">
                        {getModelDisplayName(model)}
                    </span>
                    {metadata?.limit?.context ? (
                        <span className="typography-micro text-muted-foreground flex-shrink-0">
                            {contextTokens}
                        </span>
                    ) : null}
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                    {/* Metadata slot: thinking variant for adjusted models, otherwise price/capabilities carousel */}
                    {shouldShowThinking && (isHighlighted || isSelected) ? (
                        <div className="flex w-[140px] justify-end items-center">
                            {thinkingDisplay}
                        </div>
                    ) : slides.length > 0 ? (
                        <div className={cn(
                            "items-center",
                            shouldAnimate ? "flex w-[140px] justify-end" : ((isHighlighted || isSelected) ? "flex" : "hidden group-hover:flex")
                        )}>
                            {shouldAnimate ? (
                                <TextLoop interval={2.1} transition={{ duration: 0.25 }} trigger={shouldAnimate}>
                                    {slides}
                                </TextLoop>
                            ) : (
                                <>
                                    {/* In static runtimes (VS Code), prefer capabilities over price when both exist. */}
                                    {staticMetadataSlide}
                                </>
                            )}
                        </div>
                    ) : null}
                    {isSelected && (
                        <RiCheckLine className="h-4 w-4 text-primary" />
                    )}
                    <button
                        onClick={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            toggleFavoriteModel(providerID, modelID);
                        }}
                        className={cn(
                            "model-favorite-button flex h-4 w-4 items-center justify-center hover:text-primary/80",
                            isFavorite ? "text-primary" : "text-muted-foreground"
                        )}
                        aria-label={isFavorite ? "Unfavorite" : "Favorite"}
                        title={isFavorite ? "Remove from favorites" : "Add to favorites"}
                    >
                        {isFavorite ? (
                            <RiStarFill className="h-3.5 w-3.5" />
                        ) : (
                            <RiStarLine className="h-3.5 w-3.5" />
                        )}
                    </button>
                </div>
            </div>
        );
    };

    // Filter models based on search query
    const filterByQuery = (modelName: string, providerName: string, query: string) => {
        if (!query.trim()) return true;
        return (
            matchesModelSearch(modelName, query) ||
            matchesModelSearch(providerName, query)
        );
    };

    const renderModelSelector = () => {
        const normalizedDesktopQuery = desktopModelQuery.trim();
        const forceExpandProviders = normalizedDesktopQuery.length > 0;
        const visibleProviderIds = new Set(visibleProviders.map((provider) => String(provider.id)));

        // Filter favorites
        const filteredFavorites = usesBackendModelCatalog
            ? favoriteModelsList.filter(({ providerID }) => visibleProviderIds.has(providerID))
            : favoriteModelsList;
        const searchableFavorites = filteredFavorites.filter(({ model, providerID }) => {
            const provider = effectiveProviders.find(p => p.id === providerID);
            const providerName = provider?.name || providerID;
            const modelName = getModelDisplayName(model);
            return filterByQuery(modelName, providerName, desktopModelQuery);
        });

        // Filter recents
        const filteredRecents = usesBackendModelCatalog
            ? recentModelsList.filter(({ providerID }) => visibleProviderIds.has(providerID))
            : recentModelsList;
        const searchableRecents = filteredRecents.filter(({ model, providerID }) => {
            const provider = effectiveProviders.find(p => p.id === providerID);
            const providerName = provider?.name || providerID;
            const modelName = getModelDisplayName(model);
            return filterByQuery(modelName, providerName, desktopModelQuery);
        });

        // Filter providers and their models
        const filteredProviders = visibleProviders
            .map((provider) => {
                const providerModels = Array.isArray(provider.models) ? provider.models : [];
                const filteredModels = providerModels.filter((model: ProviderModel) => {
                    const modelName = getModelDisplayName(model);
                    return filterByQuery(modelName, provider.name || provider.id || '', desktopModelQuery);
                });
                return { ...provider, models: filteredModels };
            })
            .filter((provider) => provider.models.length > 0);

        const providerSections = filteredProviders.map((provider) => {
            const providerId = typeof provider.id === 'string' ? provider.id : '';
            const isExpanded = forceExpandProviders || !collapsedProviderSet.has(providerId);
            const models = Array.isArray(provider.models) ? (provider.models as ProviderModel[]) : [];
            return {
                provider,
                isExpanded,
                models,
                visibleModels: isExpanded ? models : [],
            };
        });

        const hasResults =
            searchableFavorites.length > 0 ||
            searchableRecents.length > 0 ||
            filteredProviders.length > 0;

        // Build flat list for keyboard navigation
        type FlatModelItem = { model: ProviderModel; providerID: string; modelID: string; section: string };
        const flatModelList: FlatModelItem[] = [];

        searchableFavorites.forEach(({ model, providerID, modelID }) => {
            flatModelList.push({ model, providerID, modelID, section: 'fav' });
        });
        searchableRecents.forEach(({ model, providerID, modelID }) => {
            flatModelList.push({ model, providerID, modelID, section: 'recent' });
        });
        providerSections.forEach(({ provider, visibleModels }) => {
            visibleModels.forEach((model) => {
                flatModelList.push({ model, providerID: provider.id as string, modelID: model.id as string, section: 'provider' });
            });
        });

        const totalItems = flatModelList.length;

        // Check if currently highlighted model supports thinking variants
        const highlightedItem = flatModelList[modelSelectedIndex];
        const highlightedSupportsThinking = highlightedItem ? (() => {
            const modelVariants = (highlightedItem.model as { variants?: Record<string, unknown> } | undefined)?.variants;
            return modelVariants && Object.keys(modelVariants).length > 0;
        })() : false;

        // Handle keyboard navigation
        const handleModelKeyDown = (e: React.KeyboardEvent) => {
            e.stopPropagation();

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                setModelSelectedIndex((prev) => (prev + 1) % Math.max(1, totalItems));
                // Scroll into view
                setTimeout(() => {
                    const nextIndex = (modelSelectedIndex + 1) % Math.max(1, totalItems);
                    modelItemRefs.current[nextIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }, 0);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setModelSelectedIndex((prev) => (prev - 1 + Math.max(1, totalItems)) % Math.max(1, totalItems));
                // Scroll into view
                setTimeout(() => {
                    const prevIndex = (modelSelectedIndex - 1 + Math.max(1, totalItems)) % Math.max(1, totalItems);
                    modelItemRefs.current[prevIndex]?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }, 0);
            } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                const selectedItem = flatModelList[modelSelectedIndex];
                if (!selectedItem) return;

                const { providerID, modelID, model } = selectedItem;
                const modelVariants = (model as { variants?: Record<string, unknown> } | undefined)?.variants;
                if (!modelVariants) return;

                const variantKeys = Object.keys(modelVariants);
                if (variantKeys.length === 0) return;

                const mapKey = `${providerID}:${modelID}`;
                const currentPending = pendingThinkingVariants.get(mapKey);
                const activeModelVariant = currentPending ?? (currentProviderId === providerID && currentModelId === modelID ? currentVariant : undefined);

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
            } else if (e.key === 'Enter') {
                e.preventDefault();
                const selectedItem = flatModelList[modelSelectedIndex];
                if (selectedItem) {
                    const { providerID, modelID } = selectedItem;
                    const mapKey = `${providerID}:${modelID}`;
                    const pendingVariant = pendingThinkingVariants.get(mapKey);
                    const wasAdjusted = adjustedThinkingModels.has(mapKey);

                    handleProviderAndModelChange(providerID, modelID);

                    if (wasAdjusted) {
                        setTimeout(() => {
                            handleVariantSelect(pendingVariant);
                        }, 0);
                    }
                }
            } else if (e.key === 'Escape') {
                e.preventDefault();
                setAgentMenuOpen(false);
            }
        };

        // Build index mapping for rendering
        let currentFlatIndex = 0;

        return (
            <Tooltip delayDuration={1000}>
                {!isCompact ? (
                    <DropdownMenu open={agentMenuOpen} onOpenChange={setAgentMenuOpen}>
                        <TooltipTrigger asChild>
                            <DropdownMenuTrigger asChild>
                                <div
                                    className={cn(
                                        'model-controls__model-trigger flex items-center gap-1.5 cursor-pointer hover:bg-transparent hover:opacity-70 min-w-0',
                                        buttonHeight
                                    )}
                                >
                                    {currentProviderId ? (
                                        <>
                                            <ProviderLogo
                                                providerId={currentProviderId}
                                                className={cn(controlIconSize, 'flex-shrink-0')}
                                            />
                                            <RiPencilAiLine className={cn(controlIconSize, 'text-primary/60 hidden')} />
                                        </>
                                    ) : (
                                        <RiPencilAiLine className={cn(controlIconSize, 'text-muted-foreground')} />
                                    )}
                                        <span
                                            ref={modelLabelRef}
                                            key={`${currentProviderId}-${currentModelId}`}
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
                                </div>
                            </DropdownMenuTrigger>
                        </TooltipTrigger>
                        <DropdownMenuContent className="w-[min(380px,calc(100vw-2rem))] p-0 flex flex-col" align="end" alignOffset={-40}>
                            {/* Search Input */}
                            <div className="p-2 border-b border-border/40">
                                <div className="relative">
                                    <RiSearchLine className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                                    <Input
                                        type="text"
                                        placeholder="Search models"
                                        value={desktopModelQuery}
                                        onChange={(e) => setDesktopModelQuery(e.target.value)}
                                        onKeyDown={handleModelKeyDown}
                                        className="pl-8 h-8 typography-meta"
                                        autoFocus
                                    />
                                </div>
                            </div>

                            {/* Scrollable content */}
                            <ScrollableOverlay
                                outerClassName="max-h-[min(400px,calc(100dvh-12rem))] flex-1"
                                className="overlay-scrollbar-target--no-gutter"
                            >
                                <div className="p-1">
                                    {!usesBackendModelCatalog && (
                                        <>
                                            <div
                                                role="button"
                                                tabIndex={0}
                                                onClick={openAddProviderSettings}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter' || e.key === ' ') {
                                                        e.preventDefault();
                                                        openAddProviderSettings();
                                                    }
                                                }}
                                                className="typography-meta group flex items-center gap-1 rounded-md px-2 py-1.5 cursor-pointer hover:bg-interactive-hover/50"
                                            >
                                                <span className="flex h-4 w-4 items-center justify-center text-muted-foreground">
                                                    <RiAddLine className="h-4 w-4 -mr-0.5" />
                                                </span>
                                                <span className="font-medium text-foreground">Add new provider</span>
                                            </div>

                                            <DropdownMenuSeparator />
                                        </>
                                    )}

                                    {!hasResults && (
                                        <div className="px-2 py-4 text-center typography-meta text-muted-foreground">
                                            No models found
                                        </div>
                                    )}

                                    {/* Favorites Section */}
                                    {searchableFavorites.length > 0 && (
                                        <div>
                                            <DropdownMenuLabel
                                                className="typography-micro font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 -mx-1 px-3 py-1.5 border-b border-border/30"
                                            >
                                                <RiStarFill className="h-4 w-4 text-primary" />
                                                Favorites
                                            </DropdownMenuLabel>
                                            {searchableFavorites.map(({ model, providerID, modelID }) => {
                                                const idx = currentFlatIndex++;
                                                return renderModelRow(model, providerID, modelID, 'fav', idx, modelSelectedIndex === idx);
                                            })}
                                        </div>
                                    )}

                                    {/* Recents Section */}
                                    {searchableRecents.length > 0 && (
                                        <div>
                                            {searchableFavorites.length > 0 && <DropdownMenuSeparator />}
                                            <DropdownMenuLabel
                                                className="typography-micro font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-2 -mx-1 px-3 py-1.5 border-b border-border/30"
                                            >
                                                <RiTimeLine className="h-4 w-4" />
                                                Recent
                                            </DropdownMenuLabel>
                                            {searchableRecents.map(({ model, providerID, modelID }) => {
                                                const idx = currentFlatIndex++;
                                                return renderModelRow(model, providerID, modelID, 'recent', idx, modelSelectedIndex === idx);
                                            })}
                                        </div>
                                    )}

                                    {/* Separator before providers */}
                                    {(searchableFavorites.length > 0 || searchableRecents.length > 0) && filteredProviders.length > 0 && (
                                        <DropdownMenuSeparator />
                                    )}

                                    {/* All Providers - Flat List */}
                                    {providerSections.map(({ provider, isExpanded, visibleModels }, index) => (
                                        <div key={provider.id}>
                                            {index > 0 && <DropdownMenuSeparator />}
                                            <div
                                                role="button"
                                                tabIndex={forceExpandProviders ? -1 : 0}
                                                aria-disabled={forceExpandProviders}
                                                onClick={() => {
                                                    if (forceExpandProviders) {
                                                        return;
                                                    }
                                                    toggleModelProviderCollapsed(String(provider.id));
                                                    setModelSelectedIndex(0);
                                                }}
                                                onKeyDown={(event) => {
                                                    if (forceExpandProviders) {
                                                        return;
                                                    }
                                                    if (event.key === 'Enter' || event.key === ' ') {
                                                        event.preventDefault();
                                                        toggleModelProviderCollapsed(String(provider.id));
                                                        setModelSelectedIndex(0);
                                                    }
                                                }}
                                                className={cn(
                                                    'typography-micro font-semibold text-muted-foreground uppercase tracking-wider flex w-full items-center gap-2 -mx-1 px-3 py-1.5 border-b border-border/30',
                                                    'text-left transition-colors',
                                                    forceExpandProviders ? 'cursor-default' : 'cursor-pointer'
                                                )}
                                                aria-expanded={isExpanded}
                                                title={forceExpandProviders ? undefined : (isExpanded ? 'Collapse provider' : 'Expand provider')}
                                            >
                                                <div className="flex min-w-0 items-center gap-2">
                                                    <ProviderLogo
                                                        providerId={provider.id}
                                                        className="h-4 w-4 flex-shrink-0"
                                                    />
                                                    <span className="min-w-0 truncate">{provider.name}</span>
                                                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-muted-foreground">
                                                        {isExpanded ? (
                                                            <RiArrowDownSLine className="h-4 w-4" />
                                                        ) : (
                                                            <RiArrowRightSLine className="h-4 w-4" />
                                                        )}
                                                    </span>
                                                </div>
                                            </div>
                                            {isExpanded && visibleModels.map((model: ProviderModel) => {
                                                const idx = currentFlatIndex++;
                                                return renderModelRow(model, provider.id as string, model.id as string, 'provider', idx, modelSelectedIndex === idx);
                                            })}
                                        </div>
                                    ))}
                                </div>
                            </ScrollableOverlay>

                            {/* Keyboard hints footer */}
                            <div className="px-3 pt-1 pb-1.5 border-t border-border/40 typography-micro text-muted-foreground">
                                ↑↓ navigate{highlightedSupportsThinking ? ' • ←→ thinking' : ''} • Enter select • Esc close
                            </div>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : (
                    <button
                        type="button"
                        onClick={() => setActiveMobilePanel('model')}
                        onTouchStart={() => handleLongPressStart('model')}
                        onTouchEnd={handleLongPressEnd}
                        onTouchCancel={handleLongPressEnd}
                        className={cn(
                            'model-controls__model-trigger flex items-center gap-1.5 min-w-0 focus:outline-none',
                            'cursor-pointer hover:bg-transparent hover:opacity-70',
                            buttonHeight
                        )}
                    >
                        {currentProviderId ? (
                            <ProviderLogo
                                providerId={currentProviderId}
                                className={cn(controlIconSize, 'flex-shrink-0')}
                            />
                        ) : (
                            <RiPencilAiLine className={cn(controlIconSize, 'text-muted-foreground')} />
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
                    <div className="min-w-[200px] typography-meta text-muted-foreground">No agent selected.</div>
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
                return { mode: 'ask', label: 'Custom' };
            }

            if (action === 'allow') return { mode: 'allow', label: 'Allow' };
            if (action === 'deny') return { mode: 'deny', label: 'Deny' };
            return { mode: 'ask', label: 'Ask' };
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
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">Mode</span>
                        <span className="typography-meta text-foreground">
                            {currentAgent.mode === 'primary' ? 'Primary' : currentAgent.mode === 'subagent' ? 'Subagent' : currentAgent.mode === 'all' ? 'All' : '—'}
                        </span>
                    </div>

                    {(hasModelConfig || hasTemperatureOrTopP) && (
                        <div className="flex flex-col gap-1">
                            <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">Model</span>
                            {hasModelConfig ? (
                                <span className="typography-meta text-foreground">
                                    {currentAgent.model!.providerID} / {currentAgent.model!.modelID}
                                </span>
                            ) : (
                                <span className="typography-meta text-muted-foreground">—</span>
                            )}
                            {hasTemperatureOrTopP && (
                                <div className="flex flex-col gap-0.5 mt-0.5">
                                    {currentAgent.temperature !== undefined && (
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="typography-meta text-muted-foreground/80">Temperature</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.temperature}</span>
                                        </div>
                                    )}
                                    {currentAgent.topP !== undefined && (
                                        <div className="flex items-center justify-between gap-3">
                                            <span className="typography-meta text-muted-foreground/80">Top P</span>
                                            <span className="typography-meta font-medium text-foreground">{currentAgent.topP}</span>
                                        </div>
                                    )}
                                </div>
                            )}
                        </div>
                    )}


                    <div className="flex flex-col gap-1">
                        <span className="typography-meta font-semibold uppercase tracking-wide text-muted-foreground/90">Permissions</span>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground/80 w-16">Edit</span>
                            <div className="flex items-center gap-1.5">
                                {renderEditModeIcon(editPermissionSummary.mode, 'h-3.5 w-3.5')}
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {editPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground/80 w-16">Bash</span>
                            <div className="flex items-center gap-1.5">
                                {renderEditModeIcon(bashPermissionSummary.mode, 'h-3.5 w-3.5')}
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {bashPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                        <div className="flex items-center gap-3">
                            <span className="typography-meta text-muted-foreground/80 w-16">WebFetch</span>
                            <div className="flex items-center gap-1.5">
                                {renderEditModeIcon(webfetchPermissionSummary.mode, 'h-3.5 w-3.5')}
                                <span className="typography-meta font-medium text-foreground w-12">
                                    {webfetchPermissionSummary.label}
                                </span>
                            </div>
                        </div>
                    </div>

                    {hasCustomPrompt && (
                        <div className="flex items-center justify-between gap-3">
                            <span className="typography-meta text-muted-foreground/80">Custom Prompt</span>
                            <RiCheckboxCircleLine className="h-4 w-4 text-foreground" />
                        </div>
                    )}
                </div>
            </TooltipContent>
        );
    };

    const renderVariantSelector = () => {
        if (!hasVariants) {
            return null;
        }

        const displayVariant = currentVariant ?? 'Default';
        const isDefault = !currentVariant;
        const colorClass = isDefault ? 'text-foreground' : 'text-[color:var(--status-info)]';

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
                    <RiBrainAi3Line className={cn(controlIconSize, 'flex-shrink-0', colorClass)} />
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
            <Tooltip delayDuration={800}>
                <DropdownMenu>
                    <TooltipTrigger asChild>
                        <DropdownMenuTrigger asChild>
                            <div
                                className={cn(
                                    'model-controls__variant-trigger flex items-center gap-1.5 transition-colors cursor-pointer hover:bg-transparent hover:opacity-70 min-w-0',
                                    buttonHeight,
                                )}
                            >
                                <RiBrainAi3Line className={cn(controlIconSize, 'flex-shrink-0', colorClass)} />
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
                        <DropdownMenuLabel className="typography-ui-header font-semibold text-foreground">{effortSelectorLabel}</DropdownMenuLabel>
                        <DropdownMenuItem className="typography-meta" onSelect={() => handleVariantSelect(undefined)}>
                            <div className="flex items-center justify-between gap-2 w-full min-w-0">
                                <span className="typography-meta font-medium text-foreground truncate min-w-0">Default</span>
                                {isDefault && <RiCheckLine className="h-4 w-4 text-primary flex-shrink-0" />}
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
                                        {selected && <RiCheckLine className="h-4 w-4 text-primary flex-shrink-0" />}
                                    </div>
                                </DropdownMenuItem>
                            );
                        })}
                    </DropdownMenuContent>
                </DropdownMenu>
                <TooltipContent side="top">
                    <p className="typography-meta">{effortSelectorLabel}: {displayVariant}</p>
                </TooltipContent>
            </Tooltip>
        );
    };

    const renderAgentSelector = () => {
        if (!isCompact) {
            return (
                <div className="flex items-center gap-2 min-w-0">
                    <Tooltip delayDuration={1000}>
                        <DropdownMenu open={isAgentSelectorOpen} onOpenChange={setIsAgentSelectorOpen}>
                            <TooltipTrigger asChild>
                                <DropdownMenuTrigger asChild>
                                    <div className={cn(
                                        'flex items-center gap-1.5 transition-colors cursor-pointer hover:bg-transparent hover:opacity-70 min-w-0',
                                        buttonHeight
                                    )}>
                                        <RiAiAgentLine
                                            className={cn(
                                                controlIconSize,
                                                'flex-shrink-0',
                                        uiAgentName && primarySelectorKind === 'agent' ? '' : 'text-muted-foreground'
                                    )}
                                    style={uiAgentName && primarySelectorKind === 'agent' ? { color: `var(${getAgentColor(uiAgentName).var})` } : undefined}
                                />
                                        <span
                                            className={cn(
                                                'model-controls__agent-label',
                                                controlTextSize,
                                                'font-medium min-w-0 truncate',
                                                isDesktop ? 'max-w-[220px]' : undefined
                                            )}
                                            style={uiAgentName && primarySelectorKind === 'agent' ? { color: `var(${getAgentColor(uiAgentName).var})` } : undefined}
                                        >
                                            {getAgentDisplayName()}
                                        </span>
                                    </div>
                                </DropdownMenuTrigger>
                            </TooltipTrigger>
                            <DropdownMenuContent align="end" alignOffset={-40} className="w-[min(280px,calc(100vw-2rem))] p-0 flex flex-col">
                                <div className="p-2 border-b border-border/40">
                                    <div className="relative">
                                        <RiSearchLine className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                                        <Input
                                            type="text"
                                            placeholder={`Search ${primarySelectorLabel.toLowerCase()}s`}
                                            value={agentSearchQuery}
                                            onChange={(e) => setAgentSearchQuery(e.target.value)}
                                            onKeyDown={(e) => {
                                                e.stopPropagation();
                                            }}
                                            className="pl-8 h-8 typography-meta"
                                            autoFocus
                                        />
                                    </div>
                                </div>
                                <ScrollableOverlay outerClassName="max-h-[min(400px,calc(100dvh-12rem))] flex-1">
                                    <div className="p-1">
                                        {!agentSearchQuery.trim() && defaultAgentName && (
                                            <>
                                                <DropdownMenuItem
                                                    className="typography-meta"
                                                    onSelect={() => handlePrimarySelectorChange(defaultAgentName)}
                                                >
                                                    <div className="flex items-center gap-1.5">
                                                        <RiArrowGoBackLine className="h-3.5 w-3.5 text-muted-foreground" />
                                                        <span className="font-medium">Reset to default</span>
                                                    </div>
                                                </DropdownMenuItem>
                                                <DropdownMenuSeparator />
                                            </>
                                        )}
                                        {sortedAndFilteredAgents.length === 0 ? (
                                            <div className="px-2 py-4 text-center typography-meta text-muted-foreground">
                                                No {primarySelectorLabel.toLowerCase()}s found
                                            </div>
                                        ) : (
                                            sortedAndFilteredAgents.map((agent) => (
                                                <DropdownMenuItem
                                                    key={agent.id}
                                                    className="typography-meta"
                                                    onSelect={() => handlePrimarySelectorChange(agent.id)}
                                                >
                                                    <div className="flex flex-col gap-0.5">
                                                        <div className="flex items-center gap-1.5">
                                                            {primarySelectorKind === 'agent' ? (
                                                                <div className={cn(
                                                                    'h-1 w-1 rounded-full agent-dot',
                                                                    getAgentColor(agent.id).class
                                                                )} />
                                                            ) : null}
                                                            <span className="font-medium">{agent.label}</span>
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
                        {primarySelectorKind === 'agent' ? renderAgentTooltipContent() : null}
                    </Tooltip>
                </div>
            );
        }

        return (
            <button
                type="button"
                onClick={() => setActiveMobilePanel('agent')}
                onTouchStart={() => handleLongPressStart('agent')}
                onTouchEnd={handleLongPressEnd}
                onTouchCancel={handleLongPressEnd}
                className={cn(
                    'model-controls__agent-trigger flex items-center gap-1.5 transition-colors min-w-0 focus:outline-none',
                    buttonHeight,
                    'cursor-pointer hover:bg-transparent hover:opacity-70',
                )}
            >
                                        <RiAiAgentLine
                                            className={cn(
                                                controlIconSize,
                                                'flex-shrink-0',
                                                uiAgentName ? '' : 'text-muted-foreground'
                                            )}
                                            style={uiAgentName && primarySelectorKind === 'agent' ? { color: `var(${getAgentColor(uiAgentName).var})` } : undefined}
                                        />
                <span
                    className={cn(
                        'model-controls__agent-label',
                        controlTextSize,
                        'font-medium truncate min-w-0',
                        isMobile && 'max-w-[60px]'
                    )}
                                            style={uiAgentName && primarySelectorKind === 'agent' ? { color: `var(${getAgentColor(uiAgentName).var})` } : undefined}
                                        >
                                            {getAgentDisplayName()}
                                        </span>
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
                    {renderVariantSelector()}
                    {renderBackendSelector()}
                    {renderModelSelector()}
                    {renderAgentSelector()}
                </div>
            </div>

            {renderMobileModelPanel()}
            {renderMobileVariantPanel()}
            {renderMobileAgentPanel()}
            {renderMobileModelTooltip()}
            {primarySelectorKind === 'agent' ? renderMobileAgentTooltip() : null}
        </>
    );

};
