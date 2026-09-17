import { BrowserControlError } from '../browser-control/broker.js';
import { getBrowserViewportManager } from './viewport.js';

const BACKEND_KIND = 'server-chrome';
const OPEN_TIMEOUT_MS = 45_000;
const DEFAULT_CONTROL_ACTOR = 'server-chrome-control';

const MUTATING_ACTIONS = new Set([
  'browser.open',
  'browser.click',
  'browser.type',
  'browser.scroll',
  'browser.back',
  'browser.forward',
  'browser.resize',
]);

const READ_ONLY_ACTIONS = new Set([
  'browser.snapshot',
  'browser.inspect',
]);

const VIEWPORT_PRESETS = [
  { id: 'iphone-se', width: 375, height: 667 },
  { id: 'iphone-14', width: 390, height: 844 },
  { id: 'iphone-14-pro-max', width: 430, height: 932 },
  { id: 'pixel-7', width: 412, height: 915 },
  { id: 'ipad-mini', width: 768, height: 1024 },
  { id: 'ipad-pro', width: 1024, height: 1366 },
  { id: 'laptop', width: 1280, height: 800 },
  { id: 'desktop', width: 1440, height: 900 },
];

const VIEWPORT_MODES = ['mobile', 'tablet', 'desktop', 'fill'];
const MODE_PRESETS = {
  mobile: 'iphone-14',
  tablet: 'ipad-mini',
  desktop: 'desktop',
};

const isViewportMode = (value) => typeof value === 'string' && VIEWPORT_MODES.includes(value);

const viewportForMode = (mode) => {
  if (mode === 'fill') return { kind: 'fill' };
  const preset = VIEWPORT_PRESETS.find((entry) => entry.id === MODE_PRESETS[mode]);
  return preset ? { kind: 'preset', id: preset.id, width: preset.width, height: preset.height } : { kind: 'fill' };
};

const viewportSize = (viewport) => (
  viewport.kind === 'fill' ? null : { width: viewport.width, height: viewport.height }
);

const viewportSummary = (viewport) => {
  const size = viewportSize(viewport);
  if (!size) return { mode: 'fill', width: null, height: null };
  for (const mode of ['mobile', 'tablet', 'desktop']) {
    const preset = viewportForMode(mode);
    const presetSize = viewportSize(preset);
    if (presetSize && presetSize.width === size.width && presetSize.height === size.height) {
      return { mode, width: size.width, height: size.height };
    }
  }
  return { mode: 'custom', width: size.width, height: size.height };
};

// ---------------------------------------------------------------------------
// Page-action scripts ported from packages/ui/src/lib/browser/pageActions.ts
// ---------------------------------------------------------------------------

const MAX_TEXT_CHARS = 6_000;
const MAX_ELEMENTS = 120;
const MAX_LABEL_CHARS = 80;

const HELPERS = `
  var MAX_ELEMENTS = ${MAX_ELEMENTS};
  var MAX_LABEL_CHARS = ${MAX_LABEL_CHARS};
  var visible = function (element) {
    var rect = element.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return false;
    var style = window.getComputedStyle(element);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  var label = function (element) {
    var aria = element.getAttribute('aria-label');
    if (aria) return aria.trim();
    var value = element.getAttribute('value');
    var text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text.slice(0, MAX_LABEL_CHARS);
    if (value) return String(value).slice(0, MAX_LABEL_CHARS);
    var placeholder = element.getAttribute('placeholder');
    return placeholder ? placeholder.trim().slice(0, MAX_LABEL_CHARS) : '';
  };
  var isUnique = function (selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (error) {
      return false;
    }
  };
  var cssPath = function (element) {
    var tag = element.tagName.toLowerCase();
    if (element.id) {
      var byId = '#' + CSS.escape(element.id);
      if (isUnique(byId)) return byId;
    }
    var stableAttrs = ['data-testid', 'data-test-id', 'data-test', 'name', 'aria-label'];
    for (var a = 0; a < stableAttrs.length; a += 1) {
      var value = element.getAttribute(stableAttrs[a]);
      if (!value) continue;
      var raw = String(value);
      if (raw.indexOf('"') !== -1) continue;
      var byAttr = tag + '[' + stableAttrs[a] + '="' + raw + '"]';
      if (isUnique(byAttr)) return byAttr;
    }
    var className = typeof element.className === 'string' ? element.className.trim() : '';
    if (className) {
      var classes = className.split(/\\s+/).filter(Boolean);
      for (var c = 0; c < classes.length; c += 1) {
        var byClass = tag + '.' + CSS.escape(classes[c]);
        if (isUnique(byClass)) return byClass;
      }
    }
    var parts = [];
    var node = element;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      var part = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) { parts.unshift(part); break; }
      var siblings = Array.prototype.filter.call(parent.children, function (child) {
        return child.tagName === node.tagName;
      });
      if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      parts.unshift(part);
      if (node.id) { parts[0] = '#' + CSS.escape(node.id); break; }
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  };
  var accessibleName = function (element) {
    var aria = element.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    var labelled = element.getAttribute('aria-labelledby');
    if (labelled) {
      var source = document.getElementById(labelled.split(/\\s+/)[0]);
      if (source && (source.innerText || '').trim()) return source.innerText.trim();
    }
    var title = element.getAttribute('title');
    if (title && title.trim()) return title.trim();
    var alt = element.getAttribute('alt');
    if (alt && alt.trim()) return alt.trim();
    var text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim();
    if (text) return text;
    var value = element.getAttribute('value');
    return value && String(value).trim() ? String(value).trim() : '';
  };
  var findByText = function (needle) {
    var wanted = String(needle).replace(/\\s+/g, ' ').trim().toLowerCase();
    var candidates = document.querySelectorAll('a, button, [role="button"], [role="link"], input[type="submit"], input[type="button"], summary, label');
    var exact = null;
    var partial = null;
    for (var i = 0; i < candidates.length; i += 1) {
      var element = candidates[i];
      if (!visible(element)) continue;
      var text = label(element).toLowerCase();
      if (!text) continue;
      if (text === wanted) { exact = element; break; }
      if (!partial && text.indexOf(wanted) !== -1) partial = element;
    }
    return exact || partial;
  };
`;

const wrap = (body) => `(() => {\n${HELPERS}\n${body}\n})()`;

const buildSnapshotScript = ({ selector } = {}) => wrap(`
  var scopeSelector = ${JSON.stringify(selector ?? '')};
  var root = document;
  if (scopeSelector) {
    try { root = document.querySelector(scopeSelector); }
    catch (error) { return { ok: false, error: 'Invalid selector: ' + scopeSelector }; }
    if (!root) return { ok: false, error: 'No element matches ' + scopeSelector };
  }
  var interactive = root.querySelectorAll('a[href], button, input, select, textarea, [role="button"], [role="link"], [role="tab"], [contenteditable="true"]');
  var elements = [];
  var visibleTotal = 0;
  for (var i = 0; i < interactive.length; i += 1) {
    var element = interactive[i];
    if (!visible(element)) continue;
    visibleTotal += 1;
    if (elements.length >= MAX_ELEMENTS) continue;
    var rect = element.getBoundingClientRect();
    var entry = {
      selector: cssPath(element),
      tag: element.tagName.toLowerCase(),
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
    if (rect.bottom > 0 && rect.top < window.innerHeight) entry.inViewport = true;
    var type = element.getAttribute('type');
    if (type) entry.type = type;
    var role = element.getAttribute('role');
    if (role) entry.role = role;
    var labelText = label(element);
    if (labelText) entry.label = labelText;
    if (element.disabled === true) entry.disabled = true;
    if (!accessibleName(element)) entry.missingAccessibleName = true;
    elements.push(entry);
  }
  var body = document.body ? (document.body.innerText || '') : '';
  var text = body.replace(/\\n{3,}/g, '\\n\\n').trim();
  var docEl = document.documentElement;
  var result = {
    ok: true,
    url: String(location.href),
    title: String(document.title || ''),
    scope: scopeSelector || 'document',
    scrollY: Math.round(window.scrollY),
    maxScrollY: Math.max(0, Math.round(docEl.scrollHeight - window.innerHeight)),
    text: text.slice(0, ${MAX_TEXT_CHARS}),
    elements: elements
  };
  if (text.length > ${MAX_TEXT_CHARS}) {
    result.textTruncated = true;
    result.textTotalChars = text.length;
  }
  if (visibleTotal > elements.length) {
    result.elementsTruncated = true;
    result.interactiveElementsOnPage = visibleTotal;
  }
  return result;
`);

const buildClickScript = ({ selector, text }) => wrap(`
  var selector = ${JSON.stringify(selector ?? '')};
  var text = ${JSON.stringify(text ?? '')};
  var target = null;
  if (selector) {
    try { target = document.querySelector(selector); }
    catch (error) { return { ok: false, error: 'Invalid selector: ' + selector }; }
    if (!target) return { ok: false, error: 'No element matches ' + selector };
  } else {
    target = findByText(text);
    if (!target) return { ok: false, error: 'No clickable element has the label ' + text };
  }
  if (target.disabled === true) return { ok: false, error: 'Element is disabled' };
  target.scrollIntoView({ block: 'center', inline: 'center' });
  target.click();
  return { ok: true, clicked: cssPath(target), label: label(target), url: String(location.href) };
`);

const buildTypeScript = ({ selector, value, submit }) => wrap(`
  var selector = ${JSON.stringify(selector)};
  var value = ${JSON.stringify(value)};
  var target = null;
  try { target = document.querySelector(selector); }
  catch (error) { return { ok: false, error: 'Invalid selector: ' + selector }; }
  if (!target) return { ok: false, error: 'No element matches ' + selector };
  var editable = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
  if (!editable) return { ok: false, error: selector + ' is not a text field' };
  if (target.disabled === true || target.readOnly === true) return { ok: false, error: 'Field is not editable' };
  target.scrollIntoView({ block: 'center' });
  target.focus();
  if (target.isContentEditable) {
    target.textContent = value;
  } else {
    var prototype = target.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (setter && setter.set) setter.set.call(target, value);
    else target.value = value;
  }
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  if (${submit ? 'true' : 'false'}) {
    var enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true };
    target.dispatchEvent(new KeyboardEvent('keydown', enter));
    target.dispatchEvent(new KeyboardEvent('keyup', enter));
    var form = target.form;
    if (form && typeof form.requestSubmit === 'function') form.requestSubmit();
  }
  return { ok: true, selector: cssPath(target), url: String(location.href) };
`);

const buildScrollScript = ({ selector, direction }) => wrap(`
  var selector = ${JSON.stringify(selector ?? '')};
  var direction = ${JSON.stringify(direction ?? '')};
  var settle = function (extra) {
    return new Promise(function (resolve) {
      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          var doc = document.documentElement;
          var maxScrollY = Math.max(0, doc.scrollHeight - window.innerHeight);
          var scrollY = Math.round(window.scrollY);
          var result = { ok: true, scrollY: scrollY, maxScrollY: Math.round(maxScrollY) };
          result.atTop = scrollY <= 1;
          result.atBottom = scrollY >= maxScrollY - 1;
          for (var key in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, key)) result[key] = extra[key];
          }
          resolve(result);
        });
      });
    });
  };
  if (selector) {
    var target = null;
    try { target = document.querySelector(selector); }
    catch (error) { return { ok: false, error: 'Invalid selector: ' + selector }; }
    if (!target) return { ok: false, error: 'No element matches ' + selector };
    target.scrollIntoView({ block: 'center', behavior: 'instant' });
    return settle({ scrolledTo: cssPath(target) });
  }
  var doc = document.documentElement;
  var page = Math.round(window.innerHeight * 0.85);
  var bottom = Math.max(0, doc.scrollHeight - window.innerHeight);
  if (direction === 'down') window.scrollTo({ top: window.scrollY + page, behavior: 'instant' });
  else if (direction === 'up') window.scrollTo({ top: window.scrollY - page, behavior: 'instant' });
  else if (direction === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
  else if (direction === 'bottom') window.scrollTo({ top: bottom, behavior: 'instant' });
  else return { ok: false, error: 'Unknown scroll direction: ' + direction };
  return settle({ direction: direction });
`);

const INSPECTED_STYLE_PROPS = [
  'color', 'background-color', 'background-image', 'opacity',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
  'border-radius', 'border-width', 'border-style', 'border-color', 'box-shadow',
  'display', 'position', 'width', 'height', 'padding', 'margin', 'gap',
  'flex-direction', 'justify-content', 'align-items', 'z-index', 'overflow', 'visibility',
];

const buildInspectScript = ({ selector }) => wrap(`
  var selector = ${JSON.stringify(selector)};
  var target = null;
  try { target = document.querySelector(selector); }
  catch (error) { return { ok: false, error: 'Invalid selector: ' + selector }; }
  if (!target) return { ok: false, error: 'No element matches ' + selector };
  var computed = window.getComputedStyle(target);
  var styles = {};
  var props = ${JSON.stringify(INSPECTED_STYLE_PROPS)};
  for (var i = 0; i < props.length; i += 1) {
    var value = computed.getPropertyValue(props[i]);
    if (value) styles[props[i]] = String(value).trim();
  }
  var rect = target.getBoundingClientRect();
  return {
    ok: true,
    selector: cssPath(target),
    tag: target.tagName.toLowerCase(),
    label: label(target),
    bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    inViewport: rect.bottom > 0 && rect.top < window.innerHeight,
    styles: styles
  };
`);

// ---------------------------------------------------------------------------
// CDP helpers
// ---------------------------------------------------------------------------

const withSignal = async (signal, operation) => {
  signal?.throwIfAborted();
  if (!signal) return operation();
  const aborted = Promise.withResolvers();
  const onAbort = () => aborted.reject(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const result = await Promise.race([operation(), aborted.promise]);
    signal.throwIfAborted();
    return result;
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
};

// A sent CDP command cannot be undone. Guard each subsequent command so an
// aborted request cannot continue its action after that command settles.
const cdpForRequest = (cdp, signal) => ({
  ...cdp,
  send: (...args) => withSignal(signal, () => cdp.send(...args)),
  sendSession: (...args) => withSignal(signal, () => cdp.sendSession(...args)),
  attach: (...args) => withSignal(signal, () => cdp.attach(...args)),
});

const attachSession = async (cdp, targetId) => {
  const existing = cdp.getSessionId(targetId);
  if (existing) return existing;
  return cdp.attach(targetId);
};

const evaluateValue = async (cdp, sessionId, expression) => {
  const response = await cdp.sendSession(sessionId, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (response.exceptionDetails) {
    const details = response.exceptionDetails;
    const message = details.exception?.description || details.text || 'Runtime.evaluate failed';
    throw new Error(message);
  }
  return response.result?.value ?? null;
};

const waitForLoad = (cdp, sessionId, timeoutMs, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new DOMException('operation aborted', 'AbortError'));
    return;
  }
  const timer = setTimeout(() => {
    cleanup();
    reject(new Error('page did not finish loading within the open budget'));
  }, timeoutMs);
  let unsubscribe = null;
  const cleanup = () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (unsubscribe) unsubscribe();
  };
  const onAbort = () => {
    cleanup();
    reject(new DOMException('operation aborted', 'AbortError'));
  };
  unsubscribe = cdp.onEvent((event) => {
    if (event.sessionId === sessionId && event.method === 'Page.loadEventFired') {
      cleanup();
      resolve();
    }
  });
  signal?.addEventListener('abort', onAbort, { once: true });
});

const readPageInfo = async (cdp, sessionId) => {
  const value = await evaluateValue(cdp, sessionId, '({ url: String(location.href), title: String(document.title || \"\") })');
  if (!value || typeof value !== 'object') return { url: '', title: '' };
  return {
    url: typeof value.url === 'string' ? value.url : '',
    title: typeof value.title === 'string' ? value.title : '',
  };
};

// ---------------------------------------------------------------------------
// Error shaping
// ---------------------------------------------------------------------------

const isDeadSessionMessage = (message) => (
  /Chrome process died|session is closed|session was not found|exited unexpectedly|was superseded/.test(message)
);

const isConflictMessage = (message) => (
  /control lease|mutating operation does not hold this session lease|viewer took control/.test(message)
);

const isTimeoutMessage = (message) => (
  /operation aborted|did not finish loading|timed out/i.test(message)
);

const wrapError = (error, target) => {
  if (error instanceof BrowserControlError) {
    if (target && !error.target) error.target = target;
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  let status = 400;
  if (error?.name === 'AbortError') status = 499;
  else if (error?.name === 'TimeoutError') status = 504;
  else if (isDeadSessionMessage(message)) status = 503;
  else if (isConflictMessage(message)) status = 409;
  else if (isTimeoutMessage(message)) status = 504;
  const wrapped = new BrowserControlError(message, status);
  wrapped.target = target;
  return wrapped;
};

// ---------------------------------------------------------------------------
// Backend factory
// ---------------------------------------------------------------------------

/**
 * @typedef {{ directory: string, tabId?: string, openCodeSessionId?: string }} BrowserTarget
 * @typedef {{ directory: string }} BrowserScope
 * @typedef {{
 *   backend: 'server-chrome', directory: string, tabs: BrowserTabInfo[], activeTabId: string | null,
 *   sessionId?: string, persistence?: 'ephemeral' | 'project'
 * }} BrowserSession
 * @typedef {{
 *   tabId: string, url: string, title: string, active: boolean, backend?: 'server-chrome'
 * }} BrowserTabInfo
 * @typedef {{
 *   getSession(scope: BrowserScope): BrowserSession | null,
 *   listTabs(scope: BrowserScope, options?: { signal?: AbortSignal }): Promise<BrowserTabInfo[]>,
 *   execute(target: BrowserTarget, action: string, parameters: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<unknown>
 * }} BrowserBackend
 */

/** @returns {BrowserBackend} */
export const createServerChromeBackend = ({
  browserSessionManager,
  chromeProcessManager,
}) => {
  if (!browserSessionManager?.runMutatingOperation) {
    throw new Error('Server Chrome backend requires a browser session manager');
  }

  const viewports = getBrowserViewportManager(browserSessionManager);

  const tabIdFromTargetId = (targetId) => `sc:${targetId}`;

  const targetIdFromTabId = (tabId) => {
    if (typeof tabId === 'string' && tabId.startsWith('sc:')) return tabId.slice(3);
    return null;
  };

  const locatorFor = (target) => ({
    directory: target.directory,
    openCodeSessionId: target.openCodeSessionId ?? DEFAULT_CONTROL_ACTOR,
  });

  const ensureSessionForOpen = async (target, signal) => {
    signal.throwIfAborted();
    const locator = locatorFor(target);
    let session = browserSessionManager.getSession(locator);
    if (!session) session = await browserSessionManager.createSession(locator);
    if (signal.aborted) {
      if (session.persistence === 'ephemeral') await browserSessionManager.endSession(session.id, 'operation aborted');
      signal.throwIfAborted();
    }
    return session;
  };

  const runAction = async (target, action, operation, abortSignal) => {
    const tabId = typeof target.tabId === 'string' && target.tabId ? target.tabId : null;
    const targetId = tabId ? targetIdFromTabId(tabId) : action;
    const locator = locatorFor(target);
    const guardedOperation = (context) => withSignal(context.abortSignal, () => operation({
      ...context,
      cdp: cdpForRequest(context.cdp, context.abortSignal),
      viewportCdp: context.cdp,
    }));

    try {
      if (MUTATING_ACTIONS.has(action)) {
        return await browserSessionManager.runMutatingOperation(locator, {
          targetId,
          openCodeSessionId: locator.openCodeSessionId,
          abortSignal,
          operation: guardedOperation,
          requireTargetOwnership: Boolean(tabId),
        });
      }
      return await browserSessionManager.runReadOnlyOperation(locator, {
        targetId,
        abortSignal,
        operation: guardedOperation,
        requireTargetOwnership: Boolean(tabId),
      });
    } catch (error) {
      throw wrapError(error, target);
    }
  };

  const openPage = async (target, parameters, callerSignal) => {
    const url = typeof parameters.url === 'string' ? parameters.url : '';
    if (!url) throw new BrowserControlError('url is required', 400);

    const deadline = Date.now() + OPEN_TIMEOUT_MS;
    const timeoutSignal = AbortSignal.timeout(OPEN_TIMEOUT_MS);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
    await withSignal(signal, () => chromeProcessManager.ensureProcess());
    signal.throwIfAborted();
    const session = await ensureSessionForOpen(target, signal);
    signal.throwIfAborted();
    const viewport = isViewportMode(parameters.viewport) ? viewportForMode(parameters.viewport) : null;

    return runAction(target, 'browser.open', async ({ cdp, viewportCdp, browserContextId, abortSignal }) => {
      const requestedTargetId = targetIdFromTabId(target.tabId);
      let pageTargetId = requestedTargetId;
      if (!pageTargetId) {
        const createResult = await cdp.send('Target.createTarget', {
          url: 'about:blank',
          browserContextId,
        });
        if (typeof createResult?.targetId !== 'string') {
          throw new Error('Chrome returned no target id');
        }
        pageTargetId = createResult.targetId;
      }
      const sessionId = await attachSession(cdp, pageTargetId);
      await cdp.sendSession(sessionId, 'Page.enable');
      if (viewport) {
        await viewports.applyAgent({ sessionId: session.id, targetId: pageTargetId, cdp: viewportCdp,
          cdpSessionId: sessionId, signal: abortSignal,
          viewport: viewport.kind === 'fill' ? null : {
            width: viewport.width, height: viewport.height, mobile: parameters.viewport === 'mobile',
          } });
      }

      const remainingMs = Math.max(1, deadline - Date.now());
      const navigateResult = await cdp.sendSession(sessionId, 'Page.navigate', { url });
      if (navigateResult?.errorText) {
        throw new Error(navigateResult.errorText);
      }
      await waitForLoad(cdp, sessionId, remainingMs, abortSignal);

      return {
        url,
        opened: true,
        tabId: tabIdFromTargetId(pageTargetId),
        richControl: true,
      };
    }, signal);
  };

  const runPageScript = async (target, action, parameters, buildScript, options = {}) => {
    const { includeViewport, signal } = options;
    const tabId = target.tabId;
    if (!tabId) throw new BrowserControlError('tabId is required', 400);
    return runAction(target, action, async ({ cdp }) => {
      const targetId = targetIdFromTabId(tabId);
      const sessionId = await attachSession(cdp, targetId);
      const script = buildScript(parameters);
      const result = await evaluateValue(cdp, sessionId, script);
      if (!result || typeof result !== 'object') {
        throw new Error('The page returned no result');
      }
      if (result.ok !== true) {
        throw new Error(typeof result.error === 'string' && result.error ? result.error : 'Browser action failed');
      }
      if (includeViewport) {
        const session = browserSessionManager.getSession(locatorFor(target));
        const viewport = await viewports.read(session.id, targetId, null);
        result.viewport = viewportSummary(viewport.mode === 'external' ? { kind: 'fill' } : viewport);
      }
      return result;
    }, signal);
  };

  return {
    getSession(scope) {
      const session = browserSessionManager.getSession({
        directory: scope.directory,
        openCodeSessionId: DEFAULT_CONTROL_ACTOR,
      });
      if (!session) return null;
      return {
        backend: BACKEND_KIND,
        directory: session.directory,
        tabs: [],
        activeTabId: null,
        sessionId: session.id,
        persistence: session.persistence,
      };
    },

    async listTabs(scope, { signal } = {}) {
      signal?.throwIfAborted();
      const locator = {
        directory: scope.directory,
        openCodeSessionId: scope.openCodeSessionId ?? DEFAULT_CONTROL_ACTOR,
      };
      if (!browserSessionManager.getSession(locator)) return [];
      const tabs = await browserSessionManager.listTabs(locator, { abortSignal: signal });
      return tabs.map((tab) => ({
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        active: false,
        backend: BACKEND_KIND,
      }));
    },

    async execute(callerTarget, action, callerParameters, { signal } = {}) {
      const target = Object.freeze({ ...callerTarget });
      const parameters = Object.freeze({ ...callerParameters });
      try {
        signal?.throwIfAborted();
        if (action === 'browser.open') {
          return await openPage(target, parameters, signal);
        }

        if (action === 'browser.snapshot') {
          return await runPageScript(target, action, parameters, buildSnapshotScript, { includeViewport: true, signal });
        }
        if (action === 'browser.click') {
          return await runPageScript(target, action, parameters, buildClickScript, { signal });
        }
        if (action === 'browser.type') {
          return await runPageScript(target, action, parameters, buildTypeScript, { signal });
        }
        if (action === 'browser.scroll') {
          return await runPageScript(target, action, parameters, buildScrollScript, { signal });
        }
        if (action === 'browser.inspect') {
          return await runPageScript(target, action, parameters, buildInspectScript, { signal });
        }

      if (action === 'browser.back' || action === 'browser.forward') {
        const goingBack = action === 'browser.back';
        return await runAction(target, action, async ({ cdp, abortSignal }) => {
          const tabId = target.tabId;
          if (!tabId) throw new Error('tabId is required');
          const targetId = targetIdFromTabId(tabId);
          const sessionId = await attachSession(cdp, targetId);
          await cdp.sendSession(sessionId, 'Page.enable');
          const history = await cdp.sendSession(sessionId, 'Page.getNavigationHistory');
          const currentIndex = typeof history?.currentIndex === 'number' ? history.currentIndex : -1;
          const entries = Array.isArray(history?.entries) ? history.entries : [];
          const nextIndex = goingBack ? currentIndex - 1 : currentIndex + 1;
          const entry = entries[nextIndex];
          if (!entry) {
            throw new Error(goingBack
              ? 'There is nothing to go back to in this tab'
              : 'There is nothing to go forward to in this tab');
          }
          await cdp.sendSession(sessionId, 'Page.navigateToHistoryEntry', { entryId: entry.id });
          try {
            await waitForLoad(cdp, sessionId, 8_000, abortSignal);
          } catch {
            abortSignal?.throwIfAborted();
            // History navigations sometimes settle without a load event.
          }
          const info = await readPageInfo(cdp, sessionId);
          return { url: info.url, title: info.title };
        }, signal);
      }

      if (action === 'browser.resize') {
        if (!isViewportMode(parameters.viewport)) {
          throw new BrowserControlError('viewport is required', 400);
        }
        const viewport = viewportForMode(parameters.viewport);
        return await runAction(target, action, async ({ cdp, viewportCdp, abortSignal }) => {
          const tabId = target.tabId;
          if (!tabId) throw new Error('tabId is required');
          const targetId = targetIdFromTabId(tabId);
          const sessionId = await attachSession(cdp, targetId);
          const session = browserSessionManager.getSession(locatorFor(target));
          await viewports.applyAgent({ sessionId: session.id, targetId, cdp: viewportCdp,
            cdpSessionId: sessionId, signal: abortSignal,
            viewport: viewport.kind === 'fill' ? null : {
              width: viewport.width, height: viewport.height, mobile: parameters.viewport === 'mobile',
            } });
          return { viewport: viewportSummary(viewport) };
        }, signal);
      }

      if (action === 'browser.capture') {
        return await runAction(target, action, async ({ cdp }) => {
          const tabId = target.tabId;
          if (!tabId) throw new Error('tabId is required');
          const targetId = targetIdFromTabId(tabId);
          const sessionId = await attachSession(cdp, targetId);
          await cdp.sendSession(sessionId, 'Page.enable');
          const captureResult = await cdp.sendSession(sessionId, 'Page.captureScreenshot', { format: 'png' });
          const metrics = await cdp.sendSession(sessionId, 'Page.getLayoutMetrics');
          const info = await readPageInfo(cdp, sessionId);
          const session = browserSessionManager.getSession(locatorFor(target));
          const viewport = await viewports.read(session.id, targetId, null);
          const layoutViewport = metrics?.layoutViewport;
          return {
            mime: 'image/png',
            base64: typeof captureResult?.data === 'string' ? captureResult.data : '',
            width: typeof layoutViewport?.clientWidth === 'number' ? layoutViewport.clientWidth : null,
            height: typeof layoutViewport?.clientHeight === 'number' ? layoutViewport.clientHeight : null,
            url: info.url,
            title: info.title,
            viewport: viewportSummary(viewport.mode === 'external' ? { kind: 'fill' } : viewport),
          };
        }, signal);
      }

        throw new BrowserControlError(`Unsupported browser action: ${action}`, 400);
      } catch (error) {
        if (signal?.aborted) {
          throw wrapError(new BrowserControlError('Browser action was cancelled', 499), target);
        }
        throw wrapError(error, target);
      }
    },
  };
};
