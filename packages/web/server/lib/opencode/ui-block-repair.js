import { createMessageId } from '../dispatch-results/runtime.js';
import { closedUiBlocks, validateUiBlock } from './ui-block-validation.generated.js';

const MAX_TEXT = 512 * 1024; // JavaScript string code units per live text part.
const REPAIR_PROMPT = 'Fix this UI block, then continue the unfinished answer without repeating completed content or tools.';

/** Live text events own repair, independently of browser connections or rendering. */
export function createUiBlockRepair({ clientFor, onStop }) {
  const sessions = new Map();
  const record = (outcome) => console.info(`[ui-block-repair] ${outcome}`);
  const cancel = (sessionId) => {
    const state = sessions.get(sessionId);
    if (!state) return;
    sessions.delete(sessionId);
    state.controller.abort();
    // Admission cannot be recalled. A user's stop must follow any admission already sent.
    return state.delivery?.catch(() => {});
  };
  const reset = () => { for (const id of sessions.keys()) cancel(id); };

  const repair = async (sessionId, state, errors) => {
    const previousDelivery = state.delivery;
    const terminal = Promise.withResolvers();
    state.operation = terminal;
    state.attempts += 1;
    state.phase = 'settling';
    state.parts.clear();
    const current = () => sessions.get(sessionId) === state;
    const options = { signal: AbortSignal.any([state.controller.signal, AbortSignal.timeout(30_000)]) };
    const aborted = () => terminal.resolve();
    options.signal.addEventListener('abort', aborted, { once: true });
    try {
      const client = clientFor(state.directory);
      // Interrupt each bad successor immediately. Only its next admission waits
      // for the preceding admission's HTTP response.
      await client.session.interrupt({ sessionID: sessionId }, options);
      if (!current()) return;
      await client.experimental.session.wait({ sessionID: sessionId }, options);
      // HTTP completion and event delivery have independent ordering. Wait for
      // this execution's terminal event before admitting its successor.
      await terminal.promise;
      await previousDelivery;
      options.signal.throwIfAborted();
      if (!current()) return;
      state.phase = 'delivering';
      const inputId = createMessageId(Date.now());
      state.inputId = inputId;
      // Do not abort admission with the task: Stop must wait for its response
      // before reaching OpenCode, or the newly admitted execution could escape.
      state.delivery = client.session.synthetic({
        sessionID: sessionId, id: inputId, resume: true,
        metadata: { openchamberUiBlockRepair: true },
        text: `${REPAIR_PROMPT}\n${errors.slice(0, 6).map((error) => error.slice(0, 500)).join('\n')}`,
      }, { signal: AbortSignal.timeout(30_000) });
      await state.delivery;
      record('submitted');
    } catch {
      if (current()) {
        record('upstream_failed');
        onStop?.(sessionId, state.directory);
        cancel(sessionId);
      }
    } finally {
      options.signal.removeEventListener('abort', aborted);
      // An older admission may finish after its successor has started repair.
      if (state.operation === terminal) {
        state.delivery = null;
        state.operation = null;
        if (current() && state.phase === 'idle') sessions.delete(sessionId);
      }
    }
  };

  const inspect = (sessionId, state, part, key, ended) => {
    if (!part.text.includes('openui-lang')) return;
    try {
      for (const block of closedUiBlocks(part.text, ended)) {
        if (block.offset < part.checkedThrough) continue;
        part.checkedThrough = block.offset + 1;
        const errors = validateUiBlock(block.source);
        if (!errors.length) continue;
        record('invalid');
        if (state.attempts >= 2) { record('budget_exhausted'); return; }
        void repair(sessionId, state, errors);
        return;
      }
    } catch {
      record('validation_failed');
      state.parts.delete(key);
    }
  };

  // True only for a terminal event consumed by repair. Goal Mode must not
  // interpret that event as user cancellation or start a competing continuation.
  const onEvent = ({ payload, directory, spaceId }) => {
    if (spaceId) return;
    const { type, data = {} } = payload;
    const id = data.sessionID;
    if (!id) return;
    let state = sessions.get(id);
    if (type === 'session.inbox.enqueued') {
      if (data.inboxID !== state?.inputId) cancel(id);
      return;
    }
    if (type === 'session.execution.started') {
      if (!state) {
        state = { directory: null, attempts: 0, parts: new Map(), controller: new AbortController(), operation: null, inputId: null, delivery: null };
        sessions.set(id, state);
      }
      // Admission acknowledgement may arrive after the successor starts streaming.
      state.phase = 'running';
      state.parts.clear();
      return;
    }
    if (!state) return;
    if (type === 'session.execution.succeeded'
      || (type === 'session.execution.interrupted' && state.phase === 'settling' && data.reason !== 'shutdown')) {
      const repairing = state.phase === 'settling';
      if (state.operation) { state.phase = 'idle'; state.parts.clear(); state.operation.resolve(); }
      else cancel(id);
      return repairing;
    }
    if (['session.execution.failed', 'session.execution.interrupted', 'session.deleted', 'session.moved'].includes(type)) {
      cancel(id);
      return;
    }
    if (state.phase !== 'running') return;
    const key = `${data.assistantMessageID}:text:${data.ordinal}`;
    if (type === 'session.text.started') {
      state.directory = directory;
      state.parts.set(key, { text: '', lineStart: 0, checkedThrough: 0 });
      return;
    }
    const part = state.parts.get(key);
    const ended = type === 'session.text.ended';
    if (ended) state.parts.delete(key);
    if (!part) return;
    if (!ended && type !== 'session.text.delta') return;
    if (ended && !data.text.startsWith(part.text)) { record('source_mismatch'); return; }
    part.text = ended ? data.text : part.text + data.delta;
    if (part.text.length > MAX_TEXT) {
      state.parts.delete(key);
      record('text_limit');
      return;
    }
    if (ended) inspect(id, state, part, key, true);
    else {
      // Cheap incremental line scan. Markdown parsing runs only at possible fence
      // closures, never on every token or on ordinary prose-only answers.
      let candidate = false;
      let end;
      while ((end = part.text.indexOf('\n', part.lineStart)) !== -1) {
        if (/(?:`{3,}|~{3,})[ \t]*\r?$/.test(part.text.slice(part.lineStart, end))) candidate = true;
        part.lineStart = end + 1;
      }
      if (candidate) inspect(id, state, part, key, false);
    }
  };

  const registerRoutes = (app) => {
    // Mounted after auth and space dispatch, before OpenCode's proxy.
    app.use(async (req, _res, next) => {
      const match = /^\/api\/session\/([^/]+)(?:\/(?:interrupt|prompt|command|synthetic|shell|compact|revert|move|agent|model)(?:\/|$)|\/?$)/.exec(req.path);
      if (match && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
        const id = decodeURIComponent(match[1]);
        const state = sessions.get(id);
        // Our terminal event may already have been consumed. Interrupting an
        // idle OpenCode emits no second event, so forward explicit Stop here too.
        if (state?.operation && req.path.endsWith('/interrupt')) onStop?.(id, state.directory);
        await cancel(id);
      }
      next();
    });
  };
  return { onEvent, reset, registerRoutes };
}
