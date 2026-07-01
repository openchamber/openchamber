/**
 * Ref-addressable accessibility/DOM snapshot model.
 *
 * Both backends produce the SAME snapshot shape by evaluating one shared
 * in-page script (desktop via webContents.executeJavaScript / CDP Runtime.evaluate,
 * web via the same-origin iframe). Each interesting node is tagged with a stable
 * `data-oc-ref` so later ops (click/fill/...) can target it by `ref`.
 *
 * Refs are scoped to a snapshot EPOCH. The runtime bumps the epoch on every
 * navigation; an action that references a ref from a stale epoch is rejected with
 * STALE_REF rather than acting on the wrong element.
 *
 * The pure ref helpers below are unit-tested; the script builders return JS source
 * strings (no I/O here).
 */

export const SNAPSHOT_REF_ATTR = 'data-oc-ref';
const DEFAULT_SNAPSHOT_MAX_NODES = 2000;

export const formatRef = (epoch, index) => `e${epoch}-${index}`;

export const parseRef = (ref) => {
  if (typeof ref !== 'string') return null;
  const match = /^e([^-]+)-(\d+)$/.exec(ref);
  if (!match) return null;
  return { epoch: match[1], index: Number(match[2]) };
};

export const isStaleRef = (ref, currentEpoch) => {
  const parsed = parseRef(ref);
  if (!parsed) return true;
  return String(parsed.epoch) !== String(currentEpoch);
};

// Embedded page-side body. MUST NOT contain backticks or ${...} — it is wrapped
// into a template literal by the builders below, with options injected via __OPTS.
const SNAPSHOT_BODY = `
  var MAX = (__OPTS && __OPTS.maxNodes) || 2000;
  var EPOCH = (__OPTS && __OPTS.epoch) || '0';
  var ATTR = 'data-oc-ref';
  var count = 0;

  function txt(el) {
    var t = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return t.length > 160 ? t.slice(0, 160) + '\\u2026' : t;
  }

  function accName(el) {
    var aria = el.getAttribute && el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    var lb = el.getAttribute && el.getAttribute('aria-labelledby');
    if (lb) {
      var parts = lb.split(/\\s+/).map(function (id) {
        var r = document.getElementById(id);
        return r ? (r.textContent || '').trim() : '';
      }).filter(Boolean);
      if (parts.length) return parts.join(' ');
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.id) {
        try {
          var lab = document.querySelector('label[for="' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id) + '"]');
          if (lab && lab.textContent.trim()) return lab.textContent.trim();
        } catch (e) {}
      }
      var ph = el.getAttribute('placeholder');
      if (ph && ph.trim()) return ph.trim();
      var an = el.getAttribute('aria-label');
      if (an && an.trim()) return an.trim();
    }
    if (tag === 'img') {
      var alt = el.getAttribute('alt');
      if (alt != null) return alt.trim();
    }
    var title = el.getAttribute && el.getAttribute('title');
    if (title && title.trim()) return title.trim();
    return txt(el);
  }

  var ROLE_BY_TAG = {
    a: 'link', button: 'button', nav: 'navigation', main: 'main', header: 'banner',
    footer: 'contentinfo', aside: 'complementary', form: 'form', textarea: 'textbox',
    select: 'combobox', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading',
    h5: 'heading', h6: 'heading', ul: 'list', ol: 'list', li: 'listitem', table: 'table',
    img: 'img', label: 'label', summary: 'button', dialog: 'dialog'
  };

  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\\s+/)[0];
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    return ROLE_BY_TAG[tag] || null;
  }

  var INTERACTIVE = { a: 1, button: 1, input: 1, select: 1, textarea: 1, summary: 1, option: 1, label: 1 };

  function isInteresting(el) {
    var tag = el.tagName.toLowerCase();
    if (INTERACTIVE[tag]) return true;
    if (el.getAttribute('role')) return true;
    if (el.hasAttribute('tabindex')) return true;
    if (el.hasAttribute('onclick')) return true;
    if (/^h[1-6]$/.test(tag)) return true;
    if (ROLE_BY_TAG[tag]) return true;
    return false;
  }

  function isVisible(el) {
    if (!el.getClientRects || el.getClientRects().length === 0) return false;
    var s = window.getComputedStyle(el);
    if (!s) return true;
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) === 0) return false;
    return true;
  }

  function bounds(el) {
    try {
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) { return null; }
  }

  function valueOf(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return el.checked ? 'checked' : 'unchecked';
      if (type === 'password') return el.value ? '\\u2022\\u2022\\u2022' : '';
      return el.value || '';
    }
    if (tag === 'textarea') return el.value || '';
    if (tag === 'select') return el.value || '';
    return undefined;
  }

  function walk(el) {
    if (count >= MAX) return null;
    var children = [];
    var kids = el.children || [];
    for (var i = 0; i < kids.length; i++) {
      var c = walk(kids[i]);
      if (c) {
        if (c.__flatten) { children = children.concat(c.children); }
        else children.push(c);
      }
      if (count >= MAX) break;
    }

    if (el.nodeType === 1 && isInteresting(el) && isVisible(el)) {
      var ref = 'e' + EPOCH + '-' + count;
      count++;
      try { el.setAttribute(ATTR, ref); } catch (e) {}
      var node = {
        ref: ref,
        role: roleOf(el) || el.tagName.toLowerCase(),
        name: accName(el),
        bounds: bounds(el)
      };
      var v = valueOf(el);
      if (v !== undefined) node.value = v;
      if (/^h[1-6]$/.test(el.tagName.toLowerCase())) node.level = Number(el.tagName[1]);
      if (el.getAttribute && el.getAttribute('disabled') != null) node.disabled = true;
      if (children.length) node.children = children;
      return node;
    }

    // Not interesting: flatten its interesting descendants upward.
    return children.length ? { __flatten: true, children: children } : null;
  }

  var rootResult = walk(document.body || document.documentElement);
  var tree = rootResult ? (rootResult.__flatten ? rootResult.children : [rootResult]) : [];
  return {
    epoch: EPOCH,
    url: location.href,
    title: document.title,
    nodeCount: count,
    truncated: count >= MAX,
    tree: tree
  };
`;

/**
 * Build the in-page snapshot script. Returns a self-contained JS expression that
 * evaluates to the snapshot object (and tags elements with data-oc-ref).
 */
export const buildSnapshotScript = ({ epoch, maxNodes = DEFAULT_SNAPSHOT_MAX_NODES } = {}) => {
  const opts = JSON.stringify({ epoch: String(epoch ?? '0'), maxNodes });
  return `(function () { var __OPTS = ${opts};${SNAPSHOT_BODY}})()`;
};

/**
 * Build a JS expression that resolves an element by its data-oc-ref, returning the
 * element or null. Used by action ops to locate a ref'd node in the page.
 */
export const buildResolveElementExpr = (ref) => {
  const safeRef = JSON.stringify(String(ref));
  return `document.querySelector('[${SNAPSHOT_REF_ATTR}=' + JSON.stringify(${safeRef}) + ']')`;
};
