/**
 * AgentLoopService — backend orchestrator for agent loop workpackages.
 *
 * Manages the lifecycle of agent loops: reading workpackage files, creating
 * OpenCode sessions, sending task prompts, monitoring SSE events for session
 * completion, and advancing to the next task.
 *
 * All state lives in-memory on the server, so page refreshes on the frontend
 * don't lose loop progress.
 */

/** Permission ruleset that allows all operations without prompting */
const ALLOW_ALL_PERMISSIONS = [
  { permission: '*', pattern: '*', action: 'allow' },
];

/** Delay before advancing to the next workpackage (ms) */
const TASK_ADVANCEMENT_DELAY_MS = 2000;

/** How long a session can go without activity before being considered stalled (ms) */
const HEARTBEAT_STALL_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

/** Maximum number of stall retries before erroring the loop */
const MAX_STALL_RETRIES = 3;

/** Interval for checking stalled sessions (ms) */
const STALL_CHECK_INTERVAL_MS = 30_000;

const VALID_PRESERVED_STATUSES = new Set(['completed', 'failed', 'skipped']);

let loopCounter = 0;

function generateLoopId() {
  loopCounter += 1;
  return `loop_${Date.now()}_${loopCounter}_${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Validate that a parsed JSON object matches the workpackage file schema.
 */
function validateWorkpackageFile(data) {
  if (!data || typeof data !== 'object') return false;
  if (typeof data.name !== 'string' || data.name.trim().length === 0) return false;
  if (!Array.isArray(data.workpackages)) return false;
  if (data.workpackages.length === 0) return false;
  for (const wp of data.workpackages) {
    if (!wp || typeof wp !== 'object') return false;
    if (typeof wp.id !== 'string' || wp.id.trim().length === 0) return false;
    if (typeof wp.title !== 'string' || wp.title.trim().length === 0) return false;
    if (typeof wp.description !== 'string' || wp.description.trim().length === 0) return false;
  }
  return true;
}

/**
 * Normalize workpackage statuses: preserve terminal statuses, reset others to 'pending'.
 */
function normalizeWorkpackages(workpackages) {
  return workpackages.map((wp) => {
    const preserveStatus = wp.status && VALID_PRESERVED_STATUSES.has(wp.status);
    return {
      id: wp.id,
      title: wp.title,
      description: wp.description,
      status: preserveStatus ? wp.status : 'pending',
      sessionId: wp.sessionId || undefined,
      error: wp.error || undefined,
      retryCount: wp.retryCount || 0,
      startedAt: preserveStatus ? wp.startedAt : undefined,
      completedAt: preserveStatus ? wp.completedAt : undefined,
    };
  });
}

/**
 * Build the prompt for a single workpackage task.
 */
function buildTaskPrompt(wp, filePath, systemPrompt) {
  const parts = [];
  if (systemPrompt && systemPrompt.trim()) {
    parts.push(systemPrompt.trim());
  }
  parts.push(`## Task: ${wp.title}\n\n${wp.description}`);

  if (filePath) {
    parts.push(
      `## Progress tracking\n\nOnce you have fully completed the task above, update \`${filePath}\` by changing the \`"status"\` field for workpackage id \`"${wp.id}"\` from \`"pending"\` (or \`"running"\`) to \`"completed"\`.`
    );
  }

  return parts.join('\n\n');
}

class AgentLoopService {
  /**
   * @param {object} deps - Injected dependencies
   * @param {function} deps.buildOpenCodeUrl
   * @param {function} deps.getOpenCodeAuthHeaders
   * @param {function} deps.extractSessionStatusUpdate
   * @param {object} deps.fsPromises
   * @param {function} deps.resolveWorkspacePath - resolves path within workspace
   * @param {function} deps.isPathWithinRoot
   * @param {object} deps.path
   */
  constructor(deps) {
    this._deps = deps;
    /** @type {Map<string, object>} */
    this._loops = new Map();
    /** @type {Map<string, string>} sessionId → loopId mapping for tracked child sessions */
    this._sessionToLoop = new Map();
    /** @type {NodeJS.Timeout|null} */
    this._stallCheckInterval = null;

    /** @type {boolean} Guard against overlapping async stall checks */
    this._stallCheckInProgress = false;

    // Start stall detection
    this._stallCheckInterval = setInterval(() => {
      if (this._stallCheckInProgress) return;
      this._stallCheckInProgress = true;
      this.#checkForStalledSessions()
        .catch((err) => console.warn('[AgentLoopService] Stall check error:', err))
        .finally(() => { this._stallCheckInProgress = false; });
    }, STALL_CHECK_INTERVAL_MS);
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /**
   * Start a new agent loop from a workpackage file.
   */
  async startLoop({ filePath, directory, providerID, modelID, agent, variant, systemPrompt }) {
    // Read and validate workpackage file
    const fileData = await this.#readWorkpackageFile(filePath, directory);
    if (!fileData) {
      throw new Error(`Could not read or validate workpackage file: ${filePath}`);
    }

    const workpackages = normalizeWorkpackages(fileData.workpackages);

    // Persist model configuration to the workpackage file
    void this.#saveModelConfigToDisk(filePath, directory, { providerID, modelID, variant });

    // Find first pending task
    const startIndex = workpackages.findIndex((wp) => wp.status === 'pending');
    if (startIndex === -1) {
      throw new Error('All workpackages are already completed');
    }

    // Create root session
    const rootSession = await this.#createSession({
      title: `[Loop] ${fileData.name}`,
      directory,
    });

    const loopId = generateLoopId();
    const loop = {
      id: loopId,
      name: fileData.name,
      status: 'running',
      workpackages,
      filePath,
      directory,
      providerID,
      modelID,
      agent: agent || undefined,
      variant: variant || undefined,
      systemPrompt: systemPrompt || undefined,
      parentSessionId: rootSession.id,
      currentIndex: startIndex,
      startedAt: Date.now(),
      lastActivityAt: Date.now(),
      error: undefined,
    };

    this._loops.set(loopId, loop);

    // Kick off the first task
    void this.#executeWorkpackage(loopId, startIndex);

    return this.#serializeLoop(loop);
  }

  getLoop(id) {
    const loop = this._loops.get(id);
    return loop ? this.#serializeLoop(loop) : null;
  }

  getAllLoops() {
    const result = [];
    for (const loop of this._loops.values()) {
      result.push(this.#serializeLoop(loop));
    }
    return result;
  }

  pauseLoop(id) {
    const loop = this._loops.get(id);
    if (!loop || loop.status !== 'running') return null;
    loop.status = 'paused';
    return this.#serializeLoop(loop);
  }

  async resumeLoop(id) {
    const loop = this._loops.get(id);
    if (!loop || loop.status !== 'paused') return null;
    loop.status = 'running';
    loop.lastActivityAt = Date.now();

    // Find next pending task
    const nextIndex = loop.workpackages.findIndex(
      (wp, i) => i >= loop.currentIndex && wp.status === 'pending'
    );
    if (nextIndex !== -1) {
      void this.#executeWorkpackage(id, nextIndex);
    }

    return this.#serializeLoop(loop);
  }

  async skipCurrent(id) {
    const loop = this._loops.get(id);
    if (!loop) return null;

    const idx = loop.currentIndex;
    const wp = loop.workpackages[idx];
    if (!wp || (wp.status !== 'running' && wp.status !== 'pending')) return null;

    // Mark as skipped
    wp.status = 'skipped';
    wp.completedAt = Date.now();

    // Persist to file
    void this.#updateWorkpackageOnDisk(loop.filePath, loop.directory, wp.id, 'skipped');

    // Abort running session if any
    if (wp.sessionId) {
      void this.#abortSession(wp.sessionId).catch(() => {});
    }

    // Remove session tracking
    if (wp.sessionId) {
      this._sessionToLoop.delete(wp.sessionId);
    }

    // Find next
    const nextIndex = loop.workpackages.findIndex((w, i) => i > idx && w.status === 'pending');
    if (nextIndex !== -1) {
      loop.currentIndex = nextIndex;
      if (loop.status === 'running') {
        void this.#executeWorkpackage(id, nextIndex);
      }
    } else {
      loop.status = 'completed';
    }

    return this.#serializeLoop(loop);
  }

  async retryFailed(id) {
    const loop = this._loops.get(id);
    if (!loop || (loop.status !== 'error' && loop.status !== 'completed')) return null;

    // Find the first failed workpackage
    const failedIdx = loop.workpackages.findIndex((wp) => wp.status === 'failed');
    if (failedIdx === -1) return null;

    const failedWp = loop.workpackages[failedIdx];

    // Reset the failed workpackage
    failedWp.status = 'pending';
    failedWp.error = undefined;
    failedWp.completedAt = undefined;
    failedWp.sessionId = undefined;
    failedWp.retryCount = 0;
    void this.#updateWorkpackageOnDisk(loop.filePath, loop.directory, failedWp.id, 'pending');

    // Reset all skipped workpackages that came after it
    for (let i = failedIdx + 1; i < loop.workpackages.length; i++) {
      const wp = loop.workpackages[i];
      if (wp.status === 'skipped') {
        wp.status = 'pending';
        wp.error = undefined;
        wp.completedAt = undefined;
        wp.sessionId = undefined;
        void this.#updateWorkpackageOnDisk(loop.filePath, loop.directory, wp.id, 'pending');
      }
    }

    // Restart the loop from the failed task
    loop.status = 'running';
    loop.error = undefined;
    loop.currentIndex = failedIdx;
    loop.lastActivityAt = Date.now();

    void this.#executeWorkpackage(id, failedIdx);

    return this.#serializeLoop(loop);
  }

  async stopLoop(id) {
    const loop = this._loops.get(id);
    if (!loop) return null;

    // Abort and skip running tasks
    for (const wp of loop.workpackages) {
      if (wp.status === 'running') {
        wp.status = 'skipped';
        wp.completedAt = Date.now();
        if (wp.sessionId) {
          void this.#abortSession(wp.sessionId).catch(() => {});
          this._sessionToLoop.delete(wp.sessionId);
        }
        void this.#updateWorkpackageOnDisk(loop.filePath, loop.directory, wp.id, 'skipped');
      }
    }

    // Clean up subagent session tracking
    if (loop.subagentSessionIds) {
      for (const sid of loop.subagentSessionIds) {
        this._sessionToLoop.delete(sid);
      }
    }

    loop.status = 'stopped';
    return this.#serializeLoop(loop);
  }

  updateConfig(id, { providerID, modelID, agent, variant }) {
    const loop = this._loops.get(id);
    if (!loop) return null;
    if (providerID !== undefined) loop.providerID = providerID;
    if (modelID !== undefined) loop.modelID = modelID;
    if (agent !== undefined) loop.agent = agent || undefined;
    if (variant !== undefined) loop.variant = variant || undefined;

    // Persist updated model config to disk
    void this.#saveModelConfigToDisk(loop.filePath, loop.directory, {
      providerID: loop.providerID,
      modelID: loop.modelID,
      variant: loop.variant,
    });

    return this.#serializeLoop(loop);
  }

  /**
   * Called by the global SSE watcher for every SSE event.
   * Handles:
   *  - session.status  → heartbeat + task completion detection
   *  - session.created → adopt subagent sessions whose parent is tracked
   *  - permission.asked → auto-approve permissions for tracked sessions
   *  - message.updated / message.part.updated / message.part.delta → heartbeat
   */
  handleSseEvent(payload) {
    if (!payload) return;

    // ── session.created: adopt subagent sessions ──────────────────────
    if (payload.type === 'session.created') {
      this.#handleSessionCreated(payload);
      return;
    }

    // ── permission.asked: auto-approve for tracked sessions ───────────
    if (payload.type === 'permission.asked') {
      this.#handlePermissionAsked(payload);
      return;
    }

    // ── message / tool activity: reset heartbeat timer ────────────────
    if (
      payload.type === 'message.updated' ||
      payload.type === 'message.part.updated' ||
      payload.type === 'message.part.delta'
    ) {
      this.#handleActivityEvent(payload);
      return;
    }

    // ── session.status: heartbeat + completion ────────────────────────
    if (payload.type !== 'session.status') return;

    const { extractSessionStatusUpdate } = this._deps;
    const update = extractSessionStatusUpdate(payload);
    if (!update) return;

    const { sessionId, type: statusType } = update;

    // Check if this session is one we're tracking
    const loopId = this._sessionToLoop.get(sessionId);
    if (!loopId) return;

    const loop = this._loops.get(loopId);
    if (!loop) return;

    // Record heartbeat on busy/retry
    if (statusType === 'busy' || statusType === 'retry') {
      loop.lastActivityAt = Date.now();
      return;
    }

    // Session went idle → task completed (only for task sessions, not subagents)
    if (statusType === 'idle') {
      // Only trigger completion for actual workpackage task sessions
      const isTaskSession = loop.workpackages.some(
        (wp) => wp.sessionId === sessionId && wp.status === 'running'
      );
      if (isTaskSession) {
        void this.#onSessionCompleted(loopId, sessionId);
      }
    }
  }

  shutdown() {
    if (this._stallCheckInterval) {
      clearInterval(this._stallCheckInterval);
      this._stallCheckInterval = null;
    }
  }

  // ── Internal methods ──────────────────────────────────────────────────

  /**
   * Execute a workpackage by creating a child session and sending the task prompt.
   */
  async #executeWorkpackage(loopId, wpIndex) {
    const loop = this._loops.get(loopId);
    if (!loop || loop.status !== 'running') return;

    const wp = loop.workpackages[wpIndex];
    if (!wp || wp.status !== 'pending') return;

    try {
      // Mark as running
      wp.status = 'running';
      wp.startedAt = Date.now();
      wp.completedAt = undefined;
      loop.currentIndex = wpIndex;
      loop.lastActivityAt = Date.now();

      // Persist running status to disk
      void this.#updateWorkpackageOnDisk(loop.filePath, loop.directory, wp.id, 'running');

      // Create child session
      const session = await this.#createSession({
        title: `Task ${wpIndex + 1}/${loop.workpackages.length}: ${wp.title}`,
        parentID: loop.parentSessionId,
        permission: ALLOW_ALL_PERMISSIONS,
        directory: loop.directory,
      });

      wp.sessionId = session.id;

      // Track this session
      this._sessionToLoop.set(session.id, loopId);

      // Re-check: loop may have been stopped while creating session
      if (loop.status !== 'running') return;

      // Build and send prompt
      const prompt = buildTaskPrompt(wp, loop.filePath, loop.systemPrompt);

      await this.#sendMessage({
        sessionId: session.id,
        providerID: loop.providerID,
        modelID: loop.modelID,
        text: prompt,
        agent: loop.agent,
        variant: loop.variant,
      });
    } catch (error) {
      console.warn(`[AgentLoopService] Failed to execute workpackage ${wp.id}:`, error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      wp.status = 'failed';
      wp.completedAt = Date.now();
      wp.error = errorMsg;

      // Persist failure to disk
      void this.#updateWorkpackageOnDisk(loop.filePath, loop.directory, wp.id, 'failed', errorMsg);

      // Stop the loop – tasks are interdependent so continuing makes no sense
      this.#stopOnFailure(loopId, wpIndex, `Task "${wp.title}" failed to start: ${errorMsg}`);
    }
  }

  /**
   * Detect subagent sessions created by the OpenCode backend whose parent
   * is a session we're already tracking.  Adopt them so we can auto-approve
   * permissions and surface them in the UI.
   */
  #handleSessionCreated(payload) {
    const info = payload.properties?.info;
    if (!info || typeof info !== 'object') return;

    const childId = info.id;
    const parentId = info.parentID;
    if (typeof childId !== 'string' || typeof parentId !== 'string') return;

    // Already tracked — nothing to do
    if (this._sessionToLoop.has(childId)) return;

    // Parent must be a session we're tracking (task session or previously adopted subagent)
    const loopId = this._sessionToLoop.get(parentId);
    if (!loopId) return;

    const loop = this._loops.get(loopId);
    if (!loop) return;

    // Adopt: track the child session under this loop
    this._sessionToLoop.set(childId, loopId);

    // Record in the loop's subagent set for serialization
    if (!loop.subagentSessionIds) {
      loop.subagentSessionIds = new Set();
    }
    loop.subagentSessionIds.add(childId);

    // Update heartbeat
    loop.lastActivityAt = Date.now();

    console.log(
      `[AgentLoopService] Adopted subagent session ${childId} (parent: ${parentId}) into loop "${loop.id}"`
    );

    // Update the subagent session's directory so the frontend groups it
    // under the correct project.
    if (loop.directory) {
      this.#updateSessionDirectory(childId, loop.directory).catch((err) => {
        console.warn(
          `[AgentLoopService] Failed to set directory on subagent session ${childId}:`,
          err?.message || err
        );
      });
    }
  }

  /**
   * Auto-approve permission requests for sessions tracked by an agent loop.
   * Calls POST /permission/{requestID}/reply with { reply: 'always' }.
   */
  #handlePermissionAsked(payload) {
    const props = payload.properties;
    if (!props) return;

    const sessionId =
      props.sessionID ?? props.sessionId ??
      props.info?.sessionID ?? props.info?.sessionId;
    if (typeof sessionId !== 'string') return;

    // Only auto-approve for sessions we're tracking
    if (!this._sessionToLoop.has(sessionId)) return;

    const requestId = props.id ?? props.requestID ?? props.requestId;
    if (typeof requestId !== 'string') return;

    console.log(
      `[AgentLoopService] Auto-approving permission ${requestId} for tracked session ${sessionId}`
    );

    void this.#replyToPermission(requestId).catch((err) => {
      console.warn(`[AgentLoopService] Failed to auto-approve permission ${requestId}:`, err);
    });
  }

  /**
   * Reset the heartbeat timer on message or tool-use activity from tracked sessions.
   * This ensures slow agents that post messages or use tools but don't frequently
   * trigger session.status busy/retry events are not falsely detected as stalled.
   *
   * Event payload shapes:
   *  - message.updated      → { properties: { info: Message } }        → sessionID on info
   *  - message.part.updated → { properties: { part: Part } }           → sessionID on part
   *  - message.part.delta   → { properties: { sessionID, ... } }       → sessionID on properties
   */
  #handleActivityEvent(payload) {
    const props = payload.properties;
    if (!props) return;

    const info = props.info;
    const part = props.part;
    const sessionId =
      info?.sessionID ?? info?.sessionId ??
      part?.sessionID ?? part?.sessionId ??
      props.sessionID ?? props.sessionId;
    if (typeof sessionId !== 'string') return;

    const loopId = this._sessionToLoop.get(sessionId);
    if (!loopId) return;

    const loop = this._loops.get(loopId);
    if (loop) {
      loop.lastActivityAt = Date.now();
    }
  }

  /**
   * Called when a tracked child session goes idle.
   */
  async #onSessionCompleted(loopId, sessionId) {
    const loop = this._loops.get(loopId);
    if (!loop || loop.status !== 'running') return;

    // Find the matching workpackage
    const wpIdx = loop.workpackages.findIndex(
      (wp) => wp.sessionId === sessionId && wp.status === 'running'
    );
    if (wpIdx === -1) return;

    const wp = loop.workpackages[wpIdx];

    // Remove session tracking
    this._sessionToLoop.delete(sessionId);

    // Read workpackage file as source of truth
    let fileStatus = 'completed';
    let failureError;

    try {
      const fileData = await this.#readWorkpackageFile(loop.filePath, loop.directory);
      if (fileData && validateWorkpackageFile(fileData)) {
        const fileWp = fileData.workpackages.find((fw) => fw.id === wp.id) || fileData.workpackages[wpIdx];
        if (fileWp) {
          if (fileWp.status && VALID_PRESERVED_STATUSES.has(fileWp.status)) {
            fileStatus = fileWp.status;
          } else if (fileWp.status === 'running' || fileWp.status === 'pending') {
            fileStatus = 'failed';
            failureError = 'Session ended without completing the task (agent did not update status)';
            void this.#updateWorkpackageOnDisk(loop.filePath, loop.directory, wp.id, 'failed', failureError);
          }
        }
      }
    } catch (err) {
      console.warn(`[AgentLoopService] Failed to read workpackage file for status check:`, err);
    }

    // Update the workpackage
    wp.status = fileStatus;
    wp.completedAt = Date.now();
    if (failureError) wp.error = failureError;

    // If the task failed, stop the loop – tasks are interdependent
    if (fileStatus === 'failed') {
      this.#stopOnFailure(loopId, wpIdx, `Task "${wp.title}" failed${failureError ? ': ' + failureError : ''}`);
      return;
    }

    // Advance to next after delay
    setTimeout(() => {
      this.#advanceToNext(loopId, wpIdx);
    }, TASK_ADVANCEMENT_DELAY_MS);
  }

  /**
   * Advance to the next pending workpackage, or complete the loop.
   */
  #advanceToNext(loopId, currentIndex) {
    const loop = this._loops.get(loopId);
    if (!loop || loop.status !== 'running') return;

    const nextIdx = loop.workpackages.findIndex(
      (wp, i) => i > currentIndex && wp.status === 'pending'
    );

    if (nextIdx !== -1) {
      loop.currentIndex = nextIdx;
      void this.#executeWorkpackage(loopId, nextIdx);
    } else {
      loop.status = 'completed';
    }
  }

  /**
   * Stop the loop when a task fails. Skips all remaining pending tasks
   * since workpackages are interdependent.
   */
  #stopOnFailure(loopId, failedIndex, errorMessage) {
    const loop = this._loops.get(loopId);
    if (!loop) return;

    // Skip all remaining pending workpackages
    for (let i = failedIndex + 1; i < loop.workpackages.length; i++) {
      const wp = loop.workpackages[i];
      if (wp.status === 'pending') {
        wp.status = 'skipped';
        wp.completedAt = Date.now();
        void this.#updateWorkpackageOnDisk(loop.filePath, loop.directory, wp.id, 'skipped');
      }
    }

    loop.status = 'error';
    loop.error = errorMessage;
    console.warn(`[AgentLoopService] Loop stopped: ${errorMessage}`);
  }

  /**
   * Periodically check for stalled sessions and restart or error them.
   * Before declaring a stall, verifies the session's actual status via the
   * OpenCode API to avoid falsely killing sessions that are still active
   * (e.g. during long tool executions or extended thinking).
   */
  async #checkForStalledSessions() {
    const now = Date.now();
    for (const loop of this._loops.values()) {
      if (loop.status !== 'running') continue;

      const runningWpIdx = loop.workpackages.findIndex((wp) => wp.status === 'running');
      if (runningWpIdx === -1) continue;

      const wp = loop.workpackages[runningWpIdx];
      const lastActivity = loop.lastActivityAt || loop.startedAt;
      const elapsed = now - lastActivity;

      if (elapsed < HEARTBEAT_STALL_TIMEOUT_MS) continue;

      // Before declaring stall, verify the session is actually inactive via API.
      // SSE heartbeat events can be missed (e.g. during long tool executions where
      // only message.part.updated events are emitted, or PushWatcher reconnections).
      if (wp.sessionId) {
        try {
          const sessionStatus = await this.#getSessionStatus(wp.sessionId);
          if (sessionStatus === 'busy' || sessionStatus === 'retry') {
            loop.lastActivityAt = Date.now();
            console.log(
              `[AgentLoopService] Session ${wp.sessionId} still ${sessionStatus} despite no SSE heartbeat for ${Math.round(elapsed / 1000)}s. Refreshing heartbeat.`
            );
            continue;
          }
        } catch (err) {
          // If we can't reach the API, give the session the benefit of the doubt
          loop.lastActivityAt = Date.now();
          console.warn(
            `[AgentLoopService] Could not verify session status for ${wp.sessionId}, refreshing heartbeat:`,
            err?.message || err
          );
          continue;
        }
      }

      const retryCount = wp.retryCount || 0;

      console.warn(
        `[AgentLoopService] Stall detected for "${wp.id}" in loop "${loop.id}". ` +
        `No activity for ${Math.round(elapsed / 1000)}s. Retry ${retryCount + 1}/${MAX_STALL_RETRIES}.`
      );

      if (retryCount >= MAX_STALL_RETRIES) {
        // Max retries exceeded — error the entire loop
        const stallError = `Stalled after ${MAX_STALL_RETRIES} retries`;
        const errorMsg =
          `Task "${wp.title}" stalled ${MAX_STALL_RETRIES} times without making progress. ` +
          `The agent loop has been stopped.`;

        wp.status = 'failed';
        wp.completedAt = Date.now();
        wp.error = stallError;
        loop.status = 'error';
        loop.error = errorMsg;

        void this.#updateWorkpackageOnDisk(loop.filePath, loop.directory, wp.id, 'failed', stallError);

        if (wp.sessionId) {
          this._sessionToLoop.delete(wp.sessionId);
          void this.#abortSession(wp.sessionId).catch(() => {});
        }
        continue;
      }

      // Abort and retry
      const oldSessionId = wp.sessionId;
      wp.status = 'pending';
      wp.sessionId = undefined;
      wp.error = undefined;
      wp.startedAt = undefined;
      wp.completedAt = undefined;
      wp.retryCount = retryCount + 1;
      loop.lastActivityAt = now;

      void this.#updateWorkpackageOnDisk(loop.filePath, loop.directory, wp.id, 'pending');

      if (oldSessionId) {
        this._sessionToLoop.delete(oldSessionId);
        void this.#abortSession(oldSessionId).catch(() => {});
      }

      // Re-execute after delay
      setTimeout(() => {
        void this.#executeWorkpackage(loop.id, runningWpIdx);
      }, TASK_ADVANCEMENT_DELAY_MS);
    }
  }

  // ── File I/O ──────────────────────────────────────────────────────────

  async #readWorkpackageFile(filePath, directory) {
    const { fsPromises, resolveWorkspacePath, isPathWithinRoot, path } = this._deps;
    try {
      const resolved = resolveWorkspacePath(filePath, directory);
      if (!resolved.ok) return null;

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase)) return null;

      const content = await fsPromises.readFile(canonicalPath, 'utf8');
      const parsed = JSON.parse(content);

      if (!validateWorkpackageFile(parsed)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async #saveModelConfigToDisk(filePath, directory, { providerID, modelID, variant }) {
    const { fsPromises, resolveWorkspacePath, isPathWithinRoot, path } = this._deps;
    try {
      const resolved = resolveWorkspacePath(filePath, directory);
      if (!resolved.ok) return;

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase)) return;

      const content = await fsPromises.readFile(canonicalPath, 'utf8');
      const parsed = JSON.parse(content);
      if (!validateWorkpackageFile(parsed)) return;

      const modelConfig = {};
      if (providerID) modelConfig.providerID = providerID;
      if (modelID) modelConfig.modelID = modelID;
      if (variant) modelConfig.variant = variant;

      parsed.modelConfig = modelConfig;

      await fsPromises.writeFile(canonicalPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.warn(`[AgentLoopService] Failed to save model config to disk:`, err);
    }
  }

  async #updateWorkpackageOnDisk(filePath, directory, wpId, status, error) {
    const { fsPromises, resolveWorkspacePath, isPathWithinRoot, path } = this._deps;
    try {
      const resolved = resolveWorkspacePath(filePath, directory);
      if (!resolved.ok) return;

      const [canonicalPath, canonicalBase] = await Promise.all([
        fsPromises.realpath(resolved.resolved),
        fsPromises.realpath(resolved.base).catch(() => path.resolve(resolved.base)),
      ]);

      if (!isPathWithinRoot(canonicalPath, canonicalBase)) return;

      const content = await fsPromises.readFile(canonicalPath, 'utf8');
      const parsed = JSON.parse(content);
      if (!validateWorkpackageFile(parsed)) return;

      const wp = parsed.workpackages.find((w) => w.id === wpId);
      if (!wp) return;

      wp.status = status;
      if (typeof error === 'string') {
        wp.error = error;
      } else if (status === 'pending') {
        delete wp.error;
      }

      await fsPromises.writeFile(canonicalPath, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
    } catch (err) {
      console.warn(`[AgentLoopService] Failed to update workpackage on disk:`, err);
    }
  }

  // ── OpenCode API calls ────────────────────────────────────────────────

  async #createSession({ title, parentID, permission, directory }) {
    const { buildOpenCodeUrl, getOpenCodeAuthHeaders } = this._deps;
    let url = buildOpenCodeUrl('/session', '');
    if (directory) {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}directory=${encodeURIComponent(directory)}`;
    }
    const body = { title };
    if (parentID) body.parentID = parentID;
    if (permission) body.permission = permission;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to create session: ${response.status} ${text}`);
    }

    return await response.json();
  }

  async #sendMessage({ sessionId, providerID, modelID, text, agent, variant }) {
    const { buildOpenCodeUrl, getOpenCodeAuthHeaders } = this._deps;
    const url = buildOpenCodeUrl(`/session/${sessionId}/prompt_async`, '');
    const body = {
      parts: [{ type: 'text', text }],
      model: {
        providerID,
        modelID,
      },
    };
    if (agent) body.agent = agent;
    if (variant) body.variant = variant;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      throw new Error(`Failed to send message: ${response.status} ${errText}`);
    }

    return await response.json();
  }

  async #replyToPermission(requestId) {
    const { buildOpenCodeUrl, getOpenCodeAuthHeaders } = this._deps;
    const url = buildOpenCodeUrl(`/permission/${requestId}/reply`, '');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      body: JSON.stringify({ reply: 'always' }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to reply to permission: ${response.status} ${text}`);
    }
  }

  /**
   * Update a session's directory so it is correctly grouped under its project.
   * Uses PATCH /session/:id?directory=:dir (same query-param convention as POST /session).
   */
  async #updateSessionDirectory(sessionId, directory) {
    const { buildOpenCodeUrl, getOpenCodeAuthHeaders } = this._deps;
    let url = buildOpenCodeUrl(`/session/${sessionId}`, '');
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}directory=${encodeURIComponent(directory)}`;

    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...getOpenCodeAuthHeaders(),
      },
      body: JSON.stringify({}),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Failed to update session directory: ${response.status} ${text}`);
    }
  }

  /**
   * Query the OpenCode API for the current status of a session.
   * Returns the status string ('busy', 'idle', 'retry', etc.) or null if unknown.
   */
  async #getSessionStatus(sessionId) {
    const { buildOpenCodeUrl, getOpenCodeAuthHeaders } = this._deps;
    const url = buildOpenCodeUrl(`/session/${sessionId}`, '');

    const response = await fetch(url, {
      headers: getOpenCodeAuthHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Session status check failed: ${response.status}`);
    }

    const session = await response.json();
    return session.status ?? null;
  }

  async #abortSession(sessionId) {
    const { buildOpenCodeUrl, getOpenCodeAuthHeaders } = this._deps;
    const url = buildOpenCodeUrl(`/session/${sessionId}/abort`, '');

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...getOpenCodeAuthHeaders(),
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to abort session: ${response.status}`);
    }
  }

  // ── Serialization ─────────────────────────────────────────────────────

  /**
   * Return a plain-object snapshot of a loop suitable for JSON responses.
   */
  #serializeLoop(loop) {
    // Build flat list of ALL session IDs this loop owns:
    // root session + task sessions + adopted subagent sessions
    const trackedSessionIds = [];
    if (loop.parentSessionId) {
      trackedSessionIds.push(loop.parentSessionId);
    }
    for (const wp of loop.workpackages) {
      if (wp.sessionId) {
        trackedSessionIds.push(wp.sessionId);
      }
    }
    if (loop.subagentSessionIds) {
      for (const id of loop.subagentSessionIds) {
        trackedSessionIds.push(id);
      }
    }

    return {
      id: loop.id,
      name: loop.name,
      status: loop.status,
      workpackages: loop.workpackages.map((wp) => ({
        id: wp.id,
        title: wp.title,
        description: wp.description,
        status: wp.status,
        sessionId: wp.sessionId,
        error: wp.error,
        retryCount: wp.retryCount || 0,
        startedAt: wp.startedAt,
        completedAt: wp.completedAt,
      })),
      filePath: loop.filePath,
      directory: loop.directory,
      providerID: loop.providerID,
      modelID: loop.modelID,
      agent: loop.agent,
      variant: loop.variant,
      systemPrompt: loop.systemPrompt,
      parentSessionId: loop.parentSessionId,
      currentIndex: loop.currentIndex,
      startedAt: loop.startedAt,
      lastActivityAt: loop.lastActivityAt,
      error: loop.error,
      trackedSessionIds,
    };
  }
}

export { AgentLoopService, validateWorkpackageFile };
