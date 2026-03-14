import {
  getOrCreateBoard,
  moveCardByAutomation,
  updateCardRuntimeState,
} from './service.js';

const MAX_CASCADE_STEPS = 10;
const CARD_KEY_SEPARATOR = '\u0000';

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function formatCardContext(card) {
  const title = trimString(card?.title);
  const description = trimString(card?.description);
  if (!title && !description) return '';
  const parts = [];
  if (title) parts.push(`Title: ${title}`);
  if (description) parts.push(`Description: ${description}`);
  return parts.length > 0 ? `\n\n${parts.join('\n')}` : '';
}

function combineWithContext(text, context) {
  const trimmedText = typeof text === 'string' ? text : '';
  if (!context) return trimmedText;
  return trimmedText + context;
}

function buildCardKey(projectDirectory, cardId) {
  return `${projectDirectory}${CARD_KEY_SEPARATOR}${cardId}`;
}

function parseCardKey(cardKey) {
  const separatorIndex = cardKey.lastIndexOf(CARD_KEY_SEPARATOR);
  if (separatorIndex <= 0 || separatorIndex >= cardKey.length - 1) {
    return null;
  }
  return {
    projectDirectory: cardKey.slice(0, separatorIndex),
    cardId: cardKey.slice(separatorIndex + 1),
  };
}

function parseOnEnterText(text) {
  const value = typeof text === 'string' ? text : '';
  const trimmedContent = value.trimStart();
  if (!trimmedContent) {
    return null;
  }

  const firstTokenLooksLikeAbsolutePath = (() => {
    if (!trimmedContent.startsWith('/')) return false;
    const firstWhitespaceIndex = trimmedContent.search(/\s/);
    const firstToken = firstWhitespaceIndex === -1
      ? trimmedContent
      : trimmedContent.slice(0, firstWhitespaceIndex);
    if (firstToken.length <= 1) return false;
    const tokenWithoutLeadingSlash = firstToken.slice(1);
    if (!tokenWithoutLeadingSlash.includes('/')) return false;
    return true;
  })();

  if (!trimmedContent.startsWith('/') || firstTokenLooksLikeAbsolutePath) {
    return { type: 'prompt', text: value.trim() };
  }

  const firstLineEnd = trimmedContent.indexOf('\n');
  const firstLine = firstLineEnd === -1 ? trimmedContent : trimmedContent.slice(0, firstLineEnd);
  const [commandToken, ...firstLineArgs] = firstLine.split(' ');
  const command = commandToken.slice(1).trim();
  if (!command) {
    return { type: 'prompt', text: value.trim() };
  }

  const restOfInput = firstLineEnd === -1 ? '' : trimmedContent.slice(firstLineEnd + 1);
  const argsFromFirstLine = firstLineArgs.join(' ').trim();
  const args = restOfInput
    ? (argsFromFirstLine ? `${argsFromFirstLine}\n${restOfInput}` : restOfInput)
    : argsFromFirstLine;

  return {
    type: 'command',
    command,
    arguments: args,
  };
}

class KanbanAutomationRuntime {
  constructor({
    createSession,
    sendPrompt,
    sendCommand,
    onError,
    maxCascadeSteps = MAX_CASCADE_STEPS,
    getBoard = getOrCreateBoard,
    moveCard = moveCardByAutomation,
    updateRuntimeState = updateCardRuntimeState,
  }) {
    this.activeChainByCardKey = new Map();
    this.sessionToCardKey = new Map();
    this.cardKeyToSessionId = new Map();
    this.createSession = createSession;
    this.sendPrompt = sendPrompt;
    this.sendCommand = sendCommand;
    this.onError = onError;
    this.maxCascadeSteps = maxCascadeSteps;
    this.getBoard = getBoard;
    this.moveCard = moveCard;
    this.updateRuntimeState = updateRuntimeState;
  }

  createChain(projectDirectory, cardId) {
    return {
      projectDirectory,
      cardId,
      visitedColumns: new Set(),
      stepCount: 0,
      sessionId: null,
      startedAt: Date.now(),
    };
  }

  clearSessionMapping(sessionId) {
    const key = trimString(sessionId);
    if (!key) return;
    const cardKey = this.sessionToCardKey.get(key);
    this.sessionToCardKey.delete(key);
    if (cardKey) {
      const mappedSessionId = this.cardKeyToSessionId.get(cardKey);
      if (mappedSessionId === key) {
        this.cardKeyToSessionId.delete(cardKey);
      }
    }
  }

  clearCardSession(cardKey) {
    const activeSessionId = this.cardKeyToSessionId.get(cardKey);
    if (activeSessionId) {
      this.sessionToCardKey.delete(activeSessionId);
    }
    this.cardKeyToSessionId.delete(cardKey);
  }

  cleanupChain(cardKey) {
    const chain = this.activeChainByCardKey.get(cardKey);
    if (chain?.sessionId) {
      this.clearSessionMapping(chain.sessionId);
    } else {
      this.clearCardSession(cardKey);
    }
    this.activeChainByCardKey.delete(cardKey);
  }

  extractSessionId(result) {
    if (typeof result === 'string') {
      return trimString(result);
    }
    if (result && typeof result === 'object' && typeof result.id === 'string') {
      return trimString(result.id);
    }
    return '';
  }

  async markFailed(cardKey, error) {
    const parsed = parseCardKey(cardKey);
    if (!parsed) {
      this.cleanupChain(cardKey);
      return;
    }

    try {
      await this.updateRuntimeState(parsed.projectDirectory, parsed.cardId, {
        status: 'failed',
        sessionId: '',
      });
    } catch (updateError) {
      console.error('[KanbanAutomation] Failed to persist failed status:', updateError);
    }

    this.cleanupChain(cardKey);

    if (typeof this.onError === 'function') {
      this.onError({
        projectDirectory: parsed.projectDirectory,
        cardId: parsed.cardId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async dispatchAutomation(chain, cardKey, automation, card) {
    const parsedInput = parseOnEnterText(automation.onEnterText);
    if (!parsedInput) {
      throw new Error('Automation prompt is empty');
    }

    const executionDirectory = trimString(card?.worktreeId) || chain.projectDirectory;

    await this.updateRuntimeState(chain.projectDirectory, chain.cardId, {
      status: 'running',
      sessionId: '',
    });

    const sessionResult = await this.createSession({
      directory: executionDirectory,
    });
    const sessionId = this.extractSessionId(sessionResult);
    if (!sessionId) {
      throw new Error('Failed to create automation session');
    }

    this.clearCardSession(cardKey);
    this.sessionToCardKey.set(sessionId, cardKey);
    this.cardKeyToSessionId.set(cardKey, sessionId);
    chain.sessionId = sessionId;

    await this.updateRuntimeState(chain.projectDirectory, chain.cardId, {
      status: 'running',
      sessionId,
    });

    const cardContext = formatCardContext(card);

    if (parsedInput.type === 'command') {
      await this.sendCommand({
        sessionId,
        directory: executionDirectory,
        command: parsedInput.command,
        arguments: combineWithContext(parsedInput.arguments, cardContext),
        providerID: automation.providerID,
        modelID: automation.modelID,
        agent: automation.agent,
        variant: automation.variant,
      });
      return sessionId;
    }

    await this.sendPrompt({
      sessionId,
      directory: executionDirectory,
      text: combineWithContext(parsedInput.text, cardContext),
      providerID: automation.providerID,
      modelID: automation.modelID,
      agent: automation.agent,
      variant: automation.variant,
    });
    return sessionId;
  }

  async startAutomationForCardEntry(projectDirectory, cardId, enteredColumnId) {
    const normalizedProjectDirectory = trimString(projectDirectory);
    const normalizedCardId = trimString(cardId);
    if (!normalizedProjectDirectory || !normalizedCardId) {
      return { started: false, reason: 'invalid_input' };
    }

    const { board } = await this.getBoard(normalizedProjectDirectory);
    const card = board.cards.find((item) => item.id === normalizedCardId);
    if (!card) {
      return { started: false, reason: 'card_not_found' };
    }

    const selectedColumnId = trimString(enteredColumnId) || card.columnId;
    const column = board.columns.find((item) => item.id === selectedColumnId);
    if (!column) {
      return { started: false, reason: 'column_not_found' };
    }

    const automation = column.automation;
    if (!automation || !trimString(automation.onEnterText)) {
      return { started: false, reason: 'column_not_automated' };
    }

    const cardKey = buildCardKey(normalizedProjectDirectory, normalizedCardId);
    const existing = this.activeChainByCardKey.get(cardKey);
    if (existing?.sessionId) {
      return { started: false, reason: 'already_running', sessionId: existing.sessionId };
    }

    const chain = this.createChain(normalizedProjectDirectory, normalizedCardId);
    chain.visitedColumns.add(column.id);
    this.activeChainByCardKey.set(cardKey, chain);

    try {
      const sessionId = await this.dispatchAutomation(chain, cardKey, automation, card);
      return { started: true, sessionId };
    } catch (error) {
      await this.markFailed(cardKey, error);
      return {
        started: false,
        reason: 'dispatch_failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async handleSessionIdle(sessionId) {
    const normalizedSessionId = trimString(sessionId);
    if (!normalizedSessionId) {
      return { processed: false, reason: 'invalid_session' };
    }

    const cardKey = this.sessionToCardKey.get(normalizedSessionId);
    if (!cardKey) {
      return { processed: false, reason: 'not_tracked' };
    }

    const chain = this.activeChainByCardKey.get(cardKey);
    if (!chain) {
      this.clearSessionMapping(normalizedSessionId);
      return { processed: false, reason: 'chain_not_found' };
    }

    if (chain.sessionId !== normalizedSessionId) {
      this.clearSessionMapping(normalizedSessionId);
      return { processed: false, reason: 'session_mismatch' };
    }

    const { board: snapshot } = await this.getBoard(chain.projectDirectory);
    const cardAtIdle = snapshot.cards.find((item) => item.id === chain.cardId);
    if (!cardAtIdle) {
      this.cleanupChain(cardKey);
      return { processed: false, reason: 'card_not_found' };
    }
    if (cardAtIdle.sessionId !== normalizedSessionId) {
      this.clearSessionMapping(normalizedSessionId);
      chain.sessionId = null;
      return { processed: false, reason: 'stale_idle_event' };
    }

    this.clearSessionMapping(normalizedSessionId);
    chain.sessionId = null;

    try {
      await this.updateRuntimeState(chain.projectDirectory, chain.cardId, {
        status: 'done',
        sessionId: '',
      });

      let { board } = await this.getBoard(chain.projectDirectory);
      let card = board.cards.find((item) => item.id === chain.cardId);
      if (!card) {
        this.cleanupChain(cardKey);
        return { processed: true, result: 'card_missing_after_done' };
      }

      while (true) {
        const currentColumn = board.columns.find((column) => column.id === card.columnId);
        const nextColumnId = trimString(currentColumn?.automation?.onFinishMoveTo);
        if (!nextColumnId) {
          this.cleanupChain(cardKey);
          return { processed: true, result: 'completed' };
        }

        if (chain.stepCount >= this.maxCascadeSteps) {
          await this.markFailed(cardKey, new Error(`Cascade exceeded ${this.maxCascadeSteps} steps`));
          return { processed: true, result: 'failed_max_steps' };
        }
        if (chain.visitedColumns.has(nextColumnId)) {
          await this.markFailed(cardKey, new Error(`Cascade cycle detected at column ${nextColumnId}`));
          return { processed: true, result: 'failed_cycle' };
        }

        const targetColumn = board.columns.find((column) => column.id === nextColumnId);
        if (!targetColumn) {
          await this.markFailed(cardKey, new Error(`Cascade target column not found: ${nextColumnId}`));
          return { processed: true, result: 'failed_missing_target' };
        }

        const toOrder = board.cards.filter((item) => item.columnId === nextColumnId && item.id !== chain.cardId).length;
        chain.stepCount += 1;
        chain.visitedColumns.add(nextColumnId);

        await this.moveCard(chain.projectDirectory, chain.cardId, {
          toColumnId: nextColumnId,
          toOrder,
        });

        const refreshed = await this.getBoard(chain.projectDirectory);
        board = refreshed.board;
        card = board.cards.find((item) => item.id === chain.cardId);
        if (!card) {
          this.cleanupChain(cardKey);
          return { processed: true, result: 'card_missing_after_move' };
        }

        const refreshedColumn = board.columns.find((column) => column.id === nextColumnId);
        const targetAutomation = refreshedColumn?.automation;
        if (targetAutomation && trimString(targetAutomation.onEnterText)) {
          try {
            const nextSessionId = await this.dispatchAutomation(chain, cardKey, targetAutomation, card);
            return { processed: true, result: 'restarted', sessionId: nextSessionId };
          } catch (error) {
            await this.markFailed(cardKey, error);
            return {
              processed: true,
              result: 'failed_dispatch',
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }

        await this.updateRuntimeState(chain.projectDirectory, chain.cardId, {
          status: 'done',
          sessionId: '',
        });
      }
    } catch (error) {
      await this.markFailed(cardKey, error);
      return {
        processed: true,
        result: 'failed',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getActiveChain(cardKey) {
    return this.activeChainByCardKey.get(cardKey) || null;
  }

  getChainBySessionId(sessionId) {
    const normalizedSessionId = trimString(sessionId);
    if (!normalizedSessionId) {
      return null;
    }
    const cardKey = this.sessionToCardKey.get(normalizedSessionId);
    if (!cardKey) {
      return null;
    }
    return this.getActiveChain(cardKey);
  }

  dispose() {
    this.activeChainByCardKey.clear();
    this.sessionToCardKey.clear();
    this.cardKeyToSessionId.clear();
  }
}

export function createKanbanAutomationRuntime(options) {
  return new KanbanAutomationRuntime(options);
}

export { parseOnEnterText };
