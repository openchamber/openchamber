import React from 'react';
import type { Message, Part, ToolPart } from '@opencode-ai/sdk/v2';
import { z } from 'zod';

import { useDirectorySync, useSessionMessages, useSessionStatus } from '@/sync/sync-context';
import { getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import type { State } from '@/sync/types';
import { getSessionLastAssistantModel } from '@/sync/session-actions';
import { useUIStore } from '@/stores/useUIStore';
import { requestSmallModel } from '@/lib/smallModelRequest';

const LIVE_PROGRESS_SUMMARY_INTERVAL_MS = 30_000;
const COMMAND_PROGRESS_SUMMARY_DELAY_MS = 750;

const PROGRESS_CONTEXT_CHAR_LIMIT = 12_000;
const COMMAND_CONTEXT_CHAR_LIMIT = 6_000;
const PROGRESS_PART_CHAR_LIMIT = 1_800;
const PROGRESS_SUMMARY_CHAR_LIMIT = 480;
const COMMAND_SUMMARY_CHAR_LIMIT = 220;

const PROGRESS_SUMMARY_SYSTEM_PROMPT = [
    'You are a live progress reporter for a coding agent.',
    'Return ONLY a concise user-facing progress update: at most two sentences and 45 words.',
    'Describe what the agent has completed, what it is currently doing, and the next concrete step when the transcript supports it.',
    'Do not expose or quote hidden chain-of-thought or private deliberation. Summarize reasoning only at a high level.',
    'Do not claim that the task is complete unless the transcript clearly says it is complete.',
    'Use the same language as the user request.',
].join('\n');

const COMMAND_SUMMARY_SYSTEM_PROMPT = [
    'You are a concise command reporter for a coding agent.',
    'Return ONLY one user-facing sentence, no more than 24 words.',
    'Explain what the active command is doing and why it is running, using only the supplied command and context.',
    'Do not expose or quote hidden chain-of-thought, private deliberation, or raw command output.',
    'If the reason is not supported by the context, state only what the command is doing.',
    'Use the same language as the user request.',
].join('\n');

const COMMAND_TOOL_NAMES = new Set(['bash', 'shell', 'cmd', 'terminal']);
const ACTIVE_COMMAND_STATUSES = new Set(['pending', 'running']);
const commandInputSchema = z.object({
    command: z.string().optional(),
    cmd: z.string().optional(),
    script: z.string().optional(),
    description: z.string().optional(),
});

type ProgressSummaryInternalState = {
    key: string;
    summary: string | null;
    generatedAt: number | null;
    isGenerating: boolean;
    commandSummary: string | null;
    isCommandGenerating: boolean;
};

export type SessionProgressSummaryState = {
    isActive: boolean;
    summary: string | null;
    generatedAt: number | null;
    isGenerating: boolean;
    commandSummary: string | null;
    isCommandGenerating: boolean;
};

type ActiveCommandSnapshot = {
    key: string;
    tool: string;
    command: string;
    description: string | null;
};

type ProgressRequestBody = {
    prompt: string;
    system: string;
    maxOutputTokens: number;
    directory?: string;
    restrictToPreferredProvider: boolean;
    preferredProviderID?: string;
    preferredModelID?: string;
};

const EMPTY_PROGRESS_SUMMARY: SessionProgressSummaryState = {
    isActive: false,
    summary: null,
    generatedAt: null,
    isGenerating: false,
    commandSummary: null,
    isCommandGenerating: false,
};

const clampText = (text: string, limit: number): string => {
    const normalized = text.trim();
    if (normalized.length <= limit) return normalized;
    return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
};

const clampContext = (text: string, limit = PROGRESS_CONTEXT_CHAR_LIMIT): string => {
    if (text.length <= limit) return text;

    const headLength = Math.floor(limit * 0.35);
    const tailLength = limit - headLength;
    return [
        text.slice(0, headLength).trimEnd(),
        '[middle of transcript omitted]',
        text.slice(-tailLength).trimStart(),
    ].join('\n\n');
};

const normalizeToolName = (tool: string): string => tool.trim().toLowerCase();

const getCommandInputData = (part: ToolPart): z.infer<typeof commandInputSchema> | null => {
    const parsed = commandInputSchema.safeParse(part.state.input);
    return parsed.success ? parsed.data : null;
};

const getCommandInput = (part: ToolPart): string => {
    const input = getCommandInputData(part);
    return (input?.command ?? input?.cmd ?? input?.script ?? '').trim();
};

const getCommandDescription = (part: ToolPart): string | null => {
    const description = getCommandInputData(part)?.description?.trim() ?? '';
    return description.length > 0
        ? description.trim()
        : null;
};

const getCommandDetail = (part: ToolPart): string => {
    const command = getCommandInput(part);
    if (command) return command;
    if (part.state.status === 'running') return part.state.title ?? '';
    if (part.state.status === 'completed') return part.state.title || part.state.output;
    if (part.state.status === 'error') return part.state.error;
    return '';
};

const formatToolPart = (part: ToolPart): string => {
    const detail = getCommandDetail(part);
    const suffix = detail ? `: ${clampText(detail, PROGRESS_PART_CHAR_LIMIT)}` : '';
    return `Tool ${part.tool} (${part.state.status})${suffix}`;
};

const formatProgressPart = (part: Part): string => {
    switch (part.type) {
        case 'text':
            return clampText(part.text, PROGRESS_PART_CHAR_LIMIT);
        case 'reasoning':
            return `Reasoning: ${clampText(part.text, PROGRESS_PART_CHAR_LIMIT)}`;
        case 'tool':
            return formatToolPart(part);
        case 'subtask':
            return `Subtask ${part.agent}: ${clampText(part.description, PROGRESS_PART_CHAR_LIMIT)}`;
        case 'step-finish':
            return `Step completed (${part.reason})`;
        case 'retry':
            return `Retry attempt ${part.attempt}`;
        default:
            return '';
    }
};

const formatMessageForProgress = (message: Message, parts: Part[]): string => {
    const content = parts
        .map(formatProgressPart)
        .filter((part) => part.length > 0)
        .join('\n');
    if (!content) return '';

    const label = message.role === 'user' ? 'User' : 'Assistant';
    return `${label}:\n${content}`;
};

const findLastMessageIndex = (messages: Message[], role: Message['role']): number => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === role) return index;
    }
    return -1;
};

const findActiveTurnStartIndex = (messages: Message[]): number => {
    const lastAssistantIndex = findLastMessageIndex(messages, 'assistant');
    const lastUserIndex = findLastMessageIndex(messages, 'user');
    if (lastAssistantIndex < 0 && lastUserIndex < 0) return -1;

    let startIndex = lastUserIndex;
    const lastAssistant = lastAssistantIndex >= 0 ? messages[lastAssistantIndex] : null;
    if (lastAssistant?.role === 'assistant' && lastAssistantIndex > lastUserIndex) {
        const parentIndex = messages.findIndex((message) => message.id === lastAssistant.parentID);
        if (parentIndex >= 0) startIndex = parentIndex;
        else startIndex = lastAssistantIndex;
    }

    if (startIndex < 0) startIndex = lastAssistantIndex;
    return startIndex;
};

/** Finds the newest active shell command without subscribing to its output deltas. */
export const getActiveCommandSnapshot = (
    messages: Message[],
    getParts: (messageId: string) => Part[],
): ActiveCommandSnapshot | null => {
    const startIndex = findActiveTurnStartIndex(messages);
    if (startIndex < 0) return null;

    for (let messageIndex = messages.length - 1; messageIndex >= startIndex; messageIndex -= 1) {
        const message = messages[messageIndex];
        if (message?.role !== 'assistant') continue;

        const parts = getParts(message.id);
        for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
            const part = parts[partIndex];
            if (part?.type !== 'tool') continue;
            if (!ACTIVE_COMMAND_STATUSES.has(part.state.status)) continue;
            if (!COMMAND_TOOL_NAMES.has(normalizeToolName(part.tool))) continue;

            const command = getCommandInput(part);
            if (!command) continue;

            return {
                key: `${message.id}\u0000${part.id}\u0000${part.callID}\u0000${clampText(command, PROGRESS_PART_CHAR_LIMIT)}`,
                tool: part.tool,
                command,
                description: getCommandDescription(part),
            };
        }
    }

    return null;
};

/**
 * Builds a bounded transcript from the active turn. The part getter is kept
 * imperative so callers can sample the live part store without subscribing a
 * React component to token-frequency updates.
 */
export const buildSessionProgressTranscript = (
    messages: Message[],
    getParts: (messageId: string) => Part[],
): string | null => {
    if (messages.length === 0) return null;

    const startIndex = findActiveTurnStartIndex(messages);
    if (startIndex < 0) return null;

    const sections = messages
        .slice(startIndex)
        .map((message) => formatMessageForProgress(message, getParts(message.id)))
        .filter((section) => section.length > 0);
    if (sections.length === 0) return null;

    return clampContext(sections.join('\n\n'));
};

const isAbortError = (error: Error): boolean => error.name === 'AbortError';

const smallModelResponseSchema = z.object({ text: z.string().optional() });

const parseSummaryResponse = async (response: Response, limit: number): Promise<string | null> => {
    const parsed = smallModelResponseSchema.safeParse(await response.json().catch(() => null));
    if (!parsed.success) return null;
    const text = parsed.data.text?.trim() ?? '';
    return text ? clampText(text, limit) : null;
};

const getActiveCommandKey = (state: State, sessionId: string): string => {
    const snapshot = getActiveCommandSnapshot(
        state.message[sessionId] ?? [],
        (messageId) => state.part[messageId] ?? [],
    );
    return snapshot?.key ?? '';
};

const getEmptyInternalProgressSummary = (key: string): ProgressSummaryInternalState => ({
    key,
    summary: null,
    generatedAt: null,
    isGenerating: false,
    commandSummary: null,
    isCommandGenerating: false,
});

export function useSessionProgressSummary(
    sessionId: string,
    directory?: string,
): SessionProgressSummaryState {
    const status = useSessionStatus(sessionId, directory);
    const messages = useSessionMessages(sessionId, directory);
    const enabled = useUIStore((state) => state.liveProgressSummaryEnabled);
    const statusType = status?.type ?? 'idle';
    const isActive = Boolean(enabled && sessionId && statusType === 'busy');
    const activeCommandKey = useDirectorySync(
        React.useCallback((state: State) => getActiveCommandKey(state, sessionId), [sessionId]),
        directory,
    );
    const lastUserMessageId = React.useMemo(() => {
        const index = findLastMessageIndex(messages, 'user');
        return index >= 0 ? messages[index]?.id ?? null : null;
    }, [messages]);
    const progressKey = `${directory ?? ''}\u0000${sessionId}\u0000${lastUserMessageId ?? ''}`;
    const [state, setState] = React.useState<ProgressSummaryInternalState>({
        ...getEmptyInternalProgressSummary(progressKey),
    });
    const generationRef = React.useRef(0);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const abortRef = React.useRef<AbortController | null>(null);
    const commandTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    const commandAbortRef = React.useRef<AbortController | null>(null);

    React.useEffect(() => {
        generationRef.current += 1;
        const generation = generationRef.current;
        let cancelled = false;

        if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
        }
        abortRef.current?.abort();
        abortRef.current = null;
        setState(getEmptyInternalProgressSummary(progressKey));

        if (!isActive) {
            return () => {
                cancelled = true;
            };
        }

        const scheduleNext = () => {
            if (cancelled || generationRef.current !== generation) return;
            timerRef.current = setTimeout(() => {
                void generate();
            }, LIVE_PROGRESS_SUMMARY_INTERVAL_MS);
        };

        const generate = async () => {
            if (cancelled || generationRef.current !== generation) return;

            const transcript = buildSessionProgressTranscript(
                getSyncMessages(sessionId, directory),
                (messageId) => getSyncParts(messageId, directory),
            );
            if (!transcript) {
                scheduleNext();
                return;
            }

            const controller = new AbortController();
            abortRef.current = controller;
            setState((previous) => ({ ...previous, key: progressKey, isGenerating: true }));

            try {
                const sessionModel = getSessionLastAssistantModel(sessionId);
                const requestBody: ProgressRequestBody = {
                    prompt: `Summarize the current state of this active turn.\n\n${transcript}`,
                    system: PROGRESS_SUMMARY_SYSTEM_PROMPT,
                    maxOutputTokens: 120,
                    directory,
                    restrictToPreferredProvider: true,
                };
                if (sessionModel?.providerID) requestBody.preferredProviderID = sessionModel.providerID;
                if (sessionModel?.modelID) requestBody.preferredModelID = sessionModel.modelID;

                const response = await requestSmallModel({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify(requestBody),
                }, { silent: true });

                if (response.ok && !cancelled && generationRef.current === generation) {
                    const summary = await parseSummaryResponse(response, PROGRESS_SUMMARY_CHAR_LIMIT);
                    if (summary && !cancelled && generationRef.current === generation) {
                        setState((previous) => ({
                            ...previous,
                            key: progressKey,
                            summary,
                            generatedAt: Date.now(),
                            isGenerating: false,
                        }));
                    }
                }
            } catch (error) {
                if (error instanceof Error && isAbortError(error)) return;
                // Progress is advisory. A missing Small Model must not
                // interrupt the user's active turn or create a toast loop.
            } finally {
                if (abortRef.current === controller) abortRef.current = null;
                if (!cancelled && generationRef.current === generation) {
                    setState((previous) => ({ ...previous, key: progressKey, isGenerating: false }));
                    scheduleNext();
                }
            }
        };

        timerRef.current = setTimeout(() => {
            void generate();
        }, LIVE_PROGRESS_SUMMARY_INTERVAL_MS);

        return () => {
            cancelled = true;
            if (timerRef.current) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            abortRef.current?.abort();
            abortRef.current = null;
        };
    }, [directory, isActive, progressKey, sessionId]);

    React.useEffect(() => {
        let cancelled = false;
        const expectedCommandKey = activeCommandKey || null;

        if (commandTimerRef.current) {
            clearTimeout(commandTimerRef.current);
            commandTimerRef.current = null;
        }
        commandAbortRef.current?.abort();
        commandAbortRef.current = null;
        setState((previous) => ({
            ...previous,
            key: progressKey,
            commandSummary: null,
            isCommandGenerating: false,
        }));

        if (!isActive || !expectedCommandKey) {
            return () => {
                cancelled = true;
            };
        }

        const generateCommandSummary = async () => {
            if (cancelled) return;

            const command = getActiveCommandSnapshot(
                getSyncMessages(sessionId, directory),
                (messageId) => getSyncParts(messageId, directory),
            );
            if (!command || command.key !== expectedCommandKey) return;

            const transcript = buildSessionProgressTranscript(
                getSyncMessages(sessionId, directory),
                (messageId) => getSyncParts(messageId, directory),
            );
            const controller = new AbortController();
            commandAbortRef.current = controller;
            setState((previous) => ({
                ...previous,
                key: progressKey,
                isCommandGenerating: true,
            }));

            try {
                const sessionModel = getSessionLastAssistantModel(sessionId);
                const context = transcript ? clampContext(transcript, COMMAND_CONTEXT_CHAR_LIMIT) : '';
                const requestBody: ProgressRequestBody = {
                    prompt: [
                        'Explain this active command in one line.',
                        `Tool: ${command.tool}`,
                        `Command:\n${clampText(command.command, PROGRESS_PART_CHAR_LIMIT)}`,
                        command.description ? `Agent-provided description: ${clampText(command.description, 300)}` : '',
                        context ? `Active turn context:\n${context}` : '',
                    ].filter((section) => section.length > 0).join('\n\n'),
                    system: COMMAND_SUMMARY_SYSTEM_PROMPT,
                    maxOutputTokens: 64,
                    directory,
                    restrictToPreferredProvider: true,
                };
                if (sessionModel?.providerID) requestBody.preferredProviderID = sessionModel.providerID;
                if (sessionModel?.modelID) requestBody.preferredModelID = sessionModel.modelID;

                const response = await requestSmallModel({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify(requestBody),
                }, { silent: true });

                if (response.ok && !cancelled) {
                    const summary = await parseSummaryResponse(response, COMMAND_SUMMARY_CHAR_LIMIT);
                    if (summary && !cancelled) {
                        setState((previous) => ({
                            ...previous,
                            key: progressKey,
                            commandSummary: summary,
                            isCommandGenerating: false,
                        }));
                    }
                }
            } catch (error) {
                if (error instanceof Error && isAbortError(error)) return;
                // Command explanations are advisory. A missing Small Model
                // must not interrupt the command or create a toast loop.
            } finally {
                if (commandAbortRef.current === controller) commandAbortRef.current = null;
                if (!cancelled) {
                    setState((previous) => ({
                        ...previous,
                        key: progressKey,
                        isCommandGenerating: false,
                    }));
                }
            }
        };

        commandTimerRef.current = setTimeout(() => {
            void generateCommandSummary();
        }, COMMAND_PROGRESS_SUMMARY_DELAY_MS);

        return () => {
            cancelled = true;
            if (commandTimerRef.current) {
                clearTimeout(commandTimerRef.current);
                commandTimerRef.current = null;
            }
            commandAbortRef.current?.abort();
            commandAbortRef.current = null;
        };
    }, [activeCommandKey, directory, isActive, progressKey, sessionId]);

    if (!isActive || state.key !== progressKey) return EMPTY_PROGRESS_SUMMARY;
    return {
        isActive: true,
        summary: state.summary,
        generatedAt: state.generatedAt,
        isGenerating: state.isGenerating,
        commandSummary: state.commandSummary,
        isCommandGenerating: state.isCommandGenerating,
    };
}
