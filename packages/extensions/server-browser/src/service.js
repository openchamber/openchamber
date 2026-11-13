import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import {
  BROWSER_PROVIDER_ACTION_TIMEOUT_MS,
  BROWSER_PROVIDER_OPEN_TIMEOUT_MS,
  BROWSER_PROVIDER_PATH,
  SURFACE_AGENT_ACTIVE_HEADER,
  SURFACE_AUDIO_CHANNELS_HEADER,
  SURFACE_AUDIO_CODEC_HEADER,
  SURFACE_AUDIO_PATH,
  SURFACE_AUDIO_SAMPLE_RATE_HEADER,
  SURFACE_CLIPBOARD_PATH,
  SURFACE_CONTROL_PATH,
  SURFACE_FRAME_PATH,
  SURFACE_FRAME_SEQ_HEADER,
  SURFACE_FRAME_WAIT_MS,
  SURFACE_HEIGHT_HEADER,
  SURFACE_INPUT_PATH,
  SURFACE_RESIZE_PATH,
  SURFACE_SEQ_HEADER,
  SURFACE_TITLE_HEADER,
  SURFACE_TITLE_MAX,
  SURFACE_VIEWER_CONTROLS_HEADER,
  SURFACE_VIEWER_HEADER,
  SURFACE_WIDTH_HEADER,
  readBrowserProviderRequest,
  readSurfaceControlNotice,
  readSurfaceInputBatch,
  readSurfaceResizeRequest,
} from '@openchamber/sdk';
import { readMenuTheme } from './context-menu.js';
import { InspectorError } from './inspector.js';
import { MAX_VIEWPORT_DIMENSION } from './viewports.js';

// A held state request stays under the host proxy's 20 s timeout.
const STATE_WAIT_MAX_MS = 15_000;
const STATE_WAIT_STEP_MS = 60;

const BODY_MAX_BYTES = 17 * 1024 * 1024;
export const HELP_ACTION = 'browser.requestHelp';
export const SAVE_ACTION = 'browser.saveProfile';
const SAVE_TIMEOUT_MS = 45_000;
const HELP_KINDS = new Set(['login', 'page', 'profile']);
const PROFILE_NAME_MAX = 80;
const HELP_TIMEOUT_MIN_S = 30;
const HELP_TIMEOUT_MAX_S = 900;
const HELP_TIMEOUT_DEFAULT_S = 300;
const HELP_REASON_MAX = 300;

// The host's own `readBrowserProviderRequest` recognizes these two actions
// too and validated their parameters before sending, but this engine is
// also exercised directly (tests, a standalone host on an older published
// SDK) without that upstream check, so it re-validates and defaults
// `timeoutSeconds`/`kind` itself rather than trusting a passthrough shape.
export const readHelpRequest = (body) => {
  let wire;
  try {
    wire = JSON.parse(body);
  } catch {
    return null;
  }
  if (!wire || typeof wire !== 'object' || (wire.action !== HELP_ACTION && wire.action !== SAVE_ACTION)) return null;
  if (typeof wire.requestId !== 'string' || wire.requestId.length === 0) return null;
  const parameters = wire.parameters;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return null;
  const text = (value) => (typeof value === 'string' && value.length > 0 ? value : null);
  const context = { directory: text(wire.context?.directory), sessionId: text(wire.context?.sessionId) };
  if (parameters.tabId !== undefined && (typeof parameters.tabId !== 'string' || parameters.tabId.length === 0 || parameters.tabId.length > 128)) return null;
  if (wire.action === SAVE_ACTION) return { requestId: wire.requestId, action: SAVE_ACTION, parameters: {}, context };
  const kind = parameters.kind ?? 'page';
  if (!HELP_KINDS.has(kind)) return null;
  const reason = typeof parameters.reason === 'string' ? parameters.reason.trim() : '';
  const timeoutSeconds = parameters.timeoutSeconds ?? HELP_TIMEOUT_DEFAULT_S;
  if (reason.length === 0 || reason.length > HELP_REASON_MAX) return null;
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < HELP_TIMEOUT_MIN_S || timeoutSeconds > HELP_TIMEOUT_MAX_S) return null;
  const helpParameters = { reason, timeoutSeconds, kind };
  if (parameters.tabId !== undefined) helpParameters.tabId = parameters.tabId;
  if (parameters.profileName !== undefined) {
    const profileName = String(parameters.profileName).trim();
    if (kind !== 'profile' || profileName.length === 0 || profileName.length > PROFILE_NAME_MAX) return null;
    helpParameters.profileName = profileName;
  }
  return { requestId: wire.requestId, action: HELP_ACTION, parameters: helpParameters, context };
};

const actionDeadlineMs = (parsed) => {
  // The host waits timeoutSeconds plus 15 seconds; the wait itself ends at timeoutSeconds.
  if (parsed.action === HELP_ACTION) return parsed.parameters.timeoutSeconds * 1000 + 10_000;
  if (parsed.action === SAVE_ACTION) return SAVE_TIMEOUT_MS - 2_000;
  return (parsed.action === 'browser.open' ? BROWSER_PROVIDER_OPEN_TIMEOUT_MS : BROWSER_PROVIDER_ACTION_TIMEOUT_MS) - 2_000;
};

const json = (response, status, body) => {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes.length,
  });
  response.end(bytes);
};

const text = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(body);
};

const authorized = (request, token) => {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(token);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
};

// Typed dock addresses follow the omnibox: bare IPs and localhost are usually
// plain-HTTP dev servers, other hosts default to HTTPS.
const withScheme = (address) => {
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(address)) return address;
  const host = address.split(/[/?#]/, 1)[0].replace(/:\d*$/, '').replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return `${host === 'localhost' || net.isIP(host) ? 'http' : 'https'}://${address}`;
};

const readBody = async (request) => {
  const contentLength = Number(request.headers['content-length'] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > BODY_MAX_BYTES) throw new Error('Request body is too large');
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > BODY_MAX_BYTES) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, length).toString('utf8');
};

const queryInteger = (url, name, fallback, maximum) => {
  const raw = url.searchParams.get(name);
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= maximum ? value : null;
};

const errorMessage = (error) => {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Browser action was cancelled';
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'The page did not respond in time';
  if (error instanceof Error && error.message.trim()) return error.message;
  return 'Unknown browser state';
};

const surfaceTitleHeader = (value) => Array.from(String(value ?? ''), (character) => {
  const codePoint = character.codePointAt(0);
  if (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159)) return ' ';
  if (codePoint > 255) return '?';
  return character;
}).join('').trim().slice(0, SURFACE_TITLE_MAX);

const readObjectBody = async (request) => {
  try {
    const parsed = JSON.parse(await readBody(request));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const stringProperty = (value, name) => (
  typeof value?.[name] === 'string' && value[name].length > 0 ? value[name] : null
);

const generationProperty = (value) => (
  Number.isInteger(value?.generation) && value.generation >= 0 ? value.generation : null
);

const viewportDimension = (value) => Number.isInteger(value) && value >= 1 && value <= MAX_VIEWPORT_DIMENSION;

const PROMPT_TEXT_MAX = 10_000;
const CHOSEN_FILES_MAX = 32;
const FILE_NAME_MAX = 255;

const requestNumber = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null);

// `{ tabId, dialogId, accept, promptText? }`: the dialog the dock showed.
const readDialogAnswer = (body) => {
  const tabId = identityProperty(body, 'tabId');
  const dialogId = requestNumber(body?.dialogId);
  if (!tabId || dialogId === null || typeof body.accept !== 'boolean') return null;
  if (body.promptText !== undefined && (typeof body.promptText !== 'string' || body.promptText.length > PROMPT_TEXT_MAX)) return null;
  return { tabId, dialogId, accept: body.accept, ...(body.promptText === undefined ? {} : { promptText: body.promptText }) };
};

// `{ tabId, chooserId, files }` with the names uploaded, or `cancel: true`.
const readFileChooserAnswer = (body) => {
  const tabId = identityProperty(body, 'tabId');
  const chooserId = requestNumber(body?.chooserId);
  if (!tabId || chooserId === null) return null;
  if (body.cancel === true) return { tabId, chooserId, files: null };
  const { files } = body;
  if (!Array.isArray(files) || files.length === 0 || files.length > CHOSEN_FILES_MAX) return null;
  if (!files.every((name) => typeof name === 'string' && name.length > 0 && name.length <= FILE_NAME_MAX)) return null;
  return { tabId, chooserId, files };
};

const readViewportRequest = (value) => {
  if (typeof value?.mobile !== 'boolean') return null;
  if (value.mode === 'auto') return { mode: 'auto', mobile: value.mobile };
  if (value.mode !== 'fixed' || !viewportDimension(value.width) || !viewportDimension(value.height)) return null;
  return { mode: 'fixed', width: value.width, height: value.height, mobile: value.mobile };
};

const dockErrorStatus = (error) => {
  const message = errorMessage(error);
  if (/surface is idle|browser view changed|agent is using/i.test(message)) return 409;
  if (/no browser scope|no longer exists|no longer open/i.test(message)) return 404;
  return 400;
};

const INSPECTOR_STATUS = Object.freeze({
  UNAVAILABLE: 409,
  AGENT_ACTIVE: 409,
  INVALID_REQUEST: 400,
  CAPTURE_GONE: 410,
  REQUEST_GONE: 410,
  EVALUATION_FAILED: 422,
  EVALUATION_TIMEOUT: 422,
  REQUEST_FAILED: 502,
  CAPTURE_FAILED: 502,
});

const identityProperty = (value, name) => {
  const text = stringProperty(value, name);
  return text && text.length <= 128 ? text : null;
};

// The host sets these on requests from a window with a live viewer: which
// viewer, whether it holds control, and our number of the frame it last drew.
const viewerOf = (request) => {
  const viewer = request.headers[SURFACE_VIEWER_HEADER];
  return typeof viewer === 'string' && viewer.length > 0 && viewer.length <= 128 ? viewer : null;
};

const frameSeqOf = (request) => {
  const value = request.headers[SURFACE_FRAME_SEQ_HEADER];
  return typeof value === 'string' && /^\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
};

// A dock request acts for its viewer only while the host says that viewer holds control.
const dockAccess = (request) => ({
  viewer: request.headers[SURFACE_VIEWER_CONTROLS_HEADER] === '1' ? viewerOf(request) : null,
  frameSeq: frameSeqOf(request),
});

// Console, network, and JavaScript for the inspector page. Errors carry a code
// the page can act on, such as CAPTURE_GONE to start a fresh capture.
const handleInspector = async (runtime, operation, request, url) => {
  if (operation === 'events') {
    const captureId = url.searchParams.get('captureId');
    const after = queryInteger(url, 'after', 0, Number.MAX_SAFE_INTEGER);
    if (request.method !== 'GET' || !captureId || captureId.length > 128 || after === null) return null;
    return runtime.inspectorEvents(captureId, after);
  }
  if (request.method !== 'POST') return null;
  const body = await readObjectBody(request);
  if (operation === 'start') return runtime.inspectorStart();
  const captureId = identityProperty(body, 'captureId');
  if (!captureId) return null;
  if (operation === 'stop') {
    runtime.inspectorStop(captureId);
    return { ok: true };
  }
  if (operation === 'clear') {
    if (body.scope !== 'console' && body.scope !== 'network') return null;
    runtime.inspectorClear(captureId, body.scope);
    return { ok: true };
  }
  if (operation === 'evaluate') {
    if (typeof body.expression !== 'string') return null;
    return runtime.inspectorEvaluate(captureId, body.expression);
  }
  const entryId = identityProperty(body, 'entryId');
  if (!entryId || typeof body.includeBody !== 'boolean') return null;
  return runtime.inspectorRequest(captureId, entryId, body.includeBody);
};

export const createService = ({ runtime, token, port = 0, chromeStatus = null, profileSites = null, networkPolicy = null }) => {
  if (!runtime?.perform || !runtime?.close) throw new Error('createService requires a browser runtime');
  if (typeof token !== 'string' || token.length === 0) throw new Error('createService requires a bearer token');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Service port must be from 0 to 65535');
  const activeRequests = new Set();
  let listening = false;
  let closePromise = null;

  const handle = async (request, response, signal) => {
    if (!authorized(request, token)) return text(response, 401, 'Unauthorized\n');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });

    if (request.method === 'POST' && url.pathname === BROWSER_PROVIDER_PATH) {
      const body = await readBody(request);
      // The current SDK's own reader now also recognizes these two action
      // names, but it only checks the envelope, not field bounds; a bare
      // action name alone decides which reader governs, so an out-of-range
      // `timeoutSeconds` or empty `reason` cannot fall through to the
      // permissive reader's passthrough instead of being refused.
      const wireAction = (() => {
        try {
          const wire = JSON.parse(body);
          return wire && typeof wire === 'object' ? wire.action : null;
        } catch {
          return null;
        }
      })();
      const parsed = wireAction === HELP_ACTION || wireAction === SAVE_ACTION
        ? readHelpRequest(body)
        : readBrowserProviderRequest(body);
      if (!parsed) return text(response, 400, 'Invalid browser provider request\n');
      try {
        // The host replaces a service that misses its deadline, and every chat's
        // browser goes with it, so an action gives up shortly before.
        const deadline = AbortSignal.timeout(actionDeadlineMs(parsed));
        const actionSignal = AbortSignal.any([signal, deadline]);
        const data = parsed.action === HELP_ACTION
          ? await runtime.requestHelp(parsed.parameters, actionSignal, parsed.context)
          : parsed.action === SAVE_ACTION
          ? await runtime.saveProfile(parsed.parameters, actionSignal, parsed.context)
          : await runtime.perform(parsed.action, parsed.parameters, actionSignal, parsed.context);
        return json(response, 200, { ok: true, data });
      } catch (error) {
        return json(response, 200, { ok: false, error: errorMessage(error) });
      }
    }
    const access = dockAccess(request);

    if (request.method === 'GET' && url.pathname === '/browser/state') {
      const options = { problems: url.searchParams.get('problems') === '1' };
      const versioned = () => {
        const state = runtime.state(access, options);
        const version = crypto.createHash('sha1').update(JSON.stringify(state)).digest('base64url').slice(0, 16);
        return { ...state, version };
      };
      // `since` + `wait`: answer as soon as the state differs from the
      // version the dock already has, so its address bar, tabs, and loading
      // state follow the page instead of a fixed poll.
      const since = url.searchParams.get('since');
      const wait = Math.min(STATE_WAIT_MAX_MS, Math.max(0, Number(url.searchParams.get('wait')) || 0));
      let current = versioned();
      if (since && wait > 0 && current.version === since) {
        const deadline = Date.now() + wait;
        let gone = false;
        response.once('close', () => { gone = true; });
        while (!gone && Date.now() < deadline && current.version === since) {
          await new Promise((resolve) => setTimeout(resolve, STATE_WAIT_STEP_MS));
          current = versioned();
        }
      }
      return json(response, 200, current);
    }

    if (request.method === 'POST' && url.pathname === '/browser/scope') {
      const body = await readObjectBody(request);
      const directory = stringProperty(body, 'directory');
      const sessionId = stringProperty(body, 'sessionId');
      const generation = generationProperty(body);
      if (!directory || directory.length > 4096 || !sessionId || sessionId.length > 256 || generation === null) {
        return text(response, 400, 'directory, sessionId, and generation are required\n');
      }
      try {
        await runtime.openScope({ directory, sessionId }, generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/browser/select') {
      const body = await readObjectBody(request);
      const id = stringProperty(body, 'scopeId');
      const generation = generationProperty(body);
      if (!id || generation === null) return text(response, 400, 'scopeId and generation are required\n');
      try {
        await runtime.selectScope(id, generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/browser/navigate') {
      const body = await readObjectBody(request);
      const target = stringProperty(body, 'url');
      const generation = generationProperty(body);
      if (!target || generation === null) return text(response, 400, 'url and generation are required\n');
      try {
        await runtime.navigate(withScheme(target), generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    const historyCommands = ['/browser/back', '/browser/forward', '/browser/reload', '/browser/stop'];
    if (request.method === 'POST' && historyCommands.includes(url.pathname)) {
      const body = await readObjectBody(request);
      const generation = generationProperty(body);
      if (generation === null) return text(response, 400, 'generation is required\n');
      try {
        if (url.pathname === '/browser/back') await runtime.back(generation, access);
        else if (url.pathname === '/browser/forward') await runtime.forward(generation, access);
        else if (url.pathname === '/browser/stop') await runtime.stop(generation, access);
        else await runtime.reload(generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    const tabOperation = request.method === 'POST' ? /^\/browser\/tabs\/(new|select|close)$/.exec(url.pathname)?.[1] : null;
    if (tabOperation) {
      const body = await readObjectBody(request);
      const generation = generationProperty(body);
      const tabId = stringProperty(body, 'tabId');
      if (generation === null || (tabOperation !== 'new' && !tabId)) {
        return text(response, 400, 'generation is required, and tabId to select or close a tab\n');
      }
      try {
        if (tabOperation === 'new') await runtime.newTab(generation, access);
        else if (tabOperation === 'select') await runtime.selectTab(tabId, generation, access);
        else await runtime.closeTab(tabId, generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/browser/viewer') {
      const body = await readObjectBody(request);
      const ratio = body?.devicePixelRatio;
      const theme = body?.theme === undefined ? undefined : readMenuTheme(body.theme);
      const validRatio = typeof ratio === 'number' && Number.isFinite(ratio) && ratio >= 0.25 && ratio <= 8;
      if ((ratio !== undefined && !validRatio) || theme === null || (ratio === undefined && theme === undefined)) {
        return text(response, 400, 'Send devicePixelRatio from 0.25 to 8, a host theme, or both\n');
      }
      if (theme) runtime.setViewerTheme(theme);
      if (validRatio) await runtime.setDevicePixelRatio(ratio);
      return json(response, 200, runtime.state());
    }

    if (request.method === 'POST' && url.pathname === '/browser/viewport') {
      const body = await readObjectBody(request);
      const generation = generationProperty(body);
      const viewport = readViewportRequest(body);
      if (generation === null || !viewport) {
        return text(response, 400, `generation, mode, and mobile are required, and a fixed size needs width and height from 1 to ${MAX_VIEWPORT_DIMENSION}\n`);
      }
      try {
        await runtime.setViewport(viewport, generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/browser/select-compatibility') {
      const body = await readObjectBody(request);
      const generation = generationProperty(body);
      const enabled = body?.enabled === true || body?.enabled === false ? body.enabled : null;
      if (enabled === null || generation === null) {
        return text(response, 400, 'enabled and generation are required\n');
      }
      try {
        await runtime.setNativeSelectCompatibility(enabled, generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/browser/close-scope') {
      const body = await readObjectBody(request);
      const id = stringProperty(body, 'scopeId');
      const generation = generationProperty(body);
      if (!id || generation === null) return text(response, 400, 'scopeId and generation are required\n');
      try {
        await runtime.closeScope(id, generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/page/evaluate') {
      const body = await readObjectBody(request);
      const generation = generationProperty(body);
      const expression = stringProperty(body, 'expression');
      const userGesture = body?.userGesture === true || body?.userGesture === false ? body.userGesture : false;
      if (generation === null || !expression) return text(response, 400, 'generation and expression are required\n');
      try {
        const value = await runtime.pageEvaluate(expression, generation, access, { userGesture });
        return json(response, 200, { ok: true, value });
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/help/profile') {
      const body = await readObjectBody(request);
      if (body?.approve !== true && body?.approve !== false) return text(response, 400, 'approve (true or false) is required\n');
      try {
        runtime.answerProfileRequest(body.approve, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/page/dialog') {
      const answer = readDialogAnswer(await readObjectBody(request));
      if (!answer) return text(response, 400, 'tabId, dialogId, and accept are required; promptText is text\n');
      try {
        await runtime.pageDialog(answer, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/page/file-chooser') {
      const answer = readFileChooserAnswer(await readObjectBody(request));
      if (!answer) return text(response, 400, `tabId and chooserId are required, with files (1 to ${CHOSEN_FILES_MAX} names) or cancel: true\n`);
      try {
        await runtime.pageFileChooser(answer, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/page/capture') {
      const body = await readObjectBody(request);
      const generation = generationProperty(body);
      if (generation === null) return text(response, 400, 'generation is required\n');
      try {
        const capture = await runtime.pageCapture(generation, access);
        return json(response, 200, { ok: true, ...capture });
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/page/color-scheme') {
      const body = await readObjectBody(request);
      const generation = generationProperty(body);
      const scheme = body?.scheme;
      if (generation === null || !['system', 'light', 'dark'].includes(scheme)) {
        return text(response, 400, 'generation is required, and scheme must be system, light, or dark\n');
      }
      try {
        await runtime.pageColorScheme(scheme, generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/page/zoom') {
      const body = await readObjectBody(request);
      const generation = generationProperty(body);
      const level = body?.level;
      if (generation === null || !Number.isInteger(level) || level < -5 || level > 5) {
        return text(response, 400, 'generation is required, and level an integer from -5 to 5\n');
      }
      try {
        await runtime.pageZoom(level, generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'POST' && url.pathname === '/page/clear') {
      const body = await readObjectBody(request);
      const generation = generationProperty(body);
      const what = body?.what;
      if (generation === null || (what !== 'cookies' && what !== 'cache')) {
        return text(response, 400, 'generation is required, and what must be "cookies" or "cache"\n');
      }
      try {
        await runtime.pageClear(what, generation, access);
        return json(response, 200, runtime.state(access));
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (request.method === 'GET' && url.pathname === '/chrome') {
      if (!chromeStatus) return text(response, 404, 'Not found\n');
      return json(response, 200, chromeStatus());
    }

    // Whether pages may open localhost and private addresses (Settings → Browser).
    if (networkPolicy && url.pathname === '/network') {
      if (request.method === 'GET') return json(response, 200, { ok: true, ...networkPolicy.state() });
      if (request.method !== 'POST') return text(response, 405, 'Method not allowed\n');
      const body = await readObjectBody(request);
      const value = body?.allowPrivateNetwork;
      if (value !== null && typeof value !== 'boolean') {
        return text(response, 400, 'allowPrivateNetwork must be true, false, or null\n');
      }
      try {
        return json(response, 200, { ok: true, ...networkPolicy.set(value) });
      } catch (error) {
        return json(response, 500, { ok: false, error: errorMessage(error) });
      }
    }

    if (profileSites && url.pathname === '/profiles/sites') {
      if (request.method !== 'GET') return text(response, 405, 'Method not allowed\n');
      const id = url.searchParams.get('id');
      if (!id) return text(response, 400, 'id is required\n');
      try {
        return json(response, 200, { ok: true, sites: await profileSites.list(id) });
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    if (profileSites && request.method === 'POST' && url.pathname === '/profiles/sites/clear') {
      const body = await readObjectBody(request);
      const id = stringProperty(body, 'id');
      const domain = stringProperty(body, 'domain');
      if (!id || !domain) return text(response, 400, 'id and domain are required\n');
      try {
        const { sites } = await profileSites.clear(id, domain);
        return json(response, 200, { ok: true, sites });
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    const profileOperation = /^\/profiles(?:\/(create|rename|bind|unbind|delete|open|close|revoke-all))?$/.exec(url.pathname);
    if (profileOperation && runtime.listProfiles) {
      const operation = profileOperation[1] ?? 'list';
      if (operation === 'list' ? request.method !== 'GET' : request.method !== 'POST') return text(response, 405, 'Method not allowed\n');
      const body = operation === 'list' ? {} : await readObjectBody(request);
      if (!body) return text(response, 400, 'Send a JSON object\n');
      const id = stringProperty(body, 'id');
      try {
        if (operation === 'create') await runtime.createProfile(stringProperty(body, 'name') ?? '');
        else if (operation === 'revoke-all') {
          if (body.confirm !== 'REVOKE') return text(response, 400, 'Send confirm: "REVOKE" to wipe every profile\n');
          await runtime.revokeAllProfiles();
        } else if (operation !== 'list') {
          if (!id) return text(response, 400, 'id is required\n');
          if (operation === 'rename') await runtime.renameProfile(id, stringProperty(body, 'name') ?? '');
          else if (operation === 'bind') await runtime.bindProfile(id, stringProperty(body, 'directory') ?? '');
          else if (operation === 'unbind') await runtime.unbindProfile(id, stringProperty(body, 'directory') ?? '');
          else if (operation === 'delete') await runtime.deleteProfile(id);
          else if (operation === 'close') await runtime.closeProfile(id);
          else {
            const generation = generationProperty(body);
            if (generation === null) return text(response, 400, 'generation is required\n');
            await runtime.openProfile(id, generation, access);
          }
        }
        return json(response, 200, { ok: true, profiles: await runtime.listProfiles(), state: runtime.state(access) });
      } catch (error) {
        return json(response, dockErrorStatus(error), { ok: false, error: errorMessage(error) });
      }
    }

    const inspectorOperation = /^\/inspector\/(start|events|clear|stop|evaluate|request)$/.exec(url.pathname)?.[1];
    if (inspectorOperation) {
      try {
        const result = await handleInspector(runtime, inspectorOperation, request, url);
        if (result === null) return json(response, 400, { ok: false, code: 'INVALID_REQUEST', error: new InspectorError('INVALID_REQUEST').message });
        return json(response, 200, result);
      } catch (error) {
        if (!(error instanceof InspectorError)) throw error;
        return json(response, INSPECTOR_STATUS[error.code] ?? 400, { ok: false, code: error.code, error: error.message });
      }
    }

    if (request.method === 'GET' && url.pathname === SURFACE_FRAME_PATH) {
      const after = queryInteger(url, 'after', 0, Number.MAX_SAFE_INTEGER);
      const wait = queryInteger(url, 'wait', 0, SURFACE_FRAME_WAIT_MS);
      if (after === null || wait === null) return text(response, 400, 'Invalid frame query\n');
      const frame = await runtime.surfaceFrame({ after, wait, signal });
      if (!frame) {
        response.writeHead(204);
        return response.end();
      }
      const headers = {
        'content-type': frame.mime,
        'content-length': frame.bytes.length,
        [SURFACE_SEQ_HEADER]: String(frame.sequence),
        [SURFACE_WIDTH_HEADER]: String(frame.width),
        [SURFACE_HEIGHT_HEADER]: String(frame.height),
      };
      const title = surfaceTitleHeader(frame.title);
      if (title) headers[SURFACE_TITLE_HEADER] = title;
      if (runtime.agentActive) headers[SURFACE_AGENT_ACTIVE_HEADER] = '1';
      response.writeHead(200, headers);
      return response.end(frame.bytes);
    }

    if (request.method === 'GET' && url.pathname === SURFACE_AUDIO_PATH) {
      const after = queryInteger(url, 'after', 0, Number.MAX_SAFE_INTEGER);
      const wait = queryInteger(url, 'wait', 0, SURFACE_FRAME_WAIT_MS);
      if (after === null || wait === null) return text(response, 400, 'Invalid audio query\n');
      const batch = await runtime.surfaceAudio({ after, wait, signal });
      if (!batch) {
        response.writeHead(204);
        return response.end();
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': batch.bytes.length,
        [SURFACE_SEQ_HEADER]: String(batch.seq),
        [SURFACE_AUDIO_CODEC_HEADER]: batch.codec,
        [SURFACE_AUDIO_SAMPLE_RATE_HEADER]: String(batch.sampleRate),
        [SURFACE_AUDIO_CHANNELS_HEADER]: String(batch.channels),
      });
      return response.end(batch.bytes);
    }

    if (request.method === 'POST' && url.pathname === SURFACE_INPUT_PATH) {
      const parsed = readSurfaceInputBatch(await readBody(request));
      if (!parsed) return text(response, 400, 'Invalid surface input batch\n');
      try {
        await runtime.surfaceInput(parsed.events, { viewer: viewerOf(request), frameSeq: access.frameSeq });
      } catch (error) {
        // Made on a picture of an earlier view; the host tells the viewer it was not applied.
        if (!/browser view changed/i.test(errorMessage(error))) throw error;
        response.writeHead(409);
        return response.end();
      }
      response.writeHead(204);
      return response.end();
    }

    if (request.method === 'POST' && url.pathname === SURFACE_CONTROL_PATH) {
      const parsed = readSurfaceControlNotice(await readBody(request));
      if (!parsed) return text(response, 400, 'Invalid surface control notice\n');
      await runtime.surfaceControl(parsed.controller, parsed.viewer ?? null);
      response.writeHead(204);
      return response.end();
    }

    if (request.method === 'POST' && url.pathname === SURFACE_RESIZE_PATH) {
      const parsed = readSurfaceResizeRequest(await readBody(request));
      if (!parsed) return text(response, 400, 'Invalid surface resize request\n');
      return json(response, 200, await runtime.surfaceResize(parsed));
    }

    if (request.method === 'GET' && url.pathname === SURFACE_CLIPBOARD_PATH) {
      const copied = await runtime.surfaceClipboard();
      // An answer is written to the viewer's clipboard; nothing copied must not clear it.
      if (!copied) {
        response.writeHead(204);
        return response.end();
      }
      return json(response, 200, { text: copied });
    }
    return text(response, 404, 'Not found\n');
  };

  const server = http.createServer((request, response) => {
    const controller = new AbortController();
    activeRequests.add(controller);
    request.once('aborted', () => controller.abort(new DOMException('Request aborted', 'AbortError')));
    response.once('close', () => {
      activeRequests.delete(controller);
      if (!response.writableEnded) controller.abort(new DOMException('Client disconnected', 'AbortError'));
    });
    void handle(request, response, controller.signal).catch((error) => {
      activeRequests.delete(controller);
      if (!response.headersSent) json(response, 500, { ok: false, error: errorMessage(error) });
      else response.destroy();
    });
  });

  return {
    async listen() {
      if (listening) return this.address;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      listening = true;
      return this.address;
    },
    get address() {
      const value = server.address();
      return value && typeof value === 'object' ? { host: '127.0.0.1', port: value.port } : null;
    },
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        for (const controller of activeRequests) {
          controller.abort(new DOMException('Service stopped', 'AbortError'));
        }
        await runtime.close();
        if (listening) {
          const closed = new Promise((resolve) => server.close(resolve));
          server.closeAllConnections?.();
          await closed;
        }
        listening = false;
      })();
      return closePromise;
    },
  };
};
