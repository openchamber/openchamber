
import { z } from 'zod';

const ISOLATED_WORLD = 'openchamber-agent';

const ANNOTATION_WORLD = 'openchamber-annotation';
const ANNOTATION_BINDING = '__openchamberAnnotationSend';
const ANNOTATION_RECEIVER = '__openchamberAnnotationReceive';
const MAX_ANNOTATION_MESSAGES = 20;
const MAX_ANNOTATION_WAIT_MS = 25_000;

const annotationSendSchema = z.object({ message: z.record(z.string(), z.json()) }).passthrough();
const annotationWaitSchema = z.object({ sessionId: z.number(), timeoutMs: z.number().optional() }).passthrough();
const annotateSchema = z.object({ expression: z.string().min(1), sessionId: z.number() }).passthrough();
const annotationCancelSchema = z.object({ sessionId: z.number() }).passthrough();

const dialogAnswerSchema = z.object({ accept: z.boolean().optional(), promptText: z.string().optional() }).passthrough();
const emulationSchema = z.object({ colorScheme: z.enum(['light', 'dark', 'system']).optional() }).passthrough();

const NAMED_KEYS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const SHIFTED_US_KEYS = {
  '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')',
  '`': '~', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?',
};

// external: https://www.electronjs.org/docs/latest/api/web-contents#contentssendinputeventinputevent macOS editing shortcuts require the corresponding edit command as well as synthesized keys.
const EDITING_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo' };

export const keyEventsFor = (combo, platform = process.platform) => {
  const parts = String(combo || '').split('+').map((part) => part.trim());
  const keyName = parts.pop() ?? '';
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIER_BITS[part];
    if (!bit) throw new Error(`Unknown modifier ${part} in ${combo}; use Alt, Control, Meta or Shift`);
    modifiers |= bit;
  }

  let key;
  let code;
  let keyCode;
  let text;
  const named = NAMED_KEYS[keyName];
  if (named) {
    key = named.key ?? keyName;
    code = named.code;
    keyCode = named.keyCode;
    text = named.text;
  } else if ([...keyName].length === 1) {
    key = (modifiers & MODIFIER_BITS.Shift)
      ? (SHIFTED_US_KEYS[keyName] ?? (/[a-z]/.test(keyName) ? keyName.toUpperCase() : keyName))
      : keyName;
    const upper = keyName.toUpperCase();
    if (/[A-Z]/.test(upper)) {
      code = `Key${upper}`;
      keyCode = upper.charCodeAt(0);
    } else if (/[0-9]/.test(keyName)) {
      code = `Digit${keyName}`;
      keyCode = keyName.charCodeAt(0);
    } else {
      code = '';
      keyCode = 0;
    }
    text = key;
  } else {
    throw new Error(`Unknown key ${keyName || '(empty)'}; use one character or ${Object.keys(NAMED_KEYS).join(', ')}`);
  }

  const chord = modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta | MODIFIER_BITS.Alt);
  if (chord) text = undefined;
  const commandModifier = platform === 'darwin' ? MODIFIER_BITS.Meta : MODIFIER_BITS.Control;
  let command = (modifiers & commandModifier) ? EDITING_COMMANDS[keyName.toLowerCase()] : undefined;
  if (command === 'undo' && (modifiers & MODIFIER_BITS.Shift)) command = 'redo';

  const base = { modifiers, key, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode };
  const down = { ...base, type: text ? 'keyDown' : 'rawKeyDown' };
  if (text) {
    down.text = text;
    down.unmodifiedText = named ? text : keyName;
  }
  if (command) down.commands = [command];
  return [down, { ...base, type: 'keyUp' }];
};

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OWNER_CONTENT_ORIGIN = `function () {
  var rect = this.getBoundingClientRect();
  var style = getComputedStyle(this);
  return {
    x: rect.left + this.clientLeft + parseFloat(style.paddingLeft || '0'),
    y: rect.top + this.clientTop + parseFloat(style.paddingTop || '0')
  };
}`;

export const createBrowserPanelDriver = () => {
  /** @type {WeakMap<Electron.WebContents, Promise<DriverState>>} */
  const states = new WeakMap();

  /**
   * @typedef {{ sessionId: string | undefined, parentSessionId: string | undefined }} TargetSession
   * @typedef {{
   *   contents: Electron.WebContents,
   *   sessions: Map<string, TargetSession>,
   *   dialog: null | { sessionId: string | undefined, type: string, message: string, defaultPrompt: string, url: string },
   *   dialogListeners: Set<(dialog: object) => void>,
   *   autoAnswer: boolean,
   *   accept: boolean,
   *   answered: object[],
   *   ready: Promise<void>,
   *   annotation: null | AnnotationChannel,
   *   annotationEnded: Promise<void>,
   *   annotationCancelledUpTo: number,
   * }} DriverState
   * @typedef {{
   *   sessionId: number,
   *   contextId: number | null,
   *   messages: string[],
   *   waiters: Set<(message: string | null) => void>,
   * }} AnnotationChannel
   */
  let annotationSessions = 0;

  const send = (state, method, params = {}, sessionId = undefined) => (
    state.contents.debugger.sendCommand(method, params, sessionId)
  );

  // external: https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-setAutoAttach Attach only to frames; attaching and detaching workers can crash Electron 45.
  const AUTO_ATTACH_FRAMES_ONLY = [{ type: 'iframe', exclude: false }, { exclude: true }];

  const prepareSession = async (state, sessionId) => {
    await send(state, 'Page.enable', {}, sessionId);
    await send(state, 'Target.setAutoAttach', {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: AUTO_ATTACH_FRAMES_ONLY,
    }, sessionId);
  };

  const onMessage = (state) => (_event, method, params, sessionId) => {
    const fromSession = sessionId || undefined;
    if (method === 'Target.attachedToTarget') {
      const childId = params.sessionId;
      if (params.targetInfo?.type !== 'iframe') return;
      state.sessions.set(childId, { sessionId: childId, parentSessionId: fromSession });
      void prepareSession(state, childId).catch(() => {});
      return;
    }
    if (method === 'Target.detachedFromTarget') {
      state.sessions.delete(params.sessionId);
      return;
    }
    if (method === 'Page.javascriptDialogOpening') {
      if (state.autoAnswer) {
        answerAutomatically(state, fromSession, params);
        return;
      }
      state.dialog = {
        sessionId: fromSession,
        type: String(params.type || 'alert'),
        message: String(params.message || ''),
        defaultPrompt: String(params.defaultPrompt || ''),
        url: String(params.url || ''),
      };
      for (const listener of [...state.dialogListeners]) listener(state.dialog);
      return;
    }
    if (method === 'Page.javascriptDialogClosed') {
      state.dialog = null;
      return;
    }
    if (method === 'Runtime.bindingCalled') {
      const annotation = state.annotation;
      if (!annotation || fromSession || params.name !== ANNOTATION_BINDING) return;
      if (params.executionContextId !== annotation.contextId) return;
      deliverAnnotationMessage(annotation, String(params.payload ?? ''));
    }
  };

  const deliverAnnotationMessage = (annotation, message) => {
    const [waiter] = annotation.waiters;
    if (waiter) {
      waiter(message);
      return;
    }
    if (annotation.messages.length < MAX_ANNOTATION_MESSAGES) annotation.messages.push(message);
  };

  const annotate = async (state, expression, sessionId) => {
    const cancelled = () => sessionId <= state.annotationCancelledUpTo;
    await state.annotationEnded;
    if (cancelled()) return { value: null };
    /** @type {AnnotationChannel} */
    const annotation = { sessionId, contextId: null, messages: [], waiters: new Set() };
    state.annotation = annotation;
    let ended = () => {};
    state.annotationEnded = new Promise((resolve) => { ended = resolve; });
    try {
      const [top] = await listFrames(state);
      annotationSessions += 1;
      const worldName = `${ANNOTATION_WORLD}-${annotationSessions}`;
      await send(state, 'Runtime.enable');
      await send(state, 'Runtime.addBinding', { name: ANNOTATION_BINDING, executionContextName: worldName });
      const world = await send(state, 'Page.createIsolatedWorld', { frameId: top.frameId, worldName });
      annotation.contextId = world.executionContextId;
      if (cancelled()) return { value: null };
      let reply;
      try {
        reply = await send(state, 'Runtime.evaluate', {
          expression,
          contextId: world.executionContextId,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
        });
      } catch {
        return { value: null };
      }
      if (reply.exceptionDetails) {
        const description = reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || 'Script failed';
        throw new Error(String(description).split('\n')[0]);
      }
      return { value: reply.result.value ?? null };
    } finally {
      state.annotation = null;
      for (const waiter of [...annotation.waiters]) waiter(null);
      await send(state, 'Runtime.removeBinding', { name: ANNOTATION_BINDING }).catch(() => {});
      await send(state, 'Runtime.disable').catch(() => {});
      ended();
    }
  };

  const nextAnnotationMessage = (state, sessionId, timeoutMs) => {
    const annotation = state.annotation;
    if (annotation?.sessionId !== sessionId) return Promise.resolve({ ended: true });
    if (annotation.messages.length > 0) return Promise.resolve({ message: annotation.messages.shift() });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        annotation.waiters.delete(waiter);
        resolve({ message: null });
      }, Math.min(MAX_ANNOTATION_WAIT_MS, Math.max(0, timeoutMs)));
      const waiter = (message) => {
        clearTimeout(timer);
        annotation.waiters.delete(waiter);
        resolve(message === null ? { ended: true } : { message });
      };
      annotation.waiters.add(waiter);
    });
  };

  const sendAnnotationMessage = async (state, message) => {
    const annotation = state.annotation;
    if (!annotation?.contextId) return { delivered: false };
    const reply = await send(state, 'Runtime.evaluate', {
      expression: `(function (message) { var receive = window[${JSON.stringify(ANNOTATION_RECEIVER)}]; if (typeof receive === 'function') receive(message); })(${JSON.stringify(message)})`,
      contextId: annotation.contextId,
      returnByValue: true,
    }).catch(() => null);
    return { delivered: Boolean(reply && !reply.exceptionDetails) };
  };

  const MAX_ANSWERED_DIALOGS = 5;

  const answerAutomatically = (state, sessionId, params) => {
    const accept = state.accept;
    const type = String(params.type || 'alert');
    const answer = { accept };
    if (accept && type === 'prompt') answer.promptText = String(params.defaultPrompt || '');
    void send(state, 'Page.handleJavaScriptDialog', answer, sessionId).catch(() => {});
    if (state.answered.length < MAX_ANSWERED_DIALOGS) {
      state.answered.push({ type, message: String(params.message || ''), url: String(params.url || ''), answer: accept ? 'accepted' : 'dismissed' });
    }
  };

  const stateFor = (contents) => {
    const existing = states.get(contents);
    if (existing && contents.debugger.isAttached()) return existing;
    const created = (async () => {
      if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
      /** @type {DriverState} */
      const state = { contents, sessions: new Map(), dialog: null, dialogListeners: new Set(), autoAnswer: false, accept: false, answered: [], ready: Promise.resolve(), annotation: null, annotationEnded: Promise.resolve(), annotationCancelledUpTo: 0 };
      const listener = onMessage(state);
      contents.debugger.on('message', listener);
      contents.debugger.once('detach', () => {
        contents.debugger.removeListener('message', listener);
        if (states.get(contents) === created) states.delete(contents);
      });
      state.ready = prepareSession(state, undefined);
      state.ready.catch(() => {});
      return state;
    })();
    states.set(contents, created);
    created.catch(() => { if (states.get(contents) === created) states.delete(contents); });
    return created;
  };

  const watchingDialog = (state, operation) => new Promise((resolve, reject) => {
    if (state.dialog) {
      resolve({ dialog: publicDialog(state.dialog) });
      return;
    }
    const onDialog = (dialog) => resolve({ dialog: publicDialog(dialog) });
    state.dialogListeners.add(onDialog);
    operation().then(
      (value) => resolve({ value }),
      (error) => reject(error),
    ).finally(() => state.dialogListeners.delete(onDialog));
  });

  const publicDialog = (dialog) => {
    const shown = { type: dialog.type, message: dialog.message, url: dialog.url };
    if (dialog.type === 'prompt') shown.defaultPrompt = dialog.defaultPrompt;
    return shown;
  };

  const listFrames = async (state) => {
    const frames = [];
    const walk = (node, sessionId, parentFrameId) => {
      frames.push({ frameId: node.frame.id, parentFrameId, sessionId, url: String(node.frame.url || '') });
      for (const child of node.childFrames ?? []) walk(child, sessionId, node.frame.id);
    };
    const top = await send(state, 'Page.getFrameTree');
    walk(top.frameTree, undefined, null);
    for (const target of state.sessions.values()) {
      try {
        const tree = await send(state, 'Page.getFrameTree', {}, target.sessionId);
        walk(tree.frameTree, target.sessionId, tree.frameTree.frame.parentId ?? null);
      } catch {
        // A frame that went away between the list and the read.
      }
    }
    return frames;
  };

  const frameById = async (state, frameId) => {
    const frame = (await listFrames(state)).find((entry) => entry.frameId === frameId);
    if (!frame) throw new Error('That frame is gone from the page; take a new snapshot');
    return frame;
  };

  const evaluateInFrame = async (state, frame, expression, { byValue = true } = {}) => {
    const world = await send(state, 'Page.createIsolatedWorld', { frameId: frame.frameId, worldName: ISOLATED_WORLD }, frame.sessionId);
    const reply = await send(state, 'Runtime.evaluate', {
      expression,
      contextId: world.executionContextId,
      returnByValue: byValue,
      awaitPromise: true,
    }, frame.sessionId);
    if (reply.exceptionDetails) {
      const description = reply.exceptionDetails.exception?.description || reply.exceptionDetails.text || 'Script failed';
      throw new Error(String(description).split('\n')[0]);
    }
    return byValue ? reply.result.value : reply.result;
  };

  const ownerOrigin = async (state, frame, parent) => {
    const owner = await send(state, 'DOM.getFrameOwner', { frameId: frame.frameId }, parent.sessionId);
    const resolved = await send(state, 'DOM.resolveNode', { backendNodeId: owner.backendNodeId }, parent.sessionId);
    try {
      const reply = await send(state, 'Runtime.callFunctionOn', {
        objectId: resolved.object.objectId,
        functionDeclaration: OWNER_CONTENT_ORIGIN,
        returnByValue: true,
      }, parent.sessionId);
      return reply.result.value;
    } finally {
      void send(state, 'Runtime.releaseObject', { objectId: resolved.object.objectId }, parent.sessionId).catch(() => {});
    }
  };

  const frameOrigin = async (state, frame, within) => {
    const frames = await listFrames(state);
    let x = 0;
    let y = 0;
    let current = frame;
    while (current.parentFrameId) {
      const parent = frames.find((entry) => entry.frameId === current.parentFrameId);
      if (!parent) throw new Error('The frame holding this element is gone; take a new snapshot');
      if (within === 'session' && parent.sessionId !== current.sessionId) break;
      const origin = await ownerOrigin(state, current, parent);
      x += origin.x;
      y += origin.y;
      current = parent;
    }
    return { x, y };
  };

  const inputTarget = async (state, value, name) => {
    const local = point(value, name);
    const frame = await frameById(state, String(value?.frameId ?? ''));
    const origin = await frameOrigin(state, frame, 'session');
    return { sessionId: frame.sessionId, x: origin.x + local.x, y: origin.y + local.y };
  };

  const mouse = (state, type, at, extra = {}) => send(state, 'Input.dispatchMouseEvent', {
    type,
    x: at.x,
    y: at.y,
    button: type === 'mouseMoved' ? 'none' : 'left',
    buttons: type === 'mousePressed' ? 1 : 0,
    clickCount: type === 'mouseMoved' ? 0 : 1,
    ...extra,
  }, at.sessionId);

  const drag = async (state, from, to) => {
    if (from.sessionId !== to.sessionId) throw new Error('Both ends of a drag must be in the same frame of the page');
    const sessionId = from.sessionId;
    await mouse(state, 'mouseMoved', from);
    await mouse(state, 'mousePressed', from);
    const steps = 8;
    for (let step = 1; step <= steps; step += 1) {
      const at = { sessionId, x: from.x + ((to.x - from.x) * step) / steps, y: from.y + ((to.y - from.y) * step) / steps };
      await mouse(state, 'mouseMoved', at, { button: 'left', buttons: 1 });
      await delay(16);
    }
    await mouse(state, 'mouseReleased', to);
  };

  const point = (value, name) => {
    const x = Number(value?.x);
    const y = Number(value?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`${name} needs x and y`);
    return { x, y };
  };

  const NEEDS_NO_PAGE = new Set(['dialog', 'dialogPolicy', 'armDialog', 'takeAnsweredDialogs', 'answerDialog', 'emulate', 'annotationMessage', 'annotationSend', 'annotationCancel']);

  const run = async (contents, op, args) => {
    const state = await stateFor(contents);
    if (!NEEDS_NO_PAGE.has(op)) await state.ready;
    switch (op) {
      case 'frames':
        return (await listFrames(state)).map(({ frameId, parentFrameId, url }) => ({ frameId, parentFrameId, url }));
      case 'evaluate': {
        const frame = await frameById(state, String(args.frameId ?? ''));
        return watchingDialog(state, () => evaluateInFrame(state, frame, String(args.expression ?? '')));
      }
      case 'annotate': {
        const { expression, sessionId } = annotateSchema.parse(args);
        return annotate(state, expression, sessionId);
      }
      case 'annotationMessage': {
        const { sessionId, timeoutMs } = annotationWaitSchema.parse(args);
        return nextAnnotationMessage(state, sessionId, timeoutMs ?? MAX_ANNOTATION_WAIT_MS);
      }
      case 'annotationCancel': {
        const { sessionId } = annotationCancelSchema.parse(args);
        state.annotationCancelledUpTo = Math.max(state.annotationCancelledUpTo, sessionId);
        return { cancelled: true };
      }
      case 'annotationSend':
        return sendAnnotationMessage(state, annotationSendSchema.parse(args).message);
      case 'frameOrigin': {
        const frame = await frameById(state, String(args.frameId ?? ''));
        return frameOrigin(state, frame, 'top');
      }
      case 'click': {
        const at = await inputTarget(state, args, 'click');
        const clickCount = Number.isInteger(args.clickCount) && args.clickCount > 0 ? Math.min(args.clickCount, 3) : 1;
        return watchingDialog(state, async () => {
          await mouse(state, 'mouseMoved', at);
          await mouse(state, 'mousePressed', at, { clickCount });
          await mouse(state, 'mouseReleased', at, { clickCount });
        });
      }
      case 'hover': {
        const at = await inputTarget(state, args, 'hover');
        return watchingDialog(state, () => mouse(state, 'mouseMoved', at));
      }
      case 'drag': {
        const from = await inputTarget(state, args.from, 'from');
        const to = await inputTarget(state, args.to, 'to');
        return watchingDialog(state, () => drag(state, from, to));
      }
      case 'press': {
        const events = keyEventsFor(args.key);
        return watchingDialog(state, async () => {
          for (const event of events) {
            if (Date.now() >= args.expiresAt) throw new Error('Browser keyboard action expired');
            if (!contents.isFocused()) {
              if (event.type === 'keyUp') break;
              throw new Error('Browser page lost keyboard focus');
            }
            await send(state, 'Input.dispatchKeyEvent', event);
          }
        });
      }
      case 'insertText':
        return watchingDialog(state, async () => {
          if (Date.now() >= args.expiresAt) throw new Error('Browser keyboard action expired');
          if (!contents.isFocused()) throw new Error('Browser page lost keyboard focus');
          return send(state, 'Input.insertText', { text: String(args.text ?? '') });
        });
      case 'setFiles': {
        const frame = await frameById(state, String(args.frameId ?? ''));
        const files = Array.isArray(args.files) ? args.files.map(String) : [];
        const handle = await evaluateInFrame(state, frame, String(args.expression ?? ''), { byValue: false });
        if (!handle?.objectId) throw new Error('The file input is gone; take a new snapshot');
        try {
          await send(state, 'DOM.setFileInputFiles', { objectId: handle.objectId, files }, frame.sessionId);
        } finally {
          void send(state, 'Runtime.releaseObject', { objectId: handle.objectId }, frame.sessionId).catch(() => {});
        }
        return { files: files.length };
      }
      case 'dialog':
        return state.dialog ? publicDialog(state.dialog) : null;
      case 'dialogPolicy': {
        state.autoAnswer = args.auto === true;
        const open = state.dialog;
        if (state.autoAnswer && open) {
          state.dialog = null;
          answerAutomatically(state, open.sessionId, { type: open.type, message: open.message, url: open.url, defaultPrompt: open.defaultPrompt });
        }
        return { auto: state.autoAnswer };
      }
      case 'armDialog':
        state.accept = args.accept === true;
        return { accept: state.accept };
      case 'takeAnsweredDialogs': {
        const answered = state.answered;
        state.answered = [];
        return answered;
      }
      case 'answerDialog': {
        const dialog = state.dialog;
        if (!dialog) throw new Error('No dialog is open on this page');
        const answer = dialogAnswerSchema.parse(args);
        const reply = { accept: answer.accept === true };
        if (answer.promptText !== undefined) reply.promptText = answer.promptText;
        await send(state, 'Page.handleJavaScriptDialog', reply, dialog.sessionId);
        return { answered: publicDialog(dialog), accepted: args.accept === true };
      }
      case 'emulate': {
        if (args.pageBackground === true) {
          await send(state, 'Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 1 } });
        }
        if (args.focus === true) await send(state, 'Emulation.setFocusEmulationEnabled', { enabled: true });
        const { colorScheme } = emulationSchema.parse(args);
        if (colorScheme) {
          await send(state, 'Emulation.setEmulatedMedia', colorScheme === 'system'
            ? { features: [] }
            : { features: [{ name: 'prefers-color-scheme', value: colorScheme }] });
        }
        return { applied: true };
      }
      default:
        throw new Error(`Unknown browser driver operation: ${op}`);
    }
  };

  return { run };
};
