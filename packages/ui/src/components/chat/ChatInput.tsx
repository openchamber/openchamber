import React from 'react';
import { Textarea } from '@/components/ui/textarea';
import {
    RiAddCircleLine,
    RiAiAgentLine,
    RiAttachment2,
    RiCommandLine,
    RiFileUploadLine,
    RiFullscreenLine,
    RiSendPlane2Line,
} from '@remixicon/react';
import { BrowserVoiceButton } from '@/components/voice';
import { useSessionStore } from '@/stores/useSessionStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { useInlineCommentDraftStore, type InlineCommentDraft } from '@/stores/useInlineCommentDraftStore';
import { appendInlineComments } from '@/lib/messages/inlineComments';
import { AttachedFilesList } from './FileAttachment';
import { QueuedMessageChips } from './QueuedMessageChips';
import { FileMentionAutocomplete, type FileMentionHandle } from './FileMentionAutocomplete';
import { CommandAutocomplete, type CommandAutocompleteHandle } from './CommandAutocomplete';
import { SkillAutocomplete, type SkillAutocompleteHandle } from './SkillAutocomplete';
import { cn, isMacOS } from '@/lib/utils';
import { ServerFilePicker } from './ServerFilePicker';
import { ModelControls } from './ModelControls';
import { UnifiedControlsDrawer } from './UnifiedControlsDrawer';
import { parseAgentMentions } from '@/lib/messages/agentMentions';
import { StatusRow } from './StatusRow';
import { MobileAgentButton } from './MobileAgentButton';
import { MobileModelButton } from './MobileModelButton';
import { MobileSessionStatusBar } from './MobileSessionStatusBar';
import { useAssistantStatus } from '@/hooks/useAssistantStatus';
import { useCurrentSessionActivity } from '@/hooks/useSessionActivity';
import { toast } from '@/components/ui';
import { useFileStore } from '@/stores/fileStore';
import { useMessageStore } from '@/stores/messageStore';
import { isDesktopLocalOriginActive, isTauriShell, isVSCodeRuntime } from '@/lib/desktop';
import { isIMECompositionEvent } from '@/lib/ime';
import { StopIcon } from '@/components/icons/StopIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { MobileControlsPanel } from './mobileControlsUtils';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useThemeSystem } from '@/contexts/useThemeSystem';

const MAX_VISIBLE_TEXTAREA_LINES = 8;
const EMPTY_QUEUE: QueuedMessage[] = [];

interface ChatInputProps {
    onOpenSettings?: () => void;
    scrollToBottom?: (options?: { instant?: boolean; force?: boolean }) => void;
}

type AutocompleteOverlayPosition = {
    top: number;
    left: number;
    place: 'above' | 'below';
    maxHeight: number;
};

// Per-session draft key — preserves in-progress messages across project switches
const getDraftKey = (sessionId: string | null): string =>
    `openchamber_chat_input_draft_${sessionId ?? 'new'}`;

// Helper to safely read from localStorage for a given session
const getStoredDraft = (sessionId: string | null): string => {
    try {
        return localStorage.getItem(getDraftKey(sessionId)) ?? '';
    } catch {
        return '';
    }
};

// Helper to safely write/clear a per-session draft
const saveStoredDraft = (sessionId: string | null, draft: string): void => {
    try {
        if (draft) {
            localStorage.setItem(getDraftKey(sessionId), draft);
        } else {
            localStorage.removeItem(getDraftKey(sessionId));
        }
    } catch {
        // Ignore localStorage errors
    }
};

export const ChatInput: React.FC<ChatInputProps> = ({ onOpenSettings, scrollToBottom }) => {
    // Track if we restored a draft on mount (for text selection)
    const initialDraftRef = React.useRef<string | null>(null);
    // Track initial session ID (captured at mount time for draft restoration)
    const initialSessionIdRef = React.useRef<string | null>(null);
    const [message, setMessage] = React.useState(() => {
        // Read per-session draft at mount time using the current session from the store
        const sessionId = useSessionStore.getState().currentSessionId;
        initialSessionIdRef.current = sessionId;
        const draft = getStoredDraft(sessionId);
        if (draft) {
            initialDraftRef.current = draft;
        }
        return draft;
    });
    const [inputMode, setInputMode] = React.useState<'normal' | 'shell'>('normal');
    const [isDragging, setIsDragging] = React.useState(false);
    const [showFileMention, setShowFileMention] = React.useState(false);
    const [mentionQuery, setMentionQuery] = React.useState('');
    const [showCommandAutocomplete, setShowCommandAutocomplete] = React.useState(false);
    const [commandQuery, setCommandQuery] = React.useState('');
    const [autocompleteTab, setAutocompleteTab] = React.useState<'commands' | 'agents' | 'files'>('commands');
    const [showSkillAutocomplete, setShowSkillAutocomplete] = React.useState(false);
    const [skillQuery, setSkillQuery] = React.useState('');
    const [textareaSize, setTextareaSize] = React.useState<{ height: number; maxHeight: number } | null>(null);
    const [mobileControlsOpen, setMobileControlsOpen] = React.useState(false);
    const [mobileControlsPanel, setMobileControlsPanel] = React.useState<MobileControlsPanel>(null);
    // Message history navigation state (up/down arrow to recall previous messages)
    const [historyIndex, setHistoryIndex] = React.useState(-1); // -1 = not browsing, 0+ = index from most recent
    const [draftMessage, setDraftMessage] = React.useState(''); // Preserves input when entering history mode
    const textareaRef = React.useRef<HTMLTextAreaElement>(null);
    const dropZoneRef = React.useRef<HTMLDivElement>(null);
    const canAcceptDropRef = React.useRef(false);
    const mentionRef = React.useRef<FileMentionHandle>(null);
    const commandRef = React.useRef<CommandAutocompleteHandle>(null);
    const skillRef = React.useRef<SkillAutocompleteHandle>(null);
    // Ref to track current message value without triggering re-renders in effects
    const messageRef = React.useRef(message);

    const sendMessage = useSessionStore((state) => state.sendMessage);
    const currentSessionId = useSessionStore((state) => state.currentSessionId);
    const newSessionDraftOpen = useSessionStore((state) => state.newSessionDraft?.open);
    const abortCurrentOperation = useSessionStore((state) => state.abortCurrentOperation);
    const acknowledgeSessionAbort = useSessionStore((state) => state.acknowledgeSessionAbort);
    const abortPromptSessionId = useSessionStore((state) => state.abortPromptSessionId);
    const clearAbortPrompt = useSessionStore((state) => state.clearAbortPrompt);
    const attachedFiles = useSessionStore((state) => state.attachedFiles);
    const addAttachedFile = useSessionStore((state) => state.addAttachedFile);
    const addServerFile = useSessionStore((state) => state.addServerFile);
    const clearAttachedFiles = useSessionStore((state) => state.clearAttachedFiles);
    const saveSessionAgentSelection = useSessionStore((state) => state.saveSessionAgentSelection);
    const consumePendingInputText = useSessionStore((state) => state.consumePendingInputText);
    const pendingInputText = useSessionStore((state) => state.pendingInputText);
    const consumePendingSyntheticParts = useSessionStore((state) => state.consumePendingSyntheticParts);

    const { currentProviderId, currentModelId, currentVariant, currentAgentName, setAgent, getVisibleAgents } = useConfigStore();
    const agents = getVisibleAgents();
    const primaryAgents = React.useMemo(() => agents.filter((agent) => agent.mode === 'primary'), [agents]);
    const { isMobile, inputBarOffset, isKeyboardOpen, setTimelineDialogOpen, cornerRadius, persistChatDraft, isExpandedInput, setExpandedInput } = useUIStore();
    const { working } = useAssistantStatus();
    const { currentTheme } = useThemeSystem();
    const [showAbortStatus, setShowAbortStatus] = React.useState(false);
    const isDesktopExpanded = isExpandedInput && !isMobile;
    const [autocompleteOverlayPosition, setAutocompleteOverlayPosition] = React.useState<AutocompleteOverlayPosition | null>(null);
    const abortTimeoutRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevWasAbortedRef = React.useRef(false);

    // Message queue
    const queueModeEnabled = useMessageQueueStore((state) => state.queueModeEnabled);
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!currentSessionId) return EMPTY_QUEUE;
                return state.queuedMessages[currentSessionId] ?? EMPTY_QUEUE;
            },
            [currentSessionId]
        )
    );
    const addToQueue = useMessageQueueStore((state) => state.addToQueue);
    const clearQueue = useMessageQueueStore((state) => state.clearQueue);

    // Inline comment drafts
    const draftCount = useInlineCommentDraftStore(
        React.useCallback(
            (state) => {
                const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : '');
                if (!sessionKey) return 0;
                return (state.drafts[sessionKey] ?? []).length;
            },
            [currentSessionId, newSessionDraftOpen]
        )
    );
    const consumeDrafts = useInlineCommentDraftStore((state) => state.consumeDrafts);
    const hasDrafts = draftCount > 0;

    // User message history for up/down arrow navigation
    // Get raw messages from store (stable reference)
    const sessionMessages = useMessageStore(
        React.useCallback(
            (state) => (currentSessionId ? state.messages.get(currentSessionId) : undefined),
            [currentSessionId]
        )
    );
    // Derive user message history with useMemo to avoid infinite re-renders
    const userMessageHistory = React.useMemo(() => {
        if (!sessionMessages) return [];
        return sessionMessages
            .filter((m) => m.info.role === 'user')
            .map((m) => {
                const textPart = m.parts.find((p) => p.type === 'text');
                if (textPart && 'text' in textPart) {
                    return String(textPart.text);
                }
                return '';
            })
            .filter((text) => text.length > 0)
            .reverse(); // Most recent first
    }, [sessionMessages]);

    // Keep messageRef in sync with message state
    React.useEffect(() => {
        messageRef.current = message;
    }, [message]);

    // Handle initial draft restoration and text selection
    const hasHandledInitialDraftRef = React.useRef(false);
    React.useEffect(() => {
        if (hasHandledInitialDraftRef.current) return;
        hasHandledInitialDraftRef.current = true;

        const draft = initialDraftRef.current;
        if (!draft) return;

        if (!persistChatDraft) {
            // Setting disabled - clear the restored draft
            setMessage('');
            try {
                localStorage.removeItem(getDraftKey(initialSessionIdRef.current));
            } catch {
                // Ignore
            }
        } else {
            // Setting enabled - select all text
            requestAnimationFrame(() => {
                textareaRef.current?.select();
            });
        }
    }, [persistChatDraft]);

    // Handle session switching: save draft for old session, restore draft for new session
    const prevSessionIdRef = React.useRef(currentSessionId);
    React.useEffect(() => {
        if (prevSessionIdRef.current !== currentSessionId) {
            const oldSessionId = prevSessionIdRef.current;
            prevSessionIdRef.current = currentSessionId;
            setInputMode('normal');

            if (persistChatDraft) {
                // Save current draft for the session we're leaving
                saveStoredDraft(oldSessionId, messageRef.current);
                // Restore draft for the session we're entering
                const newDraft = getStoredDraft(currentSessionId);
                setMessage(newDraft);
                if (newDraft) {
                    requestAnimationFrame(() => {
                        textareaRef.current?.select();
                    });
                }
            } else {
                // Persist disabled: clear input without saving
                setMessage('');
            }
        }
    }, [currentSessionId, persistChatDraft]);

    // Focus textarea when new session draft is opened
    const prevNewSessionDraftOpenRef = React.useRef(newSessionDraftOpen);
    React.useEffect(() => {
        if (!prevNewSessionDraftOpenRef.current && newSessionDraftOpen) {
            // New session draft just opened - focus the textarea
            requestAnimationFrame(() => {
                if (isMobile) {
                    // On mobile, use preventScroll to avoid viewport jumping
                    textareaRef.current?.focus({ preventScroll: true });
                } else {
                    textareaRef.current?.focus();
                }
            });
        }
        prevNewSessionDraftOpenRef.current = newSessionDraftOpen;
    }, [newSessionDraftOpen, isMobile]);

    // Persist chat input draft to localStorage per session (only if setting enabled)
    React.useEffect(() => {
        if (!persistChatDraft) {
            // Clear stored draft for current session when setting is disabled
            try {
                localStorage.removeItem(getDraftKey(currentSessionId));
            } catch {
                // Ignore
            }
            return;
        }
        saveStoredDraft(currentSessionId, message);
    }, [message, persistChatDraft, currentSessionId]);

    // Session activity for queue availability and controls
    const { phase: sessionPhase } = useCurrentSessionActivity();

    const handleTextareaPointerDownCapture = React.useCallback((event: React.PointerEvent<HTMLTextAreaElement>) => {
        if (!isMobile) {
            return;
        }

        if (event.pointerType !== 'touch') {
            return;
        }

        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }

        if (document.activeElement === textarea) {
            return;
        }

        // Prevent iOS from scrolling the page to reveal the input.
        event.preventDefault();
        event.stopPropagation();

        const scroller = document.scrollingElement;
        if (scroller && scroller.scrollTop !== 0) {
            scroller.scrollTop = 0;
        }
        if (window.scrollY !== 0) {
            window.scrollTo(0, 0);
        }

        try {
            textarea.focus({ preventScroll: true });
        } catch {
            textarea.focus();
        }

        const len = textarea.value.length;
        try {
            textarea.setSelectionRange(len, len);
        } catch {
            // ignored
        }
    }, [isMobile]);

    const handleOpenMobileControls = React.useCallback(() => {
        if (!isMobile) {
            return;
        }

        if (mobileControlsOpen) {
            setMobileControlsOpen(false);
            return;
        }

        setMobileControlsPanel(null);

        if (isKeyboardOpen) {
            textareaRef.current?.blur();
            requestAnimationFrame(() => {
                setMobileControlsOpen(true);
            });
            return;
        }

        setMobileControlsOpen(true);
    }, [isMobile, isKeyboardOpen, mobileControlsOpen]);

    const handleCloseMobileControls = React.useCallback(() => {
        setMobileControlsOpen(false);
    }, []);

    const handleOpenMobilePanel = React.useCallback((panel: MobileControlsPanel) => {
        if (!isMobile) {
            return;
        }
        setMobileControlsOpen(false);
        textareaRef.current?.blur();
        requestAnimationFrame(() => {
            setMobileControlsPanel(panel);
        });
    }, [isMobile]);

    const handleReturnToUnifiedControls = React.useCallback(() => {
        if (!isMobile) {
            return;
        }
        setMobileControlsPanel(null);
        requestAnimationFrame(() => {
            setMobileControlsOpen(true);
        });
    }, [isMobile]);

    // Consume pending input text (e.g., from revert action)
    React.useEffect(() => {
        if (pendingInputText !== null) {
            const pending = consumePendingInputText();
            if (pending?.text) {
                if (pending.mode === 'append') {
                    setMessage((prev) => {
                        const next = pending.text.trim();
                        if (!next) return prev;
                        const base = prev.trimEnd();
                        if (!base.trim()) return next;
                        return `${base} ${next}`;
                    });
                } else {
                    setMessage(pending.text);
                }
                // Focus textarea after setting message
                setTimeout(() => {
                    textareaRef.current?.focus();
                }, 0);
            }
        }
    }, [pendingInputText, consumePendingInputText]);

    const hasContent = message.trim() || attachedFiles.length > 0 || hasDrafts;
    const hasQueuedMessages = queuedMessages.length > 0;
    const canSend = hasContent || hasQueuedMessages;

    const canAbort = working.isWorking;

    // Keep a ref to handleSubmit so callbacks don't depend on it.
    type SubmitOptions = {
        queuedOnly?: boolean;
    };
    const handleSubmitRef = React.useRef<(options?: SubmitOptions) => Promise<void>>(async () => {});

    // Add message to queue instead of sending
    const handleQueueMessage = React.useCallback(() => {
        if (!hasContent || !currentSessionId) return;

        const drafts = consumeDrafts(currentSessionId);

        let messageToQueue = message.replace(/^\n+|\n+$/g, '');
        if (drafts.length > 0) {
            messageToQueue = appendInlineComments(messageToQueue, drafts);
        }
        const attachmentsToQueue = attachedFiles.map((file) => ({ ...file }));

        addToQueue(currentSessionId, {
            content: messageToQueue,
            attachments: attachmentsToQueue.length > 0 ? attachmentsToQueue : undefined,
        });

        // Clear input and attachments
        setMessage('');
        if (attachmentsToQueue.length > 0) {
            clearAttachedFiles();
        }

        if (!isMobile) {
            textareaRef.current?.focus();
        }
    }, [hasContent, currentSessionId, message, attachedFiles, addToQueue, clearAttachedFiles, isMobile, consumeDrafts]);

    const handleSubmit = async (options?: SubmitOptions) => {
        const queuedOnly = options?.queuedOnly ?? false;

        if (queuedOnly) {
            if (!hasQueuedMessages || !currentSessionId) return;
        } else if (!canSend || (!currentSessionId && !newSessionDraftOpen)) {
            return;
        }

        // Re-pin and scroll to bottom when sending
        scrollToBottom?.({ instant: true, force: true });

        if (!currentProviderId || !currentModelId) {
            console.warn('Cannot send message: provider or model not selected');
            return;
        }

        // Build the primary message (first part) and additional parts
        let primaryText = '';
        let primaryAttachments: AttachedFile[] = [];
        let agentMentionName: string | undefined;
        const additionalParts: Array<{ text: string; attachments?: AttachedFile[]; synthetic?: boolean }> = [];

        // Consume any pending synthetic parts (from conflict resolution, etc.)
        const syntheticParts = consumePendingSyntheticParts();

        // Process queued messages first
        for (let i = 0; i < queuedMessages.length; i++) {
            const queuedMsg = queuedMessages[i];
            const { sanitizedText, mention } = parseAgentMentions(queuedMsg.content, agents);

            // Use agent mention from first message that has one
            if (!agentMentionName && mention?.name) {
                agentMentionName = mention.name;
            }

            if (i === 0) {
                // First queued message becomes primary
                primaryText = sanitizedText;
                primaryAttachments = queuedMsg.attachments ?? [];
            } else {
                // Subsequent queued messages become additional parts
                additionalParts.push({
                    text: sanitizedText,
                    attachments: queuedMsg.attachments,
                });
            }
        }

        // Add current input (skip for queued-only auto-send)
        if (!queuedOnly && hasContent) {
            const messageToSend = message.replace(/^\n+|\n+$/g, '');
            const { sanitizedText, mention } = parseAgentMentions(messageToSend, agents);
            const attachmentsToSend = attachedFiles.map((file) => ({ ...file }));

            if (!agentMentionName && mention?.name) {
                agentMentionName = mention.name;
            }

            if (queuedMessages.length === 0) {
                // No queue - current input is primary
                primaryText = sanitizedText;
                primaryAttachments = attachmentsToSend;
            } else {
                // Has queue - current input is additional part
                additionalParts.push({
                    text: sanitizedText,
                    attachments: attachmentsToSend.length > 0 ? attachmentsToSend : undefined,
                });
            }
        }

        const sessionKey = currentSessionId ?? (newSessionDraftOpen ? 'draft' : null);
        let drafts: InlineCommentDraft[] = [];
        if (!queuedOnly && sessionKey) {
            drafts = consumeDrafts(sessionKey);
        }

        if (drafts.length > 0) {
            if (queuedMessages.length === 0) {
                primaryText = appendInlineComments(primaryText, drafts);
            } else if (additionalParts.length > 0) {
                const lastPart = additionalParts[additionalParts.length - 1];
                lastPart.text = appendInlineComments(lastPart.text, drafts);
            } else {
                primaryText = appendInlineComments(primaryText, drafts);
            }
        }

        // Add synthetic parts (from conflict resolution, etc.)
        if (syntheticParts && syntheticParts.length > 0) {
            for (const part of syntheticParts) {
                additionalParts.push({
                    text: part.text,
                    synthetic: true,
                });
            }
        }

        if (!primaryText && additionalParts.length === 0) return;

        // Clear queue and input
        if (currentSessionId && hasQueuedMessages) {
            clearQueue(currentSessionId);
        }
        if (!queuedOnly) {
            setMessage('');
            // Clear per-session draft on submit
            saveStoredDraft(currentSessionId, '');
            // Reset message history navigation state
            setHistoryIndex(-1);
            setDraftMessage('');
            if (attachedFiles.length > 0) {
                clearAttachedFiles();
            }
            // Close expanded input overlay when submitting
            setExpandedInput(false);
        }

        if (isMobile) {
            textareaRef.current?.blur();
        }

        // Handle local slash commands only in normal mode
        const normalizedCommand = primaryText.trimStart();
        if (inputMode === 'normal' && normalizedCommand.startsWith('/')) {
            const commandName = normalizedCommand
                .slice(1)
                .trim()
                .split(/\s+/)[0]
                ?.toLowerCase();

            // NEW: /undo - revert to last message (populates input with reverted message text)
            if (commandName === 'undo' && currentSessionId) {
                await useSessionStore.getState().handleSlashUndo(currentSessionId);
                // Don't clear message - pendingInputText will populate it with reverted message
                scrollToBottom?.({ instant: true, force: true });
                return; // Don't send to assistant
            }
            // NEW: /redo - unrevert or partial redo (populates input with message text)
            else if (commandName === 'redo' && currentSessionId) {
                await useSessionStore.getState().handleSlashRedo(currentSessionId);
                // Don't clear message - pendingInputText will populate it
                scrollToBottom?.({ instant: true, force: true });
                return; // Don't send to assistant
            }
            // NEW: /timeline - open timeline dialog
            else if (commandName === 'timeline' && currentSessionId) {
                setTimelineDialogOpen(true);
                setMessage('');
                return; // Don't send to assistant
            }
        }

        // Collect all attachments for error recovery
        const allAttachments = [
            ...primaryAttachments,
            ...additionalParts.flatMap(p => p.attachments ?? []),
        ];

        void sendMessage(
            primaryText,
            currentProviderId,
            currentModelId,
            currentAgentName,
            primaryAttachments,
            agentMentionName,
            additionalParts.length > 0 ? additionalParts : undefined,
            currentVariant,
            inputMode
        ).catch((error: unknown) => {
            const rawMessage =
                error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                        ? error
                        : String(error ?? '');
            const normalized = rawMessage.toLowerCase();

            console.error('Message send failed:', rawMessage || error);

            const isSoftNetworkError =
                normalized.includes('timeout') ||
                normalized.includes('timed out') ||
                normalized.includes('may still be processing') ||
                normalized.includes('being processed') ||
                normalized.includes('failed to fetch') ||
                normalized.includes('networkerror') ||
                normalized.includes('network error') ||
                normalized.includes('gateway timeout') ||
                normalized === 'failed to send message';

            if (normalized.includes('payload too large') || normalized.includes('413') || normalized.includes('entity too large')) {
                toast.error('Attachments are too large to send. Please try reducing the number or size of images.');
                if (allAttachments.length > 0) {
                    useFileStore.setState({ attachedFiles: allAttachments });
                }
                return;
            }

            if (isSoftNetworkError) {
                if (allAttachments.length > 0) {
                    useFileStore.setState({ attachedFiles: allAttachments });
                    toast.error('Failed to send attachments. Try fewer files or smaller images.');
                }
                return;
            }

            if (allAttachments.length > 0) {
                useFileStore.setState({ attachedFiles: allAttachments });
            }
            toast.error(rawMessage || 'Message failed to send. Attachments restored.');
        });

        if (!isMobile) {
            textareaRef.current?.focus();
        }
    };

    handleSubmitRef.current = handleSubmit;

    // Primary action for send button - respects queue mode setting
    const handlePrimaryAction = React.useCallback(() => {
        const canQueue = inputMode === 'normal' && hasContent && currentSessionId && sessionPhase !== 'idle';
        if (queueModeEnabled && canQueue) {
            handleQueueMessage();
        } else {
            void handleSubmitRef.current();
        }
    }, [inputMode, hasContent, currentSessionId, sessionPhase, queueModeEnabled, handleQueueMessage]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
        // Early return during IME composition to prevent interference with autocomplete.
        // Uses keyCode === 229 fallback for WebKit where compositionend fires before keydown.
        if (isIMECompositionEvent(e)) return;

        if (inputMode === 'shell' && e.key === 'Escape') {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        if (inputMode === 'shell' && e.key === 'Backspace' && message.length === 0) {
            e.preventDefault();
            setInputMode('normal');
            return;
        }

        if (showCommandAutocomplete && commandRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                commandRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (showSkillAutocomplete && skillRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                skillRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (showFileMention && mentionRef.current) {
            if (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape' || e.key === 'Tab') {
                e.preventDefault();
                mentionRef.current.handleKeyDown(e.key);
                return;
            }
        }

        if (isDesktopExpanded && e.key === 'Escape') {
            e.preventDefault();
            setExpandedInput(false);
            return;
        }

        if (e.key === 'Tab' && !showCommandAutocomplete && !showFileMention) {
            e.preventDefault();
            handleCycleAgent();
            return;
        }

        // Handle ArrowUp/ArrowDown for message history navigation
        // ArrowUp: only when cursor at start (position 0) or input is empty
        // ArrowDown: also works when cursor at end (to cycle forward through history)
        const isAnyAutocompleteOpen = showCommandAutocomplete || showSkillAutocomplete || showFileMention;
        const cursorAtStart = textareaRef.current?.selectionStart === 0 && textareaRef.current?.selectionEnd === 0;
        const cursorAtEnd = textareaRef.current?.selectionStart === message.length && textareaRef.current?.selectionEnd === message.length;
        const canNavigateHistoryUp = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtStart);
        const canNavigateHistoryDown = !isAnyAutocompleteOpen && (message.length === 0 || cursorAtEnd);

        if (e.key === 'ArrowUp' && canNavigateHistoryUp && userMessageHistory.length > 0) {
            e.preventDefault();
            if (historyIndex === -1) {
                // Entering history mode - save current input as draft
                setDraftMessage(message);
                setHistoryIndex(0);
                setMessage(userMessageHistory[0]);
            } else if (historyIndex < userMessageHistory.length - 1) {
                // Navigate to older message
                const newIndex = historyIndex + 1;
                setHistoryIndex(newIndex);
                setMessage(userMessageHistory[newIndex]);
            }
            // Move cursor to start after history navigation
            requestAnimationFrame(() => {
                textareaRef.current?.setSelectionRange(0, 0);
            });
            // If at oldest message, do nothing
            return;
        }

        if (e.key === 'ArrowDown' && canNavigateHistoryDown && historyIndex >= 0) {
            e.preventDefault();
            if (historyIndex === 0) {
                // Exit history mode - restore draft
                setHistoryIndex(-1);
                setMessage(draftMessage);
                setDraftMessage('');
            } else {
                // Navigate to newer message
                const newIndex = historyIndex - 1;
                setHistoryIndex(newIndex);
                setMessage(userMessageHistory[newIndex]);
            }
            return;
        }

        // Handle Enter/Ctrl+Enter based on queue mode
        if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
            e.preventDefault();

            const isCtrlEnter = e.ctrlKey || e.metaKey;

            // Queue mode: Enter queues, Ctrl+Enter sends
            // Normal mode: Enter sends, Ctrl+Enter queues
            // Note: Queueing only works when there's an existing session (currentSessionId)
            // For new sessions (draft), always send immediately
            const canQueue = inputMode === 'normal' && hasContent && currentSessionId && sessionPhase !== 'idle';

            if (queueModeEnabled) {
                if (isCtrlEnter || !canQueue) {
                    // Ctrl+Enter sends, or Enter when can't queue (new session)
                    handleSubmit();
                } else {
                    // Enter queues when we have a session
                    handleQueueMessage();
                }
            } else {
                if (isCtrlEnter && canQueue) {
                    // Ctrl+Enter queues when we have a session
                    handleQueueMessage();
                } else {
                    // Enter sends
                    handleSubmit();
                }
            }
        }
    };

    const measureCaretInTextarea = React.useCallback((textarea: HTMLTextAreaElement, cursorPosition: number) => {
        const doc = textarea.ownerDocument;
        const win = doc.defaultView;
        if (!win) return null;

        const style = win.getComputedStyle(textarea);
        const mirror = doc.createElement('div');
        const mirrorStyle = mirror.style;

        mirrorStyle.position = 'absolute';
        mirrorStyle.visibility = 'hidden';
        mirrorStyle.pointerEvents = 'none';
        mirrorStyle.whiteSpace = 'pre-wrap';
        mirrorStyle.wordWrap = 'break-word';
        mirrorStyle.overflow = 'hidden';
        mirrorStyle.left = '-9999px';
        mirrorStyle.top = '0';

        mirrorStyle.width = `${textarea.clientWidth}px`;
        mirrorStyle.font = style.font;
        mirrorStyle.fontSize = style.fontSize;
        mirrorStyle.fontFamily = style.fontFamily;
        mirrorStyle.fontWeight = style.fontWeight;
        mirrorStyle.fontStyle = style.fontStyle;
        mirrorStyle.fontVariant = style.fontVariant;
        mirrorStyle.letterSpacing = style.letterSpacing;
        mirrorStyle.textTransform = style.textTransform;
        mirrorStyle.textIndent = style.textIndent;
        mirrorStyle.padding = style.padding;
        mirrorStyle.border = style.border;
        mirrorStyle.boxSizing = style.boxSizing;
        mirrorStyle.lineHeight = style.lineHeight;
        mirrorStyle.tabSize = style.tabSize;

        mirror.textContent = textarea.value.slice(0, cursorPosition);
        const marker = doc.createElement('span');
        marker.textContent = textarea.value.slice(cursorPosition, cursorPosition + 1) || ' ';
        mirror.appendChild(marker);

        doc.body.appendChild(mirror);
        const top = marker.offsetTop;
        const left = marker.offsetLeft;
        doc.body.removeChild(mirror);

        return { top, left };
    }, []);

    const updateAutocompleteOverlayPosition = React.useCallback(() => {
        if (!isDesktopExpanded) {
            setAutocompleteOverlayPosition(null);
            return;
        }

        if (!showCommandAutocomplete && !showSkillAutocomplete && !showFileMention) {
            setAutocompleteOverlayPosition(null);
            return;
        }

        const textarea = textareaRef.current;
        const container = dropZoneRef.current;
        if (!textarea || !container) return;

        const cursor = textarea.selectionStart ?? message.length;
        const caret = measureCaretInTextarea(textarea, cursor);
        if (!caret) return;

        const textareaRect = textarea.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        const caretY = textareaRect.top - containerRect.top + (caret.top - textarea.scrollTop);
        const caretX = textareaRect.left - containerRect.left + (caret.left - textarea.scrollLeft);

        const popupMargin = 8;
        const estimatedPopupHeight = 260;
        const spaceAbove = caretY - popupMargin;
        const spaceBelow = containerRect.height - caretY - popupMargin;
        const place: 'above' | 'below' = spaceBelow >= estimatedPopupHeight || spaceBelow >= spaceAbove ? 'below' : 'above';

        const desiredWidth = showFileMention ? 520 : showCommandAutocomplete ? 450 : 360;
        const clampedLeft = Math.max(
            popupMargin,
            Math.min(caretX - 24, containerRect.width - desiredWidth - popupMargin)
        );

        const maxHeight = Math.max(120, Math.min(estimatedPopupHeight, place === 'below' ? spaceBelow : spaceAbove));

        setAutocompleteOverlayPosition({
            top: place === 'below' ? caretY + 22 : caretY - 6,
            left: clampedLeft,
            place,
            maxHeight,
        });
    }, [
        isDesktopExpanded,
        measureCaretInTextarea,
        message.length,
        showCommandAutocomplete,
        showFileMention,
        showSkillAutocomplete,
    ]);

    React.useLayoutEffect(() => {
        updateAutocompleteOverlayPosition();
    }, [
        updateAutocompleteOverlayPosition,
        message,
        showCommandAutocomplete,
        showSkillAutocomplete,
        showFileMention,
        isDesktopExpanded,
    ]);

    React.useEffect(() => {
        if (!isDesktopExpanded) return;
        const onResize = () => updateAutocompleteOverlayPosition();
        window.addEventListener('resize', onResize);
        return () => {
            window.removeEventListener('resize', onResize);
        };
    }, [isDesktopExpanded, updateAutocompleteOverlayPosition]);

    const startAbortIndicator = React.useCallback(() => {
        if (abortTimeoutRef.current) {
            clearTimeout(abortTimeoutRef.current);
            abortTimeoutRef.current = null;
        }

        setShowAbortStatus(true);

        abortTimeoutRef.current = setTimeout(() => {
            setShowAbortStatus(false);
            abortTimeoutRef.current = null;
        }, 1800);
    }, []);

    const handleAbort = React.useCallback(() => {
        clearAbortPrompt();
        startAbortIndicator();

        void abortCurrentOperation();
    }, [abortCurrentOperation, clearAbortPrompt, startAbortIndicator]);

    const handleCycleAgent = React.useCallback(() => {
        if (primaryAgents.length <= 1) return;

        const currentIndex = primaryAgents.findIndex(agent => agent.name === currentAgentName);
        const nextIndex = (currentIndex + 1) % primaryAgents.length;
        const nextAgent = primaryAgents[nextIndex];

        setAgent(nextAgent.name);

        if (currentSessionId) {
            saveSessionAgentSelection(currentSessionId, nextAgent.name);
        }
    }, [primaryAgents, currentAgentName, currentSessionId, setAgent, saveSessionAgentSelection]);

    const adjustTextareaHeight = React.useCallback(() => {
        const textarea = textareaRef.current;
        if (!textarea) {
            return;
        }

        if (isDesktopExpanded) {
            textarea.style.height = '100%';
            textarea.style.maxHeight = 'none';
            setTextareaSize(null);
            return;
        }

        textarea.style.height = 'auto';

        const view = textarea.ownerDocument?.defaultView;
        const computedStyle = view ? view.getComputedStyle(textarea) : null;
        const lineHeight = computedStyle ? parseFloat(computedStyle.lineHeight) : NaN;
        const paddingTop = computedStyle ? parseFloat(computedStyle.paddingTop) : NaN;
        const paddingBottom = computedStyle ? parseFloat(computedStyle.paddingBottom) : NaN;
        const fallbackLineHeight = 22;
        const fallbackPadding = 16;
        const paddingTotal = Number.isNaN(paddingTop) || Number.isNaN(paddingBottom)
            ? fallbackPadding
            : paddingTop + paddingBottom;
        const targetLineHeight = Number.isNaN(lineHeight) ? fallbackLineHeight : lineHeight;
        const maxHeight = targetLineHeight * MAX_VISIBLE_TEXTAREA_LINES + paddingTotal;
        const scrollHeight = textarea.scrollHeight || textarea.offsetHeight;
        const nextHeight = Math.min(scrollHeight, maxHeight);

        textarea.style.height = `${nextHeight}px`;
        textarea.style.maxHeight = `${maxHeight}px`;

        setTextareaSize((prev) => {
            if (prev && prev.height === nextHeight && prev.maxHeight === maxHeight) {
                return prev;
            }
            return { height: nextHeight, maxHeight };
        });
    }, [isDesktopExpanded]);

    React.useLayoutEffect(() => {
        adjustTextareaHeight();
    }, [adjustTextareaHeight, message, isMobile]);

    const updateAutocompleteState = React.useCallback((value: string, cursorPosition: number) => {
        if (inputMode === 'shell') {
            setShowCommandAutocomplete(false);
            setShowFileMention(false);
            setShowSkillAutocomplete(false);
            return;
        }

        if (value.startsWith('/')) {
            const firstSpace = value.indexOf(' ');
            const firstNewline = value.indexOf('\n');
            const commandEnd = Math.min(
                firstSpace === -1 ? value.length : firstSpace,
                firstNewline === -1 ? value.length : firstNewline
            );

            if (cursorPosition <= commandEnd && firstSpace === -1) {
                const commandText = value.substring(1, commandEnd);
                setCommandQuery(commandText);
                setAutocompleteTab('commands');
                setShowCommandAutocomplete(true);
                setShowFileMention(false);
                setShowSkillAutocomplete(false);
                return;
            }
        }

        setShowCommandAutocomplete(false);

        const textBeforeCursor = value.substring(0, cursorPosition);

        const lastSlashSymbol = textBeforeCursor.lastIndexOf('/');
        if (lastSlashSymbol !== -1) {
            const charBefore = lastSlashSymbol > 0 ? textBeforeCursor[lastSlashSymbol - 1] : null;
            const textAfterSlash = textBeforeCursor.substring(lastSlashSymbol + 1);
            const hasSeparator = textAfterSlash.includes(' ') || textAfterSlash.includes('\n');
            const isWordBoundary = !charBefore || /\s/.test(charBefore);

            if (isWordBoundary && !hasSeparator) {
                setSkillQuery(textAfterSlash);
                setShowSkillAutocomplete(true);
                setShowFileMention(false);
                return;
            }
        }

        setShowSkillAutocomplete(false);
        setSkillQuery('');

        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');
        if (lastAtSymbol !== -1) {
            const charBefore = lastAtSymbol > 0 ? textBeforeCursor[lastAtSymbol - 1] : null;
            const textAfterAt = textBeforeCursor.substring(lastAtSymbol + 1);
            const isWordBoundary = !charBefore || /\s/.test(charBefore);
            if (isWordBoundary && !textAfterAt.includes(' ') && !textAfterAt.includes('\n')) {
                setMentionQuery(textAfterAt);
                setAutocompleteTab('agents');
                setShowFileMention(true);
            } else {
                setShowFileMention(false);
            }
        } else {
            setShowFileMention(false);
        }
    }, [inputMode, setAutocompleteTab, setCommandQuery, setMentionQuery, setShowCommandAutocomplete, setShowFileMention, setShowSkillAutocomplete, setSkillQuery]);

    const applyAutocompletePrefix = React.useCallback((prefix: '/' | '@') => {
        const nextMessage = message.length === 0
            ? prefix
            : (message[0] === '/' || message[0] === '@')
                ? `${prefix}${message.slice(1)}`
                : `${prefix}${message}`;
        setMessage(nextMessage);
        requestAnimationFrame(() => {
            if (textareaRef.current) {
                const nextCursor = Math.min(nextMessage.length, textareaRef.current.value.length);
                textareaRef.current.selectionStart = nextCursor;
                textareaRef.current.selectionEnd = nextCursor;
            }
            adjustTextareaHeight();
            updateAutocompleteState(nextMessage, nextMessage.length);
        });
    }, [adjustTextareaHeight, message, setMessage, updateAutocompleteState]);

    const handleAutocompleteTabSelect = React.useCallback((tab: 'commands' | 'agents' | 'files') => {
        const textarea = textareaRef.current;
        if (isMobile && textarea) {
            try {
                textarea.focus({ preventScroll: true });
            } catch {
                textarea.focus();
            }
            const len = textarea.value.length;
            try {
                textarea.setSelectionRange(len, len);
            } catch {
                // ignored
            }
        }
        setAutocompleteTab(tab);
        setCommandQuery('');
        setMentionQuery('');
        if (tab === 'commands') {
            applyAutocompletePrefix('/');
        }
        if (tab === 'agents') {
            applyAutocompletePrefix('@');
        }
        if (tab === 'files') {
            applyAutocompletePrefix('@');
        }
        setShowSkillAutocomplete(false);
        setShowCommandAutocomplete(tab === 'commands');
        setShowFileMention(tab === 'agents' || tab === 'files');
    }, [applyAutocompletePrefix, isMobile, setAutocompleteTab, setCommandQuery, setMentionQuery, setShowCommandAutocomplete, setShowFileMention, setShowSkillAutocomplete]);

    const handleOpenCommandMenu = React.useCallback(() => {
        if (!isMobile) {
            return;
        }
        const textarea = textareaRef.current;
        if (textarea) {
            try {
                textarea.focus({ preventScroll: true });
            } catch {
                textarea.focus();
            }
            const len = textarea.value.length;
            try {
                textarea.setSelectionRange(len, len);
            } catch {
                // ignored
            }
        }
        applyAutocompletePrefix('/');
        setCommandQuery('');
        setAutocompleteTab('commands');
        setShowCommandAutocomplete(true);
        setShowFileMention(false);
        setShowSkillAutocomplete(false);
    }, [applyAutocompletePrefix, isMobile, setAutocompleteTab, setCommandQuery, setShowCommandAutocomplete, setShowFileMention, setShowSkillAutocomplete]);

    const insertTextAtSelection = React.useCallback((text: string) => {
        if (!text) {
            return;
        }

        const textarea = textareaRef.current;
        if (!textarea) {
            const nextValue = message + text;
            setMessage(nextValue);
            updateAutocompleteState(nextValue, nextValue.length);
            requestAnimationFrame(() => adjustTextareaHeight());
            return;
        }

        const start = textarea.selectionStart ?? message.length;
        const end = textarea.selectionEnd ?? message.length;
        const nextValue = `${message.substring(0, start)}${text}${message.substring(end)}`;
        setMessage(nextValue);
        const cursorPosition = start + text.length;

        requestAnimationFrame(() => {
            const currentTextarea = textareaRef.current;
            if (currentTextarea) {
                currentTextarea.selectionStart = cursorPosition;
                currentTextarea.selectionEnd = cursorPosition;
            }
            adjustTextareaHeight();
        });

        updateAutocompleteState(nextValue, cursorPosition);
    }, [adjustTextareaHeight, message, updateAutocompleteState]);

    const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const value = e.target.value;
        const cursorPosition = e.target.selectionStart ?? value.length;

        if (inputMode === 'normal' && value.startsWith('!')) {
            const shellCommand = value.slice(1);
            const nextCursor = Math.max(0, cursorPosition - 1);
            setInputMode('shell');
            setMessage(shellCommand);
            adjustTextareaHeight();
            setShowCommandAutocomplete(false);
            setShowSkillAutocomplete(false);
            setShowFileMention(false);
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
            });
            return;
        }

        setMessage(value);
        adjustTextareaHeight();
        updateAutocompleteState(value, cursorPosition);
    };

    const handlePaste = React.useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
        const fileMap = new Map<string, File>();

        Array.from(e.clipboardData.files || []).forEach(file => {
            if (file.type.startsWith('image/')) {
                fileMap.set(`${file.name}-${file.size}`, file);
            }
        });

        Array.from(e.clipboardData.items || []).forEach(item => {
            if (item.kind === 'file' && item.type.startsWith('image/')) {
                const file = item.getAsFile();
                if (file) {
                    fileMap.set(`${file.name}-${file.size}`, file);
                }
            }
        });

        const imageFiles = Array.from(fileMap.values());
        if (imageFiles.length === 0) {
            return;
        }

        if (!currentSessionId && !newSessionDraftOpen) {
            return;
        }

        e.preventDefault();

        const pastedText = e.clipboardData.getData('text');
        if (pastedText) {
            insertTextAtSelection(pastedText);
        }

        let attachedCount = 0;

        for (const file of imageFiles) {
            const sizeBefore = useSessionStore.getState().attachedFiles.length;
            try {
                await addAttachedFile(file);
                const sizeAfter = useSessionStore.getState().attachedFiles.length;
                if (sizeAfter > sizeBefore) {
                    attachedCount += 1;
                }
            } catch (error) {
                console.error('Clipboard image attach failed', error);
                toast.error(error instanceof Error ? error.message : 'Failed to attach image from clipboard');
            }
        }

        if (attachedCount > 0) {
            toast.success(`Attached ${attachedCount} image${attachedCount > 1 ? 's' : ''} from clipboard`);
        }
    }, [addAttachedFile, currentSessionId, newSessionDraftOpen, insertTextAtSelection]);

    const handleFileSelect = (file: { name: string; path: string }) => {

        const cursorPosition = textareaRef.current?.selectionStart || 0;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                file.name +
                message.substring(cursorPosition);
            setMessage(newMessage);
        } else if (textareaRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${file.name} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);
            const nextCursor = cursorPosition + file.name.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        setShowFileMention(false);
        setMentionQuery('');

        textareaRef.current?.focus();
    };

    const handleAgentSelect = (agentName: string) => {
        const textarea = textareaRef.current;
        const cursorPosition = textarea?.selectionStart ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastAtSymbol = textBeforeCursor.lastIndexOf('@');

        if (lastAtSymbol !== -1) {
            const newMessage =
                message.substring(0, lastAtSymbol) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastAtSymbol + agentName.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        } else if (textareaRef.current) {
            const newMessage =
                message.substring(0, cursorPosition) +
                `@${agentName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = cursorPosition + agentName.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        setShowFileMention(false);
        setMentionQuery('');

        textareaRef.current?.focus();
    };

    const handleSkillSelect = (skillName: string) => {
        const textarea = textareaRef.current;
        const cursorPosition = textarea?.selectionStart ?? message.length;
        const textBeforeCursor = message.substring(0, cursorPosition);
        const lastSlashSymbol = textBeforeCursor.lastIndexOf('/');

        if (lastSlashSymbol !== -1) {
            const newMessage =
                message.substring(0, lastSlashSymbol) +
                `/${skillName} ` +
                message.substring(cursorPosition);
            setMessage(newMessage);

            const nextCursor = lastSlashSymbol + skillName.length + 2;
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.selectionStart = nextCursor;
                    textareaRef.current.selectionEnd = nextCursor;
                }
                adjustTextareaHeight();
                updateAutocompleteState(newMessage, nextCursor);
            });
        }

        setShowSkillAutocomplete(false);
        setSkillQuery('');

        textareaRef.current?.focus();
    };

    const handleCommandSelect = (command: { name: string; description?: string; agent?: string; model?: string }) => {

        setMessage(`/${command.name} `);

        const textareaElement = textareaRef.current as HTMLTextAreaElement & { _commandMetadata?: typeof command };
        if (textareaElement) {
            textareaElement._commandMetadata = command;
        }

        setShowCommandAutocomplete(false);
        setCommandQuery('');

        const refocus = () => {
            if (textareaRef.current) {
                try {
                    textareaRef.current.focus({ preventScroll: true });
                } catch {
                    textareaRef.current.focus();
                }
                textareaRef.current.setSelectionRange(textareaRef.current.value.length, textareaRef.current.value.length);
            }
        };

        requestAnimationFrame(() => {
            refocus();
            requestAnimationFrame(refocus);
        });
        setTimeout(refocus, 60);
    };

    React.useEffect(() => {

        if (currentSessionId && textareaRef.current && !isMobile) {
            textareaRef.current.focus();
        }
    }, [currentSessionId, isMobile]);

    React.useEffect(() => {
        if (!isMobile) {
            setMobileControlsOpen(false);
            setMobileControlsPanel(null);
        }
    }, [isMobile]);

    React.useEffect(() => {
        if (abortPromptSessionId && abortPromptSessionId !== currentSessionId) {
            clearAbortPrompt();
        }
    }, [abortPromptSessionId, currentSessionId, clearAbortPrompt]);

    React.useEffect(() => {
        canAcceptDropRef.current = Boolean(currentSessionId || newSessionDraftOpen);
    }, [currentSessionId, newSessionDraftOpen]);

    const hasDraggedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): boolean => {
        if (!dataTransfer) return false;
        if (dataTransfer.files && dataTransfer.files.length > 0) return true;
        if (dataTransfer.types) {
            const types = Array.from(dataTransfer.types);
            if (types.includes('Files')) return true;
            if (types.includes('text/uri-list')) return true;
        }

        const uriList = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain');
        return typeof uriList === 'string' && uriList.toLowerCase().includes('file://');
    }, []);

    const collectDroppedFiles = React.useCallback((dataTransfer: DataTransfer | null | undefined): File[] => {
        if (!dataTransfer) return [];

        const directFiles = Array.from(dataTransfer.files || []);
        if (directFiles.length > 0) {
            return directFiles;
        }

        const fromItems = Array.from(dataTransfer.items || [])
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => Boolean(file));

        return fromItems;
    }, []);

    const collectDroppedFileUris = React.useCallback((dataTransfer: DataTransfer | null | undefined): string[] => {
        if (!dataTransfer || typeof dataTransfer.getData !== 'function') return [];

        const rawUriList = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain');
        if (!rawUriList) return [];

        const candidates = rawUriList
            .split(/\r?\n/)
            .map((value) => value.trim())
            .filter((value) => value.length > 0 && !value.startsWith('#'))
            .filter((value) => value.toLowerCase().startsWith('file://'));

        return Array.from(new Set(candidates));
    }, []);

    const attachVSCodeDroppedUris = React.useCallback(async (uris: string[]) => {
        if (uris.length === 0) return;

        try {
            const response = await fetch('/api/vscode/drop-files', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ uris }),
            });

            if (!response.ok) {
                throw new Error(`Failed to attach dropped files (${response.status})`);
            }

            const data = await response.json();
            const picked = Array.isArray(data?.files) ? data.files : [];
            const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

            if (skipped.length > 0) {
                const summary = skipped
                    .map((entry: { name?: string; reason?: string }) => `${entry?.name || 'file'}: ${entry?.reason || 'skipped'}`)
                    .join('\n');
                toast.error(`Some dropped files were skipped:\n${summary}`);
            }

            let attachedCount = 0;
            for (const file of picked as Array<{ name: string; mimeType?: string; dataUrl?: string }>) {
                if (!file?.dataUrl) continue;

                const sizeBefore = useSessionStore.getState().attachedFiles.length;
                try {
                    const [meta, base64] = file.dataUrl.split(',');
                    const mime = file.mimeType || (meta?.match(/data:(.*);base64/)?.[1] || 'application/octet-stream');
                    if (!base64) continue;

                    const binary = atob(base64);
                    const bytes = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i++) {
                        bytes[i] = binary.charCodeAt(i);
                    }

                    const blob = new Blob([bytes], { type: mime });
                    const localFile = new File([blob], file.name || 'file', { type: mime });
                    await addAttachedFile(localFile);

                    const sizeAfter = useSessionStore.getState().attachedFiles.length;
                    if (sizeAfter > sizeBefore) {
                        attachedCount += 1;
                    }
                } catch (error) {
                    console.error('Dropped file attach failed', error);
                    toast.error(error instanceof Error ? error.message : 'Failed to attach dropped file');
                }
            }

            if (attachedCount > 0) {
                toast.success(`Attached ${attachedCount} file${attachedCount > 1 ? 's' : ''}`);
            }
        } catch (error) {
            console.error('VS Code dropped file attach failed', error);
            toast.error(error instanceof Error ? error.message : 'Failed to attach dropped files');
        }
    }, [addAttachedFile]);

    const normalizeDroppedPath = React.useCallback((rawPath: string): string => {
        const input = rawPath.trim();
        if (!input.toLowerCase().startsWith('file://')) {
            return input;
        }

        try {
            let pathname = decodeURIComponent(new URL(input).pathname || '');
            if (/^\/[A-Za-z]:\//.test(pathname)) {
                pathname = pathname.slice(1);
            }
            return pathname || input;
        } catch {
            const stripped = input.replace(/^file:\/\//i, '');
            try {
                return decodeURIComponent(stripped);
            } catch {
                return stripped;
            }
        }
    }, []);

    const handleDragEnter = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragOver = (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        if ((currentSessionId || newSessionDraftOpen) && !isDragging) {
            setIsDragging(true);
        }
    };

    const handleDragLeave = (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.currentTarget === e.target) {
            setIsDragging(false);
        }
    };

    const handleDrop = async (e: React.DragEvent) => {
        if (!hasDraggedFiles(e.dataTransfer)) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        setIsDragging(false);

        if (!currentSessionId && !newSessionDraftOpen) return;

        const files = collectDroppedFiles(e.dataTransfer);

        if (files.length === 0 && isVSCodeRuntime()) {
            const droppedUris = collectDroppedFileUris(e.dataTransfer);
            if (droppedUris.length > 0) {
                await attachVSCodeDroppedUris(droppedUris);
            }
            return;
        }

        let attachedCount = 0;

        if (files.length > 0) {
            for (const file of files) {
                const sizeBefore = useSessionStore.getState().attachedFiles.length;
                try {
                    await addAttachedFile(file);
                    const sizeAfter = useSessionStore.getState().attachedFiles.length;
                    if (sizeAfter > sizeBefore) {
                        attachedCount += 1;
                    }
                } catch (error) {
                    console.error('File attach failed', error);
                    toast.error(error instanceof Error ? error.message : 'Failed to attach file');
                }
            }
        }

        if (attachedCount > 0) {
            toast.success(`Attached ${attachedCount} file${attachedCount > 1 ? 's' : ''}`);
        }
    };

    // Tauri desktop: handle native file drops via onDragDropEvent
    React.useEffect(() => {
        if (!isTauriShell()) return;
        let cancelled = false;
        let unlisten: (() => void) | null = null;

        void (async () => {
            try {
                const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
                const webviewWindow = getCurrentWebviewWindow();
                const removeListener = await webviewWindow.onDragDropEvent(async (event) => {
                    if (!canAcceptDropRef.current) return;

                    const payload = (event as { payload?: unknown }).payload;
                    if (!payload || typeof payload !== 'object') return;

                    const typed = payload as { type?: string; paths?: string[]; position?: { x?: number; y?: number } };
                    const type = typed.type;
                    const x = typed.position?.x;
                    const y = typed.position?.y;

                    // Check if drop is inside the chat input area
                    const zone = dropZoneRef.current;
                    let inZone = false;
                    if (zone && typeof x === 'number' && typeof y === 'number') {
                        const rect = zone.getBoundingClientRect();
                        inZone = x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
                        // Handle retina displays where Tauri might report physical pixels
                        if (!inZone && window.devicePixelRatio > 1) {
                            const sx = x / window.devicePixelRatio;
                            const sy = y / window.devicePixelRatio;
                            inZone = sx >= rect.left && sx <= rect.right && sy >= rect.top && sy <= rect.bottom;
                        }
                    }

                    if (type === 'enter' || type === 'over') {
                        setIsDragging(inZone);
                        return;
                    }
                    if (type === 'leave') {
                        setIsDragging(false);
                        return;
                    }
                    if (type === 'drop') {
                        setIsDragging(false);
                        if (!inZone) return;

                        const paths = Array.isArray(typed.paths)
                            ? typed.paths.filter((p): p is string => typeof p === 'string')
                            : [];
                        if (paths.length === 0) return;

                        let attachedCount = 0;
                        for (const path of paths) {
                            const sizeBefore = useSessionStore.getState().attachedFiles.length;
                            try {
                                const normalizedPath = normalizeDroppedPath(path);
                                const fileName = normalizedPath.split(/[\\/]/).pop() || normalizedPath;
                                let file: File;

                                // In desktop shell on remote origin, local file paths are not readable via /api/fs/raw.
                                // Read bytes from local machine via Tauri command.
                                if (isTauriShell() && !isDesktopLocalOriginActive()) {
                                    const { invoke } = await import('@tauri-apps/api/core');
                                    const result = await invoke<{ mime: string; base64: string }>('desktop_read_file', { path: normalizedPath });
                                    const byteCharacters = atob(result.base64);
                                    const byteNumbers = new Array(byteCharacters.length);
                                    for (let i = 0; i < byteCharacters.length; i++) {
                                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                                    }
                                    const byteArray = new Uint8Array(byteNumbers);
                                    const blob = new Blob([byteArray], { type: result.mime || 'application/octet-stream' });
                                    file = new File([blob], fileName, { type: result.mime || 'application/octet-stream' });
                                } else {
                                    const response = await fetch(`/api/fs/raw?path=${encodeURIComponent(normalizedPath)}`);
                                    if (!response.ok) {
                                        throw new Error(`Failed to read dropped file (${response.status})`);
                                    }
                                    const blob = await response.blob();
                                    file = new File([blob], fileName, { type: blob.type || 'application/octet-stream' });
                                }

                                await addAttachedFile(file);
                                const sizeAfter = useSessionStore.getState().attachedFiles.length;
                                if (sizeAfter > sizeBefore) attachedCount++;
                            } catch (error) {
                                console.error('Failed to attach dropped file:', path, error);
                                toast.error(`Failed to attach ${path.split(/[\\/]/).pop() || 'file'}`);
                            }
                        }
                        if (attachedCount > 0) {
                            toast.success(`Attached ${attachedCount} file${attachedCount > 1 ? 's' : ''}`);
                        }
                    }
                });

                if (cancelled) {
                    removeListener();
                    return;
                }
                unlisten = removeListener;
            } catch (error) {
                if (!cancelled) {
                    console.warn('Failed to register Tauri drag-drop listener:', error);
                }
            }
        })();

        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, [addAttachedFile, normalizeDroppedPath]);

    const handleServerFilesSelected = React.useCallback(async (files: Array<{ path: string; name: string }>) => {
        let attachedCount = 0;

        for (const file of files) {
            const sizeBefore = useSessionStore.getState().attachedFiles.length;
            try {
                await addServerFile(file.path, file.name);
                const sizeAfter = useSessionStore.getState().attachedFiles.length;
                if (sizeAfter > sizeBefore) {
                    attachedCount += 1;
                }
            } catch (error) {
                console.error('Server file attach failed', error);
                toast.error(error instanceof Error ? error.message : 'Failed to attach file');
            }
        }

        if (attachedCount > 0) {
            toast.success(`Attached ${attachedCount} file${attachedCount > 1 ? 's' : ''}`);
        }
    }, [addServerFile]);

    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const [projectFilePickerOpen, setProjectFilePickerOpen] = React.useState(false);

    const attachFiles = React.useCallback(async (files: FileList | File[]) => {
        let attachedCount = 0;
        const list = Array.isArray(files) ? files : Array.from(files);

        for (const file of list) {
            const sizeBefore = useSessionStore.getState().attachedFiles.length;
            try {
                await addAttachedFile(file);
                const sizeAfter = useSessionStore.getState().attachedFiles.length;
                if (sizeAfter > sizeBefore) {
                    attachedCount += 1;
                }
            } catch (error) {
                console.error('File attach failed', error);
                toast.error(error instanceof Error ? error.message : 'Failed to attach file');
            }
        }

        if (attachedCount > 0) {
            toast.success(`Attached ${attachedCount} file${attachedCount > 1 ? 's' : ''}`);
        }
    }, [addAttachedFile]);

    const handleVSCodePickFiles = React.useCallback(async () => {
        try {
            const response = await fetch('/api/vscode/pick-files');
            const data = await response.json();
            const picked = Array.isArray(data?.files) ? data.files : [];
            const skipped = Array.isArray(data?.skipped) ? data.skipped : [];

            if (skipped.length > 0) {
                const summary = skipped
                    .map((s: { name?: string; reason?: string }) => `${s?.name || 'file'}: ${s?.reason || 'skipped'}`)
                    .join('\n');
                toast.error(`Some files were skipped:\n${summary}`);
            }

            const asFiles = picked
                .map((file: { name: string; mimeType?: string; dataUrl?: string }) => {
                    if (!file?.dataUrl) return null;
                    try {
                        const [meta, base64] = file.dataUrl.split(',');
                        const mime = file.mimeType || (meta?.match(/data:(.*);base64/)?.[1] || 'application/octet-stream');
                        if (!base64) return null;
                        const binary = atob(base64);
                        const bytes = new Uint8Array(binary.length);
                        for (let i = 0; i < binary.length; i++) {
                            bytes[i] = binary.charCodeAt(i);
                        }
                        const blob = new Blob([bytes], { type: mime });
                        return new File([blob], file.name || 'file', { type: mime });
                    } catch (err) {
                        console.error('Failed to decode VS Code picked file', err);
                        return null;
                    }
                })
                .filter(Boolean) as File[];

            if (asFiles.length > 0) {
                await attachFiles(asFiles);
            }
        } catch (error) {
            console.error('VS Code file pick failed', error);
            toast.error(error instanceof Error ? error.message : 'Failed to pick files in VS Code');
        }
    }, [attachFiles]);

    const handlePickLocalFiles = React.useCallback(() => {
        if (isVSCodeRuntime()) {
            void handleVSCodePickFiles();
            return;
        }
        fileInputRef.current?.click();
    }, [handleVSCodePickFiles]);

    const handleLocalFileSelect = React.useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files) return;
        await attachFiles(files);
        event.target.value = '';
    }, [attachFiles]);

    const footerGapClass = 'gap-x-1.5 gap-y-0';
    const isVSCode = isVSCodeRuntime();
    const footerPaddingClass = isMobile ? 'px-1.5 py-1.5' : (isVSCode ? 'px-1.5 py-1' : 'px-2.5 py-1.5');
    const buttonSizeClass = isMobile ? 'h-8 w-8' : (isVSCode ? 'h-5 w-5' : 'h-6 w-6');
    const sendIconSizeClass = isMobile ? 'h-4 w-4' : (isVSCode ? 'h-3.5 w-3.5' : 'h-4 w-4');
    const stopIconSizeClass = isMobile ? 'h-6 w-6' : (isVSCode ? 'h-4 w-4' : 'h-5 w-5');
    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : (isVSCode ? 'h-4 w-4' : 'h-[18px] w-[18px]');

    const iconButtonBaseClass = 'flex items-center justify-center text-foreground transition-none outline-none focus:outline-none flex-shrink-0';
    const footerIconButtonClass = cn(iconButtonBaseClass, buttonSizeClass);

    // Send button - respects queue mode setting
    const sendButton = (
        <button
            type={isMobile ? 'button' : 'submit'}
            disabled={!canSend || (!currentSessionId && !newSessionDraftOpen)}
            onClick={(event) => {
                if (!isMobile) {
                    return;
                }

                event.preventDefault();
                handlePrimaryAction();
            }}
            className={cn(
                footerIconButtonClass,
                canSend && (currentSessionId || newSessionDraftOpen)
                    ? 'text-primary hover:text-primary'
                    : 'opacity-30'
            )}
            aria-label="Send message"
        >
            <RiSendPlane2Line className={cn(sendIconSizeClass)} />
        </button>
    );

    // Queue button for adding message to queue while working
    const queueButton = (
        <button
            type="button"
            disabled={!hasContent || !currentSessionId}
            onClick={(event) => {
                if (isMobile) {
                    event.preventDefault();
                }
                handleQueueMessage();
            }}
            className={cn(
                footerIconButtonClass,
                'absolute bottom-full left-1/2 -translate-x-1/2 mb-1',
                hasContent && currentSessionId
                    ? 'text-primary hover:text-primary'
                    : 'opacity-30'
            )}
            aria-label="Queue message"
        >
            <RiSendPlane2Line className={cn(sendIconSizeClass, '-rotate-90')} />
        </button>
    );

    // Stop button replaces send button when working
    const stopButton = (
        <button
            type="button"
            onClick={handleAbort}
            className={cn(
                footerIconButtonClass,
                'text-[var(--status-error)] hover:text-[var(--status-error)]'
            )}
            aria-label="Stop generating"
        >
            <StopIcon className={cn(stopIconSizeClass)} />
        </button>
    );

    // Action buttons area: either send button, or stop (+ optional queue button floating above)
    const actionButtons = canAbort ? (
        <div className="relative">
            {hasContent && queueButton}
            {stopButton}
        </div>
    ) : (
        sendButton
    );

    const attachmentMenu = (
        <>
            <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleLocalFileSelect}
                accept="*/*"
            />

            <div className="relative inline-flex">
                <ServerFilePicker
                    onFilesSelected={handleServerFilesSelected}
                    multiSelect
                    presentation={isMobile ? 'modal' : 'dropdown'}
                    open={projectFilePickerOpen}
                    onOpenChange={setProjectFilePickerOpen}
                >
                    {isMobile ? null : (
                        <button
                            type="button"
                            tabIndex={-1}
                            aria-hidden="true"
                            className="absolute inset-0 opacity-0 pointer-events-none"
                        />
                    )}
                </ServerFilePicker>

                <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                        <button
                            type="button"
                            className={footerIconButtonClass}
                            title="Add attachment"
                            aria-label="Add attachment"
                        >
                            <RiAddCircleLine className={cn(iconSizeClass, 'text-current')} />
                        </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                        <DropdownMenuItem
                            onSelect={() => {
                                requestAnimationFrame(() => handlePickLocalFiles());
                            }}
                        >
                            <RiAttachment2 />
                            Attach files
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            onSelect={() => {
                                requestAnimationFrame(() => {
                                    setProjectFilePickerOpen(true);
                                });
                            }}
                        >
                            <RiFileUploadLine />
                            Attach from project
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            </div>
        </>
    );

    const settingsButton = onOpenSettings ? (
        <button
            type='button'
            onClick={onOpenSettings}
            className={footerIconButtonClass}
            title='Model and agent settings'
            aria-label='Model and agent settings'
        >
            <RiAiAgentLine className={cn(iconSizeClass, 'text-current')} />
        </button>
    ) : null;

    const attachmentsControls = (
        <div className="flex items-center gap-x-1.5">
            {isMobile ? (
                <button
                    type="button"
                    className={cn(
                        footerIconButtonClass,
                        'rounded-md',
                        'hover:bg-interactive-hover/40'
                    )}
                    onPointerDownCapture={(event) => {
                        if (event.pointerType === 'touch') {
                            event.preventDefault();
                            event.stopPropagation();
                        }
                    }}
                    onClick={handleOpenCommandMenu}
                    title="Commands"
                    aria-label="Commands"
                >
                    <RiCommandLine className={cn(iconSizeClass)} />
                </button>
            ) : null}
            {attachmentMenu}
            {settingsButton}
        </div>
    );

    const workingStatusText = working.statusText;

    React.useEffect(() => {
        const pendingAbortBanner = Boolean(working.wasAborted);
        if (!prevWasAbortedRef.current && pendingAbortBanner && !showAbortStatus) {
            startAbortIndicator();
            if (currentSessionId) {
                acknowledgeSessionAbort(currentSessionId);
            }
        }
        prevWasAbortedRef.current = pendingAbortBanner;
    }, [
        acknowledgeSessionAbort,
        currentSessionId,
        showAbortStatus,
        startAbortIndicator,
        working.wasAborted,
    ]);

    React.useEffect(() => {
        return () => {
            if (abortTimeoutRef.current) {
                clearTimeout(abortTimeoutRef.current);
                abortTimeoutRef.current = null;
            }
        };
    }, []);

    return (
        <>
        <form
            onSubmit={(e) => { e.preventDefault(); handlePrimaryAction(); }}
            className={cn(
                "relative pt-0 pb-4",
                isDesktopExpanded && 'flex h-full min-h-0 flex-col pt-4',
                isMobile && isKeyboardOpen ? "ios-keyboard-safe-area" : "bottom-safe-area"
            )}
            data-keyboard-avoid="true"
            style={isMobile && inputBarOffset > 0 && !isKeyboardOpen ? { marginBottom: `${inputBarOffset}px` } : undefined}
        >
            {/* Absolute positioned above input - no layout shift */}
            <div className="absolute bottom-full left-0 right-0">
                <StatusRow
                    isWorking={working.isWorking}
                    statusText={workingStatusText}
                    isGenericStatus={working.isGenericStatus}
                    isWaitingForPermission={working.isWaitingForPermission}
                    wasAborted={working.wasAborted}
                    abortActive={working.abortActive}
                    retryInfo={working.retryInfo}
                    showAbortStatus={showAbortStatus}
                />
            </div>
            <div className={cn('chat-column relative overflow-visible', isDesktopExpanded && 'flex flex-1 min-h-0 flex-col')}>
                <AttachedFilesList />
                <QueuedMessageChips
                    onEditMessage={(content) => {
                        setMessage(content);
                        setTimeout(() => {
                            textareaRef.current?.focus();
                        }, 0);
                    }}
                />
                {hasDrafts && (
                    <div className="pb-2">
                        <div
                            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl border"
                            style={{
                                backgroundColor: currentTheme?.colors?.surface?.elevated,
                                borderColor: currentTheme?.colors?.interactive?.border,
                            }}
                        >
                            <span className="text-xs font-medium text-muted-foreground">Review comments:</span>
                            <span className="text-xs font-semibold" style={{ color: currentTheme?.colors?.status?.info }}>
                                {draftCount}
                            </span>
                        </div>
                    </div>
                )}
                <div
                    className={cn(
                        "flex flex-col relative overflow-visible",
                        isDesktopExpanded && 'flex-1 min-h-0',
                        "border border-border/80",
                        "focus-within:ring-1",
                        inputMode === 'shell'
                            ? 'focus-within:ring-[var(--status-info)]'
                            : 'focus-within:ring-primary/50',
                        isDragging && "ring-2 ring-primary ring-offset-2"
                    )}
                    style={{
                        borderRadius: cornerRadius,
                        backgroundColor: currentTheme?.colors?.surface?.subtle,
                    }}
                    ref={dropZoneRef}
                    onDragEnter={handleDragEnter}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                >
                    {isDragging && (
                        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-xl">
                            <div className="text-center">
                                <div className="inline-flex justify-center">
                                    <button
                                        type="button"
                                        className={iconButtonBaseClass}
                                        onClick={() => handlePickLocalFiles()}
                                        title="Attach files"
                                        aria-label="Attach files"
                                    >
                                        <RiAttachment2 className={cn(iconSizeClass, 'text-current')} />
                                    </button>
                                </div>
                                <p className="mt-2 typography-ui-label text-muted-foreground">Drop files here to attach</p>
                            </div>
                        </div>
                    )}

                    {showCommandAutocomplete && (
                        <CommandAutocomplete
                            ref={commandRef}
                            searchQuery={commandQuery}
                            onCommandSelect={handleCommandSelect}
                            showTabs={isMobile}
                            activeTab={autocompleteTab}
                            onTabSelect={handleAutocompleteTabSelect}
                            onClose={() => setShowCommandAutocomplete(false)}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(450px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}
                    { }
                    {showSkillAutocomplete && (
                        <SkillAutocomplete
                            ref={skillRef}
                            searchQuery={skillQuery}
                            onSkillSelect={handleSkillSelect}
                            onClose={() => setShowSkillAutocomplete(false)}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(360px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}

                    {showFileMention && (

                        <FileMentionAutocomplete
                            ref={mentionRef}
                            searchQuery={mentionQuery}
                            onFileSelect={handleFileSelect}
                            onAgentSelect={handleAgentSelect}
                            showTabs={isMobile}
                            activeTab={autocompleteTab}
                            onTabSelect={handleAutocompleteTabSelect}
                            onClose={() => setShowFileMention(false)}
                            style={isDesktopExpanded && autocompleteOverlayPosition
                                ? {
                                    left: `${autocompleteOverlayPosition.left}px`,
                                    top: `${autocompleteOverlayPosition.top}px`,
                                    bottom: 'auto',
                                    width: `min(520px, calc(100% - ${autocompleteOverlayPosition.left + 8}px))`,
                                    maxHeight: `${autocompleteOverlayPosition.maxHeight}px`,
                                    transform: autocompleteOverlayPosition.place === 'above' ? 'translateY(-100%)' : undefined,
                                }
                                : undefined}
                        />
                    )}
                    <Textarea
                        ref={textareaRef}
                        data-chat-input="true"
                        value={message}
                        onChange={handleTextChange}
                        onKeyDown={handleKeyDown}
                        onPaste={handlePaste}
                        onDragEnter={handleDragEnter}
                        onDragOver={handleDragOver}
                        onDrop={handleDrop}
                        onPointerDownCapture={handleTextareaPointerDownCapture}
                        onKeyUp={updateAutocompleteOverlayPosition}
                        onClick={updateAutocompleteOverlayPosition}
                        onScroll={updateAutocompleteOverlayPosition}
                        onSelect={updateAutocompleteOverlayPosition}
                        placeholder={currentSessionId || newSessionDraftOpen
                            ? inputMode === 'shell'
                                ? "Enter shell command..."
                                : "@ for files/agents; / for commands; ! for shell"
                            : "Select or create a session to start chatting"}
                        disabled={!currentSessionId && !newSessionDraftOpen}
                        autoCorrect={isMobile ? "on" : "off"}
                        autoCapitalize={isMobile ? "sentences" : "off"}
                        spellCheck={isMobile}
                        outerClassName={cn('focus-within:ring-0', isDesktopExpanded && 'flex-1 min-h-0')}
                        className={cn(
                            'min-h-[52px] resize-none border-0 px-3 rounded-b-none appearance-none hover:border-transparent bg-transparent',
                            isDesktopExpanded
                                ? 'h-full min-h-0 py-4'
                                : isMobile
                                    ? 'py-2.5'
                                    : 'pt-4 pb-2',
                            inputMode === 'shell' && 'font-mono',
                        )}
                        style={{
                            flex: isDesktopExpanded ? '1 1 auto' : 'none',
                            height: !isDesktopExpanded && textareaSize ? `${textareaSize.height}px` : undefined,
                            maxHeight: !isDesktopExpanded && textareaSize ? `${textareaSize.maxHeight}px` : undefined,
                            borderTopLeftRadius: cornerRadius,
                            borderTopRightRadius: cornerRadius,
                        }}
                        rows={1}
                    />
                    <div
                        className={cn(
                            'bg-transparent',
                            footerPaddingClass,
                            isMobile ? 'flex items-center gap-x-1.5' : cn('flex items-center justify-between', footerGapClass)
                        )}
                        style={{
                            borderBottomLeftRadius: cornerRadius,
                            borderBottomRightRadius: cornerRadius,
                        }}
                        data-chat-input-footer="true"
                    >
                        {isMobile ? (
                            <>
                                <div className="flex w-full items-center justify-between gap-x-1.5">
                                    <div className="flex items-center gap-x-1">
                                        {attachmentsControls}
                                    </div>
                                    <div className="flex items-center min-w-0 gap-x-1 justify-end">
                                        <div className="flex items-center gap-x-1 min-w-0 max-w-[60vw] flex-shrink">
                                            <MobileModelButton onOpenModel={handleOpenMobileControls} className="min-w-0 flex-shrink" />
                                            <MobileAgentButton
                                                onOpenAgentPanel={() => setMobileControlsPanel('agent')}
                                                onCycleAgent={handleCycleAgent}
                                                className="min-w-0 flex-shrink"
                                            />
                                        </div>
                                        <div className="flex items-center gap-x-1 flex-shrink-0">
                                            <BrowserVoiceButton />
                                            {actionButtons}
                                        </div>
                                    </div>
                                </div>
                                <ModelControls
                                    className="hidden"
                                    mobilePanel={mobileControlsPanel}
                                    onMobilePanelChange={setMobileControlsPanel}
                                    onMobilePanelSelection={handleReturnToUnifiedControls}
                                    onAgentPanelSelection={() => setMobileControlsPanel(null)}
                                />
                                <UnifiedControlsDrawer
                                    open={mobileControlsOpen}
                                    onClose={handleCloseMobileControls}
                                    onOpenModel={() => handleOpenMobilePanel('model')}
                                    onOpenEffort={() => handleOpenMobilePanel('variant')}
                                />
                            </>
                        ) : (
                            <>
                                <div className={cn("flex items-center flex-shrink-0", footerGapClass)}>
                                    {attachmentsControls}
                                    <Tooltip delayDuration={600}>
                                        <TooltipTrigger asChild>
                                            <button
                                                type="button"
                                                className={cn(
                                                    footerIconButtonClass,
                                                    'rounded-md',
                                                    isExpandedInput
                                                        ? 'text-primary'
                                                        : 'text-foreground hover:bg-[var(--interactive-hover)]/40'
                                                )}
                                                onMouseDown={(event) => {
                                                    event.preventDefault();
                                                }}
                                                onClick={() => setExpandedInput(!isExpandedInput)}
                                                aria-label="Toggle focus mode"
                                                aria-pressed={isExpandedInput}
                                            >
                                                <RiFullscreenLine className={cn(iconSizeClass)} />
                                            </button>
                                        </TooltipTrigger>
                                        <TooltipContent side="top" sideOffset={8}>
                                            <div className="flex flex-col gap-0.5 text-center">
                                                <span>Focus mode</span>
                                                <span className="font-mono opacity-60">
                                                    {isMacOS() ? '⌘⇧E' : 'Ctrl+Shift+E'}
                                                </span>
                                            </div>
                                        </TooltipContent>
                                    </Tooltip>
                                </div>
                                <div className={cn('flex items-center flex-1 justify-end', footerGapClass, 'md:gap-x-3')}>
                                    <ModelControls className={cn('flex-1 min-w-0 justify-end')} />
                                    <BrowserVoiceButton />
                                    {actionButtons}
                                </div>
                            </>
                        )}
                    </div>

                    {/* Mobile Session Status Bar - above input */}
                    {isMobile && <MobileSessionStatusBar cornerRadius={cornerRadius} />}
                </div>
            </div>
        </form>
        </>
    );
};
