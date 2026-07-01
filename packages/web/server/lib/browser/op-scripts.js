/**
 * Per-op page-script generators.
 *
 * The server owns op semantics by composing the JavaScript that the renderer
 * executor runs in the page context (iframe on web, webview on desktop). Each
 * generator returns a self-contained JS expression that evaluates to a
 * JSON-serializable result, or to an error marker { __ocError, message } that the
 * runtime translates into a typed BROWSER_ERROR_CODES failure.
 *
 * This module is PURE — generators return strings; nothing executes here. The
 * embedded bodies must not contain backticks or ${...}; args are injected as a
 * JSON literal (__A) so model-supplied values can never break out of the script.
 */

import { buildSnapshotScript, SNAPSHOT_REF_ATTR } from './snapshot.js';

// Diagnostics capture install (console/network/page-error hooks). Idempotent
// in-page (guarded by D.installed), but only shipped on the first eval per
// document (see buildOpScript `installDiag`) so per-op payloads stay small. The
// capture accumulates history in-page for the read/drain ops — a uniform,
// pull-based feed that works the same on the web iframe and the desktop webview.
const DIAG_INSTALL = `
  (function __ocInstallDiag() {
    try {
      var D = window.__ocDiag;
      if (!D) { D = window.__ocDiag = { seq: 0, primedAt: Date.now(), console: [], network: [], pageErrors: [], installed: false }; }
      if (D.installed) return;
      D.installed = true;
      var CAP = 500;
      function ring(arr, e) { e.seq = ++D.seq; e.at = Date.now(); arr.push(e); if (arr.length > CAP) arr.splice(0, arr.length - CAP); }
      ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
        var orig = window.console && window.console[level];
        if (!orig) return;
        window.console[level] = function () {
          try {
            var parts = Array.prototype.slice.call(arguments).map(function (a) {
              try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
            });
            ring(D.console, { level: level, text: parts.join(' ').slice(0, 2000) });
          } catch (e) {}
          return orig.apply(window.console, arguments);
        };
      });
      window.addEventListener('error', function (ev) {
        try { ring(D.pageErrors, { message: String(ev.message || ''), source: ev.filename, line: ev.lineno, col: ev.colno, stack: ev.error && ev.error.stack ? String(ev.error.stack).slice(0, 2000) : undefined }); } catch (e) {}
      });
      window.addEventListener('unhandledrejection', function (ev) {
        try { var r = ev.reason; ring(D.pageErrors, { message: 'Unhandled rejection: ' + (r && r.message ? r.message : String(r)) }); } catch (e) {}
      });
      var of = window.fetch;
      if (of) {
        window.fetch = function (input, init) {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          var method = (init && init.method) || (input && input.method) || 'GET';
          var start = Date.now();
          var entry = { url: String(url).slice(0, 500), method: method, status: 0, ok: false, durationMs: 0, kind: 'fetch' };
          ring(D.network, entry);
          return of.apply(this, arguments).then(function (res) { entry.status = res.status; entry.ok = res.ok; entry.durationMs = Date.now() - start; return res; }, function (err) { entry.error = String(err && err.message ? err.message : err); entry.durationMs = Date.now() - start; throw err; });
        };
      }
      var OX = window.XMLHttpRequest;
      if (OX && OX.prototype) {
        var xopen = OX.prototype.open, xsend = OX.prototype.send;
        OX.prototype.open = function (m, u) { this.__oc = { method: m, url: String(u).slice(0, 500), kind: 'xhr', status: 0, ok: false }; return xopen.apply(this, arguments); };
        OX.prototype.send = function () {
          var x = this, e = x.__oc;
          if (e) { var start = Date.now(); ring(D.network, e); x.addEventListener('loadend', function () { try { e.status = x.status; e.ok = x.status >= 200 && x.status < 400; e.durationMs = Date.now() - start; } catch (err) {} }); }
          return xsend.apply(this, arguments);
        };
      }
    } catch (e) {}
  })();
`;

// Element/DOM helpers used by every op body. Small — always shipped.
const HELPERS = `
  function __ocErr(code, msg) { return { __ocError: code, message: msg || code }; }
  function __ocResolve(a) {
    if (a && typeof a.ref === 'string') {
      var byRef = document.querySelector('[${SNAPSHOT_REF_ATTR}=' + JSON.stringify(a.ref) + ']');
      return byRef || null;
    }
    if (a && typeof a.selector === 'string') {
      try { return document.querySelector(a.selector); } catch (e) { return null; }
    }
    if (a && Array.isArray(a.coords) && a.coords.length === 2) {
      return document.elementFromPoint(a.coords[0], a.coords[1]);
    }
    return null;
  }
  function __ocRect(el) { try { var r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; } catch (e) { return null; } }
  function __ocSetValue(el, value) {
    var proto = el instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype
      : el instanceof window.HTMLSelectElement ? window.HTMLSelectElement.prototype
      : window.HTMLInputElement.prototype;
    var desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) { desc.set.call(el, value); } else { el.value = value; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function __ocFire(el, type, init) {
    var opts = Object.assign({ bubbles: true, cancelable: true, view: window }, init || {});
    var ev;
    if (type.indexOf('key') === 0) ev = new KeyboardEvent(type, opts);
    else if (type.indexOf('mouse') === 0 || type === 'click' || type === 'dblclick' || type === 'contextmenu') ev = new MouseEvent(type, opts);
    else ev = new Event(type, opts);
    el.dispatchEvent(ev);
  }
`;

// op → body. Each body is a statement sequence whose last 'return' yields the result.
const BODIES = {
  click: `
    var el = __ocResolve(__A);
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No element matched');
    el.scrollIntoView({ block: 'center', inline: 'center' });
    __ocFire(el, 'mousedown'); __ocFire(el, 'mouseup');
    if (typeof el.click === 'function') el.click(); else __ocFire(el, 'click');
    return { clicked: true, rect: __ocRect(el) };
  `,
  double_click: `
    var el = __ocResolve(__A);
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No element matched');
    el.scrollIntoView({ block: 'center' });
    __ocFire(el, 'dblclick');
    return { doubleClicked: true };
  `,
  right_click: `
    var el = __ocResolve(__A);
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No element matched');
    __ocFire(el, 'contextmenu', { button: 2 });
    return { contextMenu: true };
  `,
  hover: `
    var el = __ocResolve(__A);
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No element matched');
    el.scrollIntoView({ block: 'center' });
    __ocFire(el, 'mouseover'); __ocFire(el, 'mousemove'); __ocFire(el, 'mouseenter', { bubbles: false });
    return { hovered: true, rect: __ocRect(el) };
  `,
  fill: `
    var el = __ocResolve(__A);
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No element matched');
    if (el.isContentEditable) { el.focus(); el.textContent = String(__A.text); el.dispatchEvent(new Event('input', { bubbles: true })); return { filled: true }; }
    if (!('value' in el)) return __ocErr('BAD_ARGS', 'Element is not fillable');
    el.focus();
    __ocSetValue(el, String(__A.text));
    return { filled: true, value: el.value };
  `,
  type: `
    var el = __A.ref || __A.selector ? __ocResolve(__A) : document.activeElement;
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No focused or matched element');
    el.focus();
    var text = String(__A.text);
    if ('value' in el && !el.isContentEditable) { __ocSetValue(el, (el.value || '') + text); }
    else if (el.isContentEditable) { el.textContent = (el.textContent || '') + text; el.dispatchEvent(new Event('input', { bubbles: true })); }
    for (var i = 0; i < text.length; i++) { __ocFire(el, 'keydown', { key: text[i] }); __ocFire(el, 'keyup', { key: text[i] }); }
    return { typed: text.length };
  `,
  press_key: `
    var el = __A.ref || __A.selector ? __ocResolve(__A) : (document.activeElement || document.body);
    __ocFire(el, 'keydown', { key: __A.key });
    __ocFire(el, 'keyup', { key: __A.key });
    return { pressed: __A.key };
  `,
  scroll: `
    var el = (__A.ref || __A.selector) ? __ocResolve(__A) : null;
    var dx = Number(__A.dx) || 0, dy = Number(__A.dy != null ? __A.dy : (__A.y != null ? __A.y : 0)) || 0;
    if (el) { el.scrollBy(dx, dy); } else { window.scrollBy(dx, dy); }
    return { scrollX: window.scrollX, scrollY: window.scrollY };
  `,
  select_option: `
    var el = __ocResolve(__A);
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No element matched');
    if (el.tagName !== 'SELECT') return __ocErr('BAD_ARGS', 'Element is not a <select>');
    var values = Array.isArray(__A.values) ? __A.values.map(String) : [String(__A.values)];
    var selected = [];
    for (var i = 0; i < el.options.length; i++) {
      var opt = el.options[i];
      var match = values.indexOf(opt.value) !== -1 || values.indexOf(opt.label) !== -1 || values.indexOf(opt.text) !== -1;
      opt.selected = match;
      if (match) selected.push(opt.value);
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: selected };
  `,
  drag: `
    var fromEl = __ocResolve(__A.from || {});
    var toEl = __ocResolve(__A.to || {});
    if (!fromEl || !toEl) return __ocErr('SELECTOR_NOT_FOUND', 'from/to element not found');
    var fr = fromEl.getBoundingClientRect(), tr = toEl.getBoundingClientRect();
    var fx = fr.left + fr.width / 2, fy = fr.top + fr.height / 2, tx = tr.left + tr.width / 2, ty = tr.top + tr.height / 2;
    function m(el, type, x, y) { try { el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y })); } catch (e) {} }
    m(fromEl, 'pointerdown', fx, fy); m(fromEl, 'mousedown', fx, fy);
    m(fromEl, 'pointermove', tx, ty); m(document.elementFromPoint(tx, ty) || toEl, 'mousemove', tx, ty);
    m(toEl, 'pointerup', tx, ty); m(toEl, 'mouseup', tx, ty);
    try {
      var dt = new DataTransfer();
      fromEl.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      toEl.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
      toEl.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
      fromEl.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    } catch (e) {}
    return { dragged: true };
  `,
  get_text: `
    var el = (__A.ref || __A.selector) ? __ocResolve(__A) : document.body;
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No element matched');
    var t = (el.innerText || el.textContent || '').replace(/\\s+\\n/g, '\\n').trim();
    return { text: t.length > 20000 ? t.slice(0, 20000) : t };
  `,
  query: `
    var nodes = [];
    try { nodes = Array.prototype.slice.call(document.querySelectorAll(__A.selector)); }
    catch (e) { return __ocErr('BAD_ARGS', 'Invalid selector'); }
    var limit = __A.all === false ? 1 : 50;
    return { count: nodes.length, matches: nodes.slice(0, limit).map(function (el) {
      return { tag: el.tagName.toLowerCase(), id: el.id || undefined, text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80), rect: __ocRect(el) };
    }) };
  `,
  get_attributes: `
    var el = __ocResolve(__A);
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No element matched');
    var out = {};
    for (var i = 0; i < el.attributes.length; i++) { var a = el.attributes[i]; out[a.name] = a.value; }
    return { tag: el.tagName.toLowerCase(), attributes: out };
  `,
  get_computed_style: `
    var el = __ocResolve(__A);
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No element matched');
    var s = window.getComputedStyle(el);
    var props = Array.isArray(__A.props) && __A.props.length ? __A.props : ['display','position','color','backgroundColor','fontSize','fontFamily','width','height','margin','padding','zIndex','visibility','opacity'];
    var out = {};
    for (var i = 0; i < props.length; i++) { out[props[i]] = s.getPropertyValue(props[i].replace(/[A-Z]/g, function (m) { return '-' + m.toLowerCase(); })); }
    return { style: out };
  `,
  get_url_title: `
    return { url: location.href, title: document.title };
  `,
  highlight: `
    var el = __ocResolve(__A);
    if (!el) return __ocErr('SELECTOR_NOT_FOUND', 'No element matched');
    var prev = el.style.outline;
    el.style.outline = '2px solid #2f81f7';
    setTimeout(function () { el.style.outline = prev; }, 1500);
    return { highlighted: true, rect: __ocRect(el) };
  `,
  evaluate: `
    try { var __r = (function () { return eval(__A.js); })(); return { result: __r === undefined ? null : __r }; }
    catch (e) { return __ocErr('EXEC_ERROR', String(e && e.message ? e.message : e)); }
  `,
  cookies: `
    if (__A.mode === 'get') {
      return { cookies: document.cookie.split(';').map(function (c) { return c.trim(); }).filter(Boolean), note: 'Only cookies visible to document.cookie are returned; HttpOnly cookies are omitted.' };
    }
    if (typeof __A.name === 'string') {
      var c = __A.name + '=' + encodeURIComponent(__A.value != null ? __A.value : '') + '; path=' + (__A.path || '/');
      if (__A.maxAge != null) c += '; max-age=' + __A.maxAge;
      document.cookie = c;
      return { set: __A.name };
    }
    return __ocErr('BAD_ARGS', 'cookie set requires a name');
  `,
  storage: `
    var store = __A.area === 'session' ? window.sessionStorage : window.localStorage;
    if (__A.mode === 'get') {
      if (typeof __A.key === 'string') return { value: store.getItem(__A.key) };
      var out = {}; for (var i = 0; i < store.length; i++) { var k = store.key(i); out[k] = store.getItem(k); } return { items: out };
    }
    if (typeof __A.key !== 'string') return __ocErr('BAD_ARGS', 'storage set requires a key');
    store.setItem(__A.key, String(__A.value != null ? __A.value : ''));
    return { set: __A.key };
  `,
  handle_dialog: `
    window.__ocDialog = { action: __A.action, text: __A.text };
    if (!window.__ocDialogInstalled) {
      window.__ocDialogInstalled = true;
      window.alert = function () { return undefined; };
      window.confirm = function () { return !!(window.__ocDialog && window.__ocDialog.action === 'accept'); };
      window.prompt = function (msg, def) {
        if (window.__ocDialog && window.__ocDialog.action === 'accept') return window.__ocDialog.text != null ? window.__ocDialog.text : (def != null ? def : '');
        return null;
      };
    }
    return { dialogHandler: __A.action };
  `,
  console_messages: `
    var D = window.__ocDiag || { console: [], seq: 0, primedAt: Date.now() };
    var since = Number(__A.since) || 0;
    var reset = since > D.seq;
    var entries = (since > 0 && !reset) ? D.console.filter(function (e) { return e.seq > since; }) : D.console.slice();
    return { capturing: true, primedAt: D.primedAt, cursor: D.seq, reset: reset, entries: entries };
  `,
  network_requests: `
    var D = window.__ocDiag || { network: [], seq: 0, primedAt: Date.now() };
    var since = Number(__A.since) || 0;
    var reset = since > D.seq;
    var entries = (since > 0 && !reset) ? D.network.filter(function (e) { return e.seq > since; }) : D.network.slice();
    return { capturing: true, primedAt: D.primedAt, cursor: D.seq, reset: reset, entries: entries };
  `,
  page_errors: `
    var D = window.__ocDiag || { pageErrors: [], seq: 0, primedAt: Date.now() };
    var since = Number(__A.since) || 0;
    var reset = since > D.seq;
    var entries = (since > 0 && !reset) ? D.pageErrors.filter(function (e) { return e.seq > since; }) : D.pageErrors.slice();
    return { capturing: true, primedAt: D.primedAt, cursor: D.seq, reset: reset, entries: entries };
  `,
};

/**
 * Build the JS expression for an op that executes via page-eval. Returns null for
 * ops that are NOT page-eval (navigate/screenshot/lifecycle/etc. — handled by the
 * runtime via executor primitives), so callers can branch.
 */
export const buildOpScript = (op, args = {}, ctx = {}) => {
  if (op === 'snapshot') {
    return buildSnapshotScript({ epoch: ctx.epoch, maxNodes: args.maxNodes });
  }
  const body = BODIES[op];
  if (!body) return null;
  const argsJson = JSON.stringify(args ?? {});
  // Ship the diagnostics install only when the runtime says it isn't installed
  // for the current document yet; helpers are always included.
  const preamble = ctx.installDiag === false ? HELPERS : `${DIAG_INSTALL}${HELPERS}`;
  return `(function () { var __A = ${argsJson};${preamble}${body}})()`;
};
