/* eslint-disable @typescript-eslint/no-explicit-any */
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { opencodeClient } from '@/lib/opencode/client';
import { checkIsGitRepository } from '@/lib/gitApi';
import { streamDebugEnabled } from '@/stores/utils/streamDebug';
import { copyTextToClipboard as copyPlainTextToClipboard } from '@/lib/clipboard';
import { getSyncSessions, getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import { useStreamingStore } from '@/sync/streaming';

export interface DebugMessageInfo {
  messageId: string;
  role: string;
  timestamp: number;
  partsCount: number;
  parts: Array<{
    id: string;
    type: string;
    text?: string;
    textLength?: number;
    tool?: string;
    state?: any;
  }>;
  isEmpty: boolean;
  isEmptyResponse: boolean;
  raw: any;
}

export const debugUtils = {

  getLastAssistantMessage(): DebugMessageInfo | null {
    const state = useSessionUIStore.getState();
    const currentSessionId = state.currentSessionId;

    if (!currentSessionId) {
      console.log('[ERROR] No active session');
      return null;
    }

    const messages = getSyncMessages(currentSessionId);
    if (!messages || messages.length === 0) {
      console.log('[ERROR] No messages in current session');
      return null;
    }

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === 'assistant') {
        const msgParts = getSyncParts(msg.id) || [];
        const parts = msgParts.map((part: any) => {
          const info: any = {
            id: part.id,
            type: part.type,
          };

          if (part.type === 'text') {
            info.text = part.text;
            info.textLength = part.text?.length || 0;
          } else if (part.type === 'tool') {
            info.tool = part.tool;
            info.state = part.state?.status;
          } else if (part.type === 'step-start' || part.type === 'step-finish') {
            info.isStepMarker = true;
          }

          return info;
        });

         const hasText = parts.some((p: any) => p.type === 'text' && p.text && p.text.trim().length > 0);
        const hasTools = parts.some((p: any) => p.type === 'tool');
        const hasStepMarkers = parts.some((p: any) => p.type === 'step-start' || p.type === 'step-finish');
        const isEmpty = parts.length === 0;
        const isEmptyResponse = !hasText && !hasTools && (!isEmpty || hasStepMarkers);

        const info: DebugMessageInfo = {
          messageId: msg.id,
          role: msg.role,
          timestamp: (msg as any).time?.created || 0,
          partsCount: parts.length,
          parts,
          isEmpty,
          isEmptyResponse,
          raw: msg,
        };

        console.log('[INSPECT] Last Assistant Message:', info);
        console.log('[SUMMARY] Summary:', {
          messageId: info.messageId,
          partsCount: info.partsCount,
          isEmpty: info.isEmpty,
          isEmptyResponse: info.isEmptyResponse,
          hasText,
          hasTools,
          hasStepMarkers,
          onlyStepMarkers: hasStepMarkers && !hasText && !hasTools,
        });

        if (info.isEmpty) {
          console.warn('[WARNING] Message has NO parts!');
        }

        if (info.isEmptyResponse) {
          console.warn('[WARNING] Message has parts but NO meaningful content (empty text, no tools)!');

          if (hasStepMarkers && !hasText && !hasTools) {
            console.warn('[CRITICAL] CLAUDE EMPTY RESPONSE BUG: Only step-start/step-finish markers, no actual content!');
            console.log('This is a known issue with Claude models (anthropic provider)');
            console.log('Recommendation: Send a follow-up message or try a different model');
          }
        }

        return info;
      }
    }

    console.log('[ERROR] No assistant messages found in current session');
    return null;
  },

  truncateString(value: string | undefined, maxLength: number = 80): string | undefined {
    if (!value || typeof value !== 'string') return value;
    if (value.length <= maxLength) return value;
    return value.substring(0, maxLength) + '…';
  },

  truncateMessages(messages: any[]): any[] {
    return messages.map((msg) => ({
      ...msg,
      parts: (getSyncParts(msg.id) || []).map((part: any) => {
        const truncatedPart: any = { ...part };

        if ('text' in part) {
          truncatedPart.text = this.truncateString(part.text);
        }
        if ('textPreview' in part) {
          truncatedPart.textPreview = this.truncateString(part.textPreview);
        }

        if (part.state) {
          truncatedPart.state = { ...part.state };

          if ('output' in part.state) {
            truncatedPart.state.output = this.truncateString(part.state.output);
          }
          if ('error' in part.state) {
            truncatedPart.state.error = this.truncateString(part.state.error);
          }
          if (part.state.metadata && 'preview' in part.state.metadata) {
            truncatedPart.state.metadata = {
              ...part.state.metadata,
              preview: this.truncateString(part.state.metadata.preview),
            };
          }
        }

        return truncatedPart;
      }),
    }));
  },

  getAllMessages(truncate: boolean = false) {
    const state = useSessionUIStore.getState();
    const currentSessionId = state.currentSessionId;

    if (!currentSessionId) {
      console.log('[ERROR] No active session');
      return [];
    }

    const messages = getSyncMessages(currentSessionId);
    console.log(`[MESSAGES] Total messages in session: ${messages.length}`);

    messages.forEach((msg, idx) => {
      const msgParts = getSyncParts(msg.id) || [];
      console.log(`[${idx}] ${msg.role} - ${msg.id} - ${msgParts.length} parts`);
    });

    return truncate ? this.truncateMessages(messages as any[]) : messages;
  },

  async getAppStatus() {
    const directoryState = useDirectoryStore.getState();
    const sessionState = useSessionUIStore.getState();
    const projectsState = useProjectsStore.getState();
    const currentDirectory = directoryState.currentDirectory || null;
    const opencodeDirectory = opencodeClient.getDirectory() ?? null;

    const sessions = getSyncSessions();
    const sessionDirectories = new Set<string>();
    const sessionDirectoryCounts: Record<string, number> = {};

    sessions.forEach((session) => {
      const directory = (session as { directory?: string | null }).directory;
      if (typeof directory === 'string' && directory.trim().length > 0) {
        sessionDirectories.add(directory);
        sessionDirectoryCounts[directory] = (sessionDirectoryCounts[directory] ?? 0) + 1;
      } else {
        sessionDirectoryCounts['(none)'] = (sessionDirectoryCounts['(none)'] ?? 0) + 1;
      }
    });

    const localStorageSnapshot = (() => {
      if (typeof window === 'undefined') {
        return { available: false };
      }
      try {
        return {
          available: true,
          lastDirectory: window.localStorage.getItem('lastDirectory'),
          homeDirectory: window.localStorage.getItem('homeDirectory'),
        };
      } catch (error) {
        return {
          available: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();

    const runtimeApis = typeof window !== 'undefined'
      ? (window as any).__OPENCHAMBER_RUNTIME_APIS__
      : null;
    const isTauriShell = typeof window !== 'undefined' && Boolean((window as any).__TAURI__);

    const safeJson = async (resp: Response) => {
      try {
        return await resp.json();
      } catch {
        return null;
      }
    };

    const safeText = async (resp: Response) => {
      try {
        return await resp.text();
      } catch {
        return null;
      }
    };

    const safeFetchJson = async (url: string): Promise<unknown> => {
      try {
        const resp = await fetch(url);
        return resp.ok ? await safeJson(resp) : { status: resp.status };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    };

    let pathInfo: unknown = null;
    let projectInfo: unknown = null;
    let settingsInfo: unknown = null;
    let opencodeHealth: unknown = null;

    const pathUrl = currentDirectory
      ? `/api/path?directory=${encodeURIComponent(currentDirectory)}`
      : '/api/path';
    pathInfo = await safeFetchJson(pathUrl);

    const projectUrl = currentDirectory
      ? `/api/project/current?directory=${encodeURIComponent(currentDirectory)}`
      : '/api/project/current';
    projectInfo = await safeFetchJson(projectUrl);

    settingsInfo = await safeFetchJson('/api/config/settings');

    try {
      const resp = await fetch('/api/health');
      const contentType = resp.headers.get('content-type') || '';
      const body = await safeText(resp);
      const isJson = contentType.toLowerCase().includes('application/json');
      let parsed: Record<string, unknown> | null = null;
      if (isJson && body) {
        try {
          const candidate = JSON.parse(body) as unknown;
          if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
            parsed = candidate as Record<string, unknown>;
          }
        } catch {
          parsed = null;
        }
      }
      opencodeHealth = {
        status: resp.status,
        ok: resp.ok,
        contentType,
        type: isJson ? 'json' : 'html',
        openCodePort: parsed?.openCodePort ?? null,
        openCodeRunning: parsed?.openCodeRunning ?? null,
        openCodeSecureConnection: parsed?.openCodeSecureConnection ?? null,
        openCodeAuthSource: parsed?.openCodeAuthSource ?? null,
        isOpenCodeReady: parsed?.isOpenCodeReady ?? null,
        lastOpenCodeError: parsed?.lastOpenCodeError ?? null,
        preview: body ? body.slice(0, 120) : null,
      };
    } catch (error) {
      opencodeHealth = { error: error instanceof Error ? error.message : String(error) };
    }

    let gitCheck: { isGitRepo: boolean | null; error?: string } = { isGitRepo: null };
    if (currentDirectory) {
      try {
        gitCheck.isGitRepo = await checkIsGitRepository(currentDirectory);
      } catch (error) {
        gitCheck = {
          isGitRepo: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    const projectSamples = projectsState.projects.map((project) => ({
      id: project.id,
      path: project.path,
      label: project.label,
    }));

    const report = {
      runtime: {
        platform: runtimeApis?.runtime?.platform ?? null,
        isDesktop: isTauriShell,
        isVSCode: Boolean(runtimeApis?.runtime?.isVSCode),
        hasRuntimeApis: Boolean(runtimeApis),
        desktopServerOrigin: null,
      },
      location: typeof window !== 'undefined'
        ? {
            href: window.location?.href ?? null,
            origin: window.location?.origin ?? null,
          }
        : null,
      directories: {
        currentDirectory,
        opencodeDirectory: (pathInfo as { directory?: string; worktree?: string } | null)?.directory
          || (pathInfo as { worktree?: string } | null)?.worktree
          || opencodeDirectory,
        homeDirectory: directoryState.homeDirectory || null,
        isHomeReady: directoryState.isHomeReady,
        hasPersistedDirectory: directoryState.hasPersistedDirectory,
        isSwitchingDirectory: directoryState.isSwitchingDirectory,
      },
      projects: {
        total: projectsState.projects.length,
        activeProjectId: projectsState.activeProjectId,
        samples: projectSamples,
      },
      sessions: {
        total: sessions.length,
        currentSessionId: sessionState.currentSessionId,
        lastLoadedDirectory: sessionState.lastLoadedDirectory,
        uniqueDirectories: sessionDirectories.size,
        directorySamples: Array.from(sessionDirectories).slice(0, 5),
        directoryCounts: sessionDirectoryCounts,
      },
      worktrees: {
        available: sessionState.availableWorktrees.length,
        metadataEntries: sessionState.worktreeMetadata.size,
      },
      git: gitCheck,
      localStorage: localStorageSnapshot,
      opencode: {
        pathInfo,
        projectInfo,
        health: opencodeHealth,
      },
      openchamber: {
        settingsInfo,
      },
    };

    console.log('[DEBUG] App status snapshot:', report);
    return report;
  },

  async buildDiagnosticsReport() {
    const report = await this.getAppStatus();
    return JSON.stringify(report, null, 2);
  },

  async copyTextToClipboard(text: string) {
    return copyPlainTextToClipboard(text);
  },

  async copyDiagnosticsReport() {
    const report = await this.buildDiagnosticsReport();
    const result = await this.copyTextToClipboard(report);
    return { ...result, report } as const;
  },

   checkLastMessage() {
    const info = this.getLastAssistantMessage();
    if (!info) return false;

    const isProblematic = info.isEmpty || info.isEmptyResponse;

    if (isProblematic) {
      console.error('[ALERT] PROBLEMATIC MESSAGE DETECTED!');
      console.log('Details:', {
        messageId: info.messageId,
        isEmpty: info.isEmpty,
        isEmptyResponse: info.isEmptyResponse,
        partsCount: info.partsCount,
      });

      if (info.parts.length > 0) {
        console.log('Parts:', info.parts);
      }
    } else {
      console.log('[OK] Last message looks good!');
    }

    return isProblematic;
  },

  getStreamingState() {
    const sessionState = useSessionUIStore.getState();
    const streamingState = useStreamingStore.getState();
    const currentStreamingId = sessionState.currentSessionId
      ? streamingState.streamingMessageIds.get(sessionState.currentSessionId) ?? null
      : null;
    console.log('[STREAM] Streaming State:', {
      streamingMessageId: currentStreamingId,
      streamingMessageIds: Array.from(streamingState.streamingMessageIds.entries()),
      messageStreamStates: Array.from(streamingState.messageStreamStates.entries()),
    });
    return {
      streamingMessageId: currentStreamingId,
      streamingMessageIds: streamingState.streamingMessageIds,
      streamStates: streamingState.messageStreamStates,
    };
  },

  findEmptyMessages() {
    const state = useSessionUIStore.getState();
    const currentSessionId = state.currentSessionId;

    if (!currentSessionId) {
      console.log('[ERROR] No active session');
      return [];
    }

    const messages = getSyncMessages(currentSessionId);
    const emptyMessages = messages
      .filter((msg) => msg.role === 'assistant')
      .filter((msg) => {
        const parts = getSyncParts(msg.id) || [];
        const hasTextContent = parts.some(
          (p: any) => p.type === 'text' && p.text && p.text.trim().length > 0
        );
        const hasTools = parts.some((p: any) => p.type === 'tool');

        return parts.length === 0 || (!hasTextContent && !hasTools);
      });

    console.log(`[INSPECT] Found ${emptyMessages.length} empty assistant messages`);

    emptyMessages.forEach((msg, idx) => {
      const parts = getSyncParts(msg.id) || [];
      console.log(`[${idx}] Empty message:`, {
        messageId: msg.id,
        partsCount: parts.length,
        provider: (msg as any).providerID,
        model: (msg as any).modelID,
        timestamp: (msg as any).time?.created,
      });
    });

    return emptyMessages;
  },

   showRetryHelp() {
     console.log('[DEBUG] How to handle empty Claude responses:\n');
     console.log('1. Check the last message:');
    console.log('   __opencodeDebug.getLastAssistantMessage()\n');
    console.log('2. Find all empty messages in session:');
    console.log('   __opencodeDebug.findEmptyMessages()\n');
    console.log('3. To retry, you can:');
    console.log('   - Edit your last user message and resend');
    console.log('   - Send a follow-up message like "Please provide the response"');
    console.log('   - Try a different model (OpenAI models tend to be more reliable)\n');
    console.log('[TIP] Empty responses are usually due to:');
    console.log('   - Model rate limits');
    console.log('   - Context length issues');
    console.log('   - Model refusing to respond to certain prompts');
    console.log('   - API errors from provider');
  },

  analyzeMessageCompletionConsistency(options: {
    includeNonAssistant?: boolean;
    verbose?: boolean;
    maxTableRows?: number;
  } = {}) {
    const { includeNonAssistant = false, verbose = true, maxTableRows = 25 } = options;
    const state = useSessionUIStore.getState();
    const currentSessionId = state.currentSessionId;

    if (!currentSessionId) {
      console.log('[ERROR] No active session');
      return { summary: null, rows: [] };
    }

    const messages = getSyncMessages(currentSessionId);
    const targetMessages = includeNonAssistant
      ? messages
      : messages.filter((msg) => msg.role === 'assistant');

    const summary = {
      totalMessages: messages.length,
      analyzedMessages: targetMessages.length,
      completedMissing: 0,
      completedBeforeTool: 0,
      completedBeforeReasoning: 0,
      runningToolsWhenCompleted: 0,
      reasoningOpenWhenCompleted: 0,
      withTools: 0,
      withReasoning: 0,
    };

    const toNumber = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    const getLatestTimestamp = (timestamps: Array<number | null>): number | null => {
      const filtered = timestamps.filter((value): value is number => typeof value === 'number');
      return filtered.length > 0 ? Math.max(...filtered) : null;
    };

    const rows = targetMessages.map((message, index) => {
      const info = message as any;
      const parts = getSyncParts(message.id) || [];

      const timeInfo = (info.time ?? {}) as { completed?: number };
      const completedAt = toNumber(timeInfo.completed);
      const hasCompleted = completedAt !== null;

      const toolParts = parts.filter((part: any) => part.type === 'tool');
      const reasoningParts = parts.filter((part: any) => part.type === 'reasoning');

      const latestToolTimestamp = getLatestTimestamp(
        toolParts.map((part: any) =>
          toNumber(part.state?.time?.end ?? part.state?.time?.start)
        )
      );
      const latestReasoningTimestamp = getLatestTimestamp(
        reasoningParts.map((part: any) => toNumber(part.time?.end ?? part.time?.start))
      );
      const latestPartTimestamp = getLatestTimestamp(
        [latestToolTimestamp, latestReasoningTimestamp].filter((value) => value !== null)
      );

      const hasRunningTool = toolParts.some((part: any) =>
        ['pending', 'running', 'started'].includes(part.state?.status)
      );
      const reasoningIncomplete = reasoningParts.some(
        (part: any) => typeof part.time?.end !== 'number'
      );

      if (toolParts.length > 0) {
        summary.withTools += 1;
      }
      if (reasoningParts.length > 0) {
        summary.withReasoning += 1;
      }

      if (!hasCompleted) {
        summary.completedMissing += 1;
      }

      const completedBeforeTool = Boolean(
        hasCompleted &&
        typeof latestToolTimestamp === 'number' &&
        completedAt! < latestToolTimestamp
      );
      if (completedBeforeTool) {
        summary.completedBeforeTool += 1;
      }

      const completedBeforeReasoning = Boolean(
        hasCompleted &&
        typeof latestReasoningTimestamp === 'number' &&
        completedAt! < latestReasoningTimestamp
      );
      if (completedBeforeReasoning) {
        summary.completedBeforeReasoning += 1;
      }

      if (hasCompleted && hasRunningTool) {
        summary.runningToolsWhenCompleted += 1;
      }
      if (hasCompleted && reasoningIncomplete) {
        summary.reasoningOpenWhenCompleted += 1;
      }

      return {
        index,
        messageId: info.id,
        role: info.role,
        completedAt,
        latestToolTimestamp,
        latestReasoningTimestamp,
        latestPartTimestamp,
        completed_missing: !hasCompleted,
        completed_before_tool: completedBeforeTool,
        completed_before_reasoning: completedBeforeReasoning,
        running_tools_when_completed: Boolean(hasCompleted && hasRunningTool),
        reasoning_open_when_completed: Boolean(hasCompleted && reasoningIncomplete),
        has_tools: toolParts.length > 0,
        has_reasoning: reasoningParts.length > 0,
      };
    });

    if (verbose) {
      console.table(rows.slice(0, maxTableRows));
      if (rows.length > maxTableRows) {
        console.log(`Displayed first ${maxTableRows} rows out of ${rows.length}.`);
      }
      console.log('[SUMMARY] Message completion timing:', summary);
    }

    return { summary, rows };
  },

   checkCompletionStatus() {
    const state = useSessionUIStore.getState();
    const currentSessionId = state.currentSessionId;

    if (!currentSessionId) {
      console.log('[ERROR] No active session');
      return null;
    }

    const messages = getSyncMessages(currentSessionId);
    const assistantMessages = messages.filter(m => m.role === 'assistant');

    if (assistantMessages.length === 0) {
      console.log('[ERROR] No assistant messages');
      return null;
    }

    const lastMessage = assistantMessages[assistantMessages.length - 1];
    const lastParts = getSyncParts(lastMessage.id) || [];
    const stepFinishParts = lastParts.filter((p: any) => p.type === 'step-finish');
    const hasStopReason = (lastMessage as any).finish === 'stop';

    const timeInfo = (lastMessage as any).time;
    const completedAt = timeInfo?.completed;
    const messageStatus = (lastMessage as any).status;
    const hasCompletedFlag = (typeof completedAt === 'number' && completedAt > 0) || messageStatus === 'completed';
    const messageIsComplete = Boolean(hasCompletedFlag && hasStopReason);

     const streamingState = useStreamingStore.getState();
    const streamingMessageId = (lastMessage as any).sessionID
      ? streamingState.streamingMessageIds.get((lastMessage as any).sessionID as string) ?? null
      : null;
    const lifecycle = streamingState.messageStreamStates.get(lastMessage.id);
    const isStreamingCandidate = lastMessage.id === streamingMessageId;

    console.log('[SUMMARY] Completion Status:');
    console.log('Message ID:', lastMessage.id);
    console.log('time.completed:', completedAt, '(type:', typeof completedAt, ')');
    console.log('status:', messageStatus);
    console.log('hasCompletedFlag:', hasCompletedFlag);
    console.log('hasStopReason:', hasStopReason);
    console.log('messageIsComplete:', messageIsComplete);
    console.log('lifecycle phase:', lifecycle?.phase);
    console.log('isStreamingCandidate:', isStreamingCandidate);
    console.log('streamingMessageId:', streamingMessageId);
    console.log('Step-finish parts:', stepFinishParts);

    return {
      messageId: lastMessage.id,
      completed: completedAt,
      status: messageStatus,
      hasCompletedFlag,
      hasStopReason,
      messageIsComplete,
      stepFinishParts,
      raw: lastMessage,
    };
  },
};

if (typeof window !== 'undefined') {
  (window as any).__opencodeDebug = debugUtils;
  if (streamDebugEnabled()) {
    console.log('[DEBUG] OpenCode Debug Utils loaded! Use window.__opencodeDebug in console');
    console.log('Available commands:');
    console.log('  __opencodeDebug.getLastAssistantMessage() - Get last assistant message details');
    console.log('  __opencodeDebug.getAllMessages(truncate?) - List all messages (truncate=true for short preview)');
    console.log('  __opencodeDebug.truncateMessages(messages) - Truncate long fields in messages array');
    console.log('  __opencodeDebug.getAppStatus() - Show app status snapshot');
    console.log('  __opencodeDebug.checkLastMessage() - Check if last message is problematic');
    console.log('  __opencodeDebug.findEmptyMessages() - Find all empty assistant messages');
    console.log('  __opencodeDebug.showRetryHelp() - Show instructions for handling empty responses');
    console.log('  __opencodeDebug.getStreamingState() - Get streaming state info');
    console.log('  __opencodeDebug.analyzeMessageCompletionConsistency(opts?) - Compare time.completed vs part timings');
    console.log('  __opencodeDebug.checkCompletionStatus() - Check completion status of last message');
  }

  window.addEventListener('error', (event) => {
    try {
      const message = event.message || '';
      const source = event.filename || '';
      if (
        typeof message === 'string' &&
        message.includes("this._renderer.value.dimensions") &&
        /xterm/i.test(String(source))
      ) {
        event.preventDefault();
      }
    } catch { /* ignored */ }
  });
}
