/**
 * The annotation overlay that runs *inside* the previewed page.
 *
 * This module produces a self-contained script string. It is injected through
 * `webview.executeJavaScript`, so it cannot import anything, cannot reference
 * our theme variables (the page has its own `:root`), and must not disturb the
 * document it lands in. Consequences that drive the implementation:
 *
 * - All chrome lives in a **closed** shadow root on a single host element, so
 *   page CSS cannot restyle it and page scripts cannot walk into it.
 * - Every color and every label is passed in from the host, already resolved
 *   and already translated. Nothing user-facing is hardcoded here.
 *
 * The chrome is two small pieces rather than one bar: the tools sit at the top
 * of the page, and the comment box follows whatever was just marked. A single
 * bar pinned to one edge covers the part of the page people most often want to
 * point at, and accumulates into something that feels like an application.
 *
 * Lifecycle: the script resolves with a payload (or null when cancelled) and
 * tears down its own chrome *before* resolving, waiting for a repaint, so a
 * screenshot taken by the host contains the page and none of our UI.
 */

export type BrowserAnnotationOverlayTheme = {
  readonly colorScheme: 'light' | 'dark';
  readonly primary: string;
  /** Translucent primary, already resolved to a concrete color by the host. */
  readonly primarySoft: string;
  /** Faint primary used for hover backgrounds. */
  readonly primaryFaint: string;
  readonly primaryContrast: string;
  readonly surface: string;
  readonly surfaceElevated: string;
  /** Translucent elevated surface, matching the app's floating panels. */
  readonly glassSurface: string;
  /** A ready `backdrop-filter` value; '' when the theme has no glass. */
  readonly glassFilter: string;
  readonly border: string;
  readonly text: string;
  readonly mutedText: string;
};

export type BrowserAnnotationOverlayLabels = {
  readonly select: string;
  readonly marquee: string;
  readonly draw: string;
  readonly commentPlaceholder: string;
  readonly submit: string;
};

const ANNOTATION_ACTIVE_FLAG = '__openchamberBrowserAnnotationActive';

/** Cancels an overlay left behind by an earlier session. Safe when none is active. */
export const ANNOTATION_TEARDOWN_SCRIPT = `(() => {
  try {
    var host = document.querySelector('[data-openchamber-annotation]');
    if (host && host.parentNode) host.parentNode.removeChild(host);
  } catch (error) { /* page navigated away */ }
  try {
    var cursor = document.getElementById('openchamber-annotation-cursor');
    if (cursor && cursor.parentNode) cursor.parentNode.removeChild(cursor);
  } catch (error) { /* page navigated away */ }
  try { delete window['${ANNOTATION_ACTIVE_FLAG}']; } catch (error) { /* non-configurable */ }
})();`;

export const buildAnnotationOverlayScript = (
  theme: BrowserAnnotationOverlayTheme,
  labels: BrowserAnnotationOverlayLabels,
): string => {
  const config = JSON.stringify({ theme, labels });
  return String.raw`new Promise((resolve) => {
  var CONFIG = ${config};
  var THEME = CONFIG.theme;
  var LABELS = CONFIG.labels;
  var OVERLAY_ATTR = 'data-openchamber-annotation';
  var Z_OVERLAY = 2147483646;
  var MAX_TEXT = 400;
  var MIN_RECT = 3;
  var EDITOR_GAP = 10;

  try {
    var stale = document.querySelector('[' + OVERLAY_ATTR + ']');
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  } catch (error) { /* nothing to clean */ }

  window['${ANNOTATION_ACTIVE_FLAG}'] = true;

  var counter = 0;
  var nextId = function (prefix) { counter += 1; return prefix + '-' + counter; };

  var selected = null;
  var regions = [];
  var strokes = [];
  var tool = 'select';
  var settled = false;

  // ---------------------------------------------------------------- geometry

  var rectFrom = function (domRect) {
    return { x: domRect.left, y: domRect.top, width: domRect.width, height: domRect.height };
  };
  var normalizeRect = function (ax, ay, bx, by) {
    return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
  };
  var usableRect = function (rect) { return rect.width >= MIN_RECT && rect.height >= MIN_RECT; };

  // ------------------------------------------------------------- description

  var isOverlayNode = function (element) {
    var node = element;
    while (node) {
      if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute(OVERLAY_ATTR)) return true;
      node = node.parentNode || (node.host || null);
    }
    return false;
  };

  var elementFromPoint = function (x, y) {
    var found = document.elementFromPoint(x, y);
    if (!found || isOverlayNode(found)) return null;
    return found;
  };

  var selectorPart = function (element) {
    var part = element.tagName.toLowerCase();
    if (element.id) return part + '#' + element.id;
    var className = typeof element.className === 'string' ? element.className.trim() : '';
    if (className) {
      var first = className.split(/\s+/).filter(Boolean).slice(0, 2).join('.');
      if (first) part += '.' + first;
    }
    return part;
  };

  var buildSelector = function (element) {
    if (element.id) return '#' + element.id;
    var parts = [];
    var node = element;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 5) {
      var part = selectorPart(node);
      var parent = node.parentElement;
      if (parent) {
        var siblings = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === node.tagName;
        });
        if (siblings.length > 1) part += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      if (node.id) break;
      node = parent;
      depth += 1;
    }
    return parts.join(' > ');
  };

  var INTERESTING_ATTRS = ['id', 'class', 'name', 'type', 'href', 'src', 'alt', 'title', 'role', 'placeholder', 'aria-label', 'data-testid'];
  var STYLE_PROPS = [
    'display', 'position', 'color', 'backgroundColor', 'fontSize', 'fontWeight', 'fontFamily',
    'lineHeight', 'padding', 'margin', 'border', 'borderRadius', 'width', 'height', 'opacity',
    'zIndex', 'flexDirection', 'justifyContent', 'alignItems', 'gap', 'textAlign'
  ];

  var describe = function (element) {
    var computed = window.getComputedStyle(element);
    var attributes = {};
    for (var i = 0; i < INTERESTING_ATTRS.length; i += 1) {
      var name = INTERESTING_ATTRS[i];
      var value = element.getAttribute(name);
      if (value) attributes[name] = String(value).slice(0, 200);
    }
    var computedStyle = {};
    for (var j = 0; j < STYLE_PROPS.length; j += 1) {
      var prop = STYLE_PROPS[j];
      computedStyle[prop] = String(computed[prop] == null ? '' : computed[prop]);
    }
    var ancestry = [];
    var node = element.parentElement;
    var depth = 0;
    while (node && node.nodeType === 1 && depth < 4) {
      var entry = { tag: node.tagName.toLowerCase(), selectorPart: selectorPart(node) };
      if (node.id) entry.id = node.id;
      var cls = typeof node.className === 'string' ? node.className.trim() : '';
      if (cls) entry.className = cls.slice(0, 200);
      ancestry.unshift(entry);
      node = node.parentElement;
      depth += 1;
    }
    var box = element.getBoundingClientRect();
    var text = (element.textContent == null ? '' : String(element.textContent)).replace(/\s+/g, ' ').trim();
    return {
      tag: element.tagName.toLowerCase(),
      text: text.slice(0, MAX_TEXT),
      selector: buildSelector(element),
      path: ancestry.map(function (e) { return e.selectorPart; }).concat([selectorPart(element)]).join(' > '),
      bounds: rectFrom(box),
      center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
      attributes: attributes,
      computedStyle: computedStyle,
      ancestry: ancestry
    };
  };

  // ------------------------------------------------------------------ chrome

  var host = document.createElement('div');
  host.setAttribute(OVERLAY_ATTR, '');
  host.style.cssText = 'position:fixed;inset:0;z-index:' + Z_OVERLAY + ';pointer-events:none';
  var shadow = host.attachShadow({ mode: 'closed' });

  var style = document.createElement('style');
  style.textContent = [
    ':host{all:initial}',
    '*{box-sizing:border-box;font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.layer{position:fixed;inset:0;pointer-events:none}',
    '.box{position:fixed;left:0;top:0;display:none;pointer-events:none;border:1.5px solid ' + THEME.primary + ';background:' + THEME.primarySoft + ';border-radius:2px}',
    '.label{position:fixed;left:0;top:0;display:none;pointer-events:none;padding:1px 6px;border-radius:4px;background:' + THEME.primary + ';color:' + THEME.primaryContrast + ';font-size:11px;line-height:17px;white-space:nowrap;font-weight:600}',
    '.tools{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:2px;padding:4px;border-radius:999px;border:1px solid ' + THEME.border + ';background:' + THEME.glassSurface + ';-webkit-backdrop-filter:' + THEME.glassFilter + ';backdrop-filter:' + THEME.glassFilter + ';box-shadow:0 6px 20px rgba(0,0,0,.24);pointer-events:auto}',
    '.tools button{appearance:none;border:none;background:transparent;color:' + THEME.mutedText + ';border-radius:999px;padding:5px 14px;font-size:12px;line-height:18px;font-weight:500;cursor:pointer;white-space:nowrap}',
    '.tools button:hover{background:' + THEME.primaryFaint + '}',
    '.tools button[aria-pressed="true"]{background:' + THEME.primarySoft + ';color:' + THEME.primary + ';font-weight:600}',
    '.editor{position:fixed;left:0;top:0;display:none;align-items:center;gap:8px;width:min(420px,calc(100vw - 24px));padding:6px;padding-left:16px;border-radius:22px;border:1px solid ' + THEME.border + ';background:' + THEME.glassSurface + ';-webkit-backdrop-filter:' + THEME.glassFilter + ';backdrop-filter:' + THEME.glassFilter + ';box-shadow:0 8px 28px rgba(0,0,0,.3);pointer-events:auto}',
    '.editor textarea{flex:1;min-width:0;resize:none;border:none;background:transparent;color:' + THEME.text + ';font-size:13px;line-height:20px;outline:none;padding:6px 0;min-height:32px;max-height:104px;display:block}',
    '.editor textarea::placeholder{color:' + THEME.mutedText + '}',
    '.editor button{appearance:none;border:none;background:' + THEME.primary + ';color:' + THEME.primaryContrast + ';border-radius:999px;padding:8px 18px;font-size:12px;line-height:18px;font-weight:600;cursor:pointer;white-space:nowrap}',
    '.editor button[disabled]{opacity:.5;cursor:default}'
  ].join('');
  shadow.appendChild(style);

  var cursorStyle = document.createElement('style');
  cursorStyle.id = 'openchamber-annotation-cursor';
  document.head.appendChild(cursorStyle);
  var setCursor = function (value) {
    cursorStyle.textContent = value ? '*{cursor:' + value + ' !important}' : '';
  };

  var svgNS = 'http://www.w3.org/2000/svg';
  var svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', 'layer');
  svg.style.overflow = 'visible';
  shadow.appendChild(svg);

  var hoverBox = document.createElement('div');
  hoverBox.className = 'box';
  var hoverLabel = document.createElement('div');
  hoverLabel.className = 'label';
  var marqueeBox = document.createElement('div');
  marqueeBox.className = 'box';
  shadow.append(hoverBox, hoverLabel, marqueeBox);

  var positionBox = function (node, rect) {
    node.style.display = 'block';
    node.style.transform = 'translate(' + rect.x + 'px,' + rect.y + 'px)';
    node.style.width = rect.width + 'px';
    node.style.height = rect.height + 'px';
  };

  var tools = document.createElement('div');
  tools.className = 'tools';
  shadow.appendChild(tools);

  var toolButtons = {};
  [['select', LABELS.select], ['marquee', LABELS.marquee], ['draw', LABELS.draw]].forEach(function (entry) {
    var button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry[1];
    button.addEventListener('click', function () { setTool(entry[0]); });
    toolButtons[entry[0]] = button;
    tools.appendChild(button);
  });

  var editor = document.createElement('div');
  editor.className = 'editor';
  shadow.appendChild(editor);

  var comment = document.createElement('textarea');
  comment.rows = 1;
  comment.placeholder = LABELS.commentPlaceholder;
  var submit = document.createElement('button');
  submit.type = 'button';
  submit.textContent = LABELS.submit;
  editor.append(comment, submit);

  /**
   * Grows the box with its content.
   *
   * A hidden element reports scrollHeight 0, so measuring one collapses the
   * field to nothing — which is what left a sliver of a click target and an
   * invisible caret. Measuring only while visible, and never below the CSS
   * min-height, keeps it usable.
   */
  var resizeComment = function () {
    if (editor.style.display === 'none') return;
    comment.style.height = 'auto';
    comment.style.height = Math.max(32, Math.min(comment.scrollHeight, 104)) + 'px';
  };
  comment.addEventListener('input', resizeComment);

  // -------------------------------------------------------------- selection

  var lastTargetRect = null;

  /** Places the comment box under whatever was just marked, kept on screen. */
  var positionEditor = function () {
    if (!lastTargetRect) {
      editor.style.display = 'none';
      return;
    }
    var wasHidden = editor.style.display === 'none';
    editor.style.display = 'flex';
    // Measured now that it is laid out, not while it was still hidden.
    if (wasHidden) resizeComment();
    var box = editor.getBoundingClientRect();
    var left = lastTargetRect.x + lastTargetRect.width / 2 - box.width / 2;
    var top = lastTargetRect.y + lastTargetRect.height + EDITOR_GAP;
    // Above the target when there is no room below, so the box is never left
    // half off the bottom of the page.
    if (top + box.height > window.innerHeight - 8) {
      top = Math.max(8, lastTargetRect.y - box.height - EDITOR_GAP);
    }
    left = Math.max(8, Math.min(left, window.innerWidth - box.width - 8));
    editor.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
  };

  /** Focus after layout: focusing a zero-height field puts the caret nowhere. */
  var focusComment = function () {
    requestAnimationFrame(function () {
      try {
        comment.focus({ preventScroll: true });
        comment.setSelectionRange(comment.value.length, comment.value.length);
      } catch (error) { /* field went away */ }
    });
  };

  var hasTargets = function () {
    return Boolean(selected) || regions.length > 0 || strokes.length > 0;
  };

  var syncChrome = function () {
    submit.disabled = !hasTargets();
    if (!hasTargets()) {
      lastTargetRect = null;
      editor.style.display = 'none';
      return;
    }
    positionEditor();
  };

  var syncSelectionVisuals = function () {
    if (!selected) return;
    var rect = rectFrom(selected.element.getBoundingClientRect());
    if (!usableRect(rect)) {
      selected.outline.style.display = 'none';
      selected.badge.style.display = 'none';
      return;
    }
    positionBox(selected.outline, rect);
    selected.badge.style.display = 'block';
    selected.badge.style.transform = 'translate(' + Math.max(2, rect.x) + 'px,' + Math.max(2, rect.y - 19) + 'px)';
    lastTargetRect = rect;
  };

  var dropSelection = function () {
    if (!selected) return;
    selected.outline.remove();
    selected.badge.remove();
    selected = null;
  };

  var selectElement = function (element) {
    var wasSelected = selected && selected.element === element;
    dropSelection();
    if (wasSelected) {
      // Clicking the chosen element again clears it, so a misclick costs one
      // click rather than starting over.
      lastTargetRect = null;
      syncChrome();
      return;
    }
    var outline = document.createElement('div');
    outline.className = 'box';
    var badge = document.createElement('div');
    badge.className = 'label';
    badge.textContent = selectorPart(element);
    shadow.append(outline, badge);
    selected = { id: nextId('element'), element: element, outline: outline, badge: badge };
    syncSelectionVisuals();
    syncChrome();
    focusComment();
  };

  var setTool = function (next) {
    tool = next;
    hoverBox.style.display = 'none';
    hoverLabel.style.display = 'none';
    marqueeBox.style.display = 'none';
    setCursor(next === 'select' ? '' : 'crosshair');
    for (var key in toolButtons) {
      if (Object.prototype.hasOwnProperty.call(toolButtons, key)) {
        toolButtons[key].setAttribute('aria-pressed', key === next ? 'true' : 'false');
      }
    }
  };

  // ------------------------------------------------------------- interaction

  var drag = null;

  var onPointerMove = function (event) {
    if (drag) {
      if (drag.kind === 'marquee') {
        drag.rect = normalizeRect(drag.startX, drag.startY, event.clientX, event.clientY);
        positionBox(marqueeBox, drag.rect);
      } else if (drag.kind === 'draw') {
        drag.points.push({ x: event.clientX, y: event.clientY });
        drag.path.setAttribute('d', drag.points.map(function (point, index) {
          return (index === 0 ? 'M' : 'L') + point.x + ' ' + point.y;
        }).join(' '));
      }
      return;
    }

    if (tool !== 'select') return;
    var element = elementFromPoint(event.clientX, event.clientY);
    if (!element) {
      hoverBox.style.display = 'none';
      hoverLabel.style.display = 'none';
      return;
    }
    var rect = rectFrom(element.getBoundingClientRect());
    positionBox(hoverBox, rect);
    hoverLabel.textContent = selectorPart(element);
    hoverLabel.style.display = 'block';
    hoverLabel.style.transform = 'translate(' + Math.max(2, rect.x) + 'px,' + Math.max(2, rect.y - 19) + 'px)';
  };

  var onPointerDown = function (event) {
    if (event.button !== 0) return;
    if (isOverlayNode(event.target)) return;
    event.preventDefault();
    event.stopPropagation();

    if (tool === 'select') {
      var element = elementFromPoint(event.clientX, event.clientY);
      if (element) selectElement(element);
      return;
    }

    if (tool === 'marquee') {
      drag = { kind: 'marquee', startX: event.clientX, startY: event.clientY, rect: null };
      return;
    }

    var path = document.createElementNS(svgNS, 'path');
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', THEME.primary);
    path.setAttribute('stroke-width', '2.5');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    drag = { kind: 'draw', path: path, points: [{ x: event.clientX, y: event.clientY }] };
  };

  var onPointerUp = function () {
    if (!drag) return;
    var finished = drag;
    drag = null;

    if (finished.kind === 'marquee') {
      marqueeBox.style.display = 'none';
      var rect = finished.rect;
      if (!rect || !usableRect(rect)) return;
      // A region marks an area, not the elements inside it: expanding it into a
      // selection made the result depend on the page's markup rather than on
      // what was drawn.
      regions.push({ id: nextId('region'), rect: rect });
      var outline = document.createElementNS(svgNS, 'rect');
      outline.setAttribute('x', String(rect.x));
      outline.setAttribute('y', String(rect.y));
      outline.setAttribute('width', String(rect.width));
      outline.setAttribute('height', String(rect.height));
      outline.style.fill = THEME.primarySoft;
      outline.setAttribute('stroke', THEME.primary);
      outline.setAttribute('stroke-width', '1.5');
      outline.setAttribute('rx', '2');
      svg.appendChild(outline);
      lastTargetRect = rect;
      syncChrome();
      focusComment();
      return;
    }

    var points = finished.points;
    if (points.length < 2) {
      if (finished.path.parentNode) finished.path.parentNode.removeChild(finished.path);
      return;
    }
    var minX = points[0].x, minY = points[0].y, maxX = points[0].x, maxY = points[0].y;
    for (var p = 1; p < points.length; p += 1) {
      minX = Math.min(minX, points[p].x);
      minY = Math.min(minY, points[p].y);
      maxX = Math.max(maxX, points[p].x);
      maxY = Math.max(maxY, points[p].y);
    }
    var bounds = { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
    strokes.push({ id: nextId('stroke'), points: points, bounds: bounds });
    lastTargetRect = bounds;
    syncChrome();
    focusComment();
  };

  /**
   * Swallows the page's own mouse handling while annotating.
   *
   * Blocking pointerdown is not enough: a click still follows it, so marking a
   * button pressed that button and marking a link navigated away from the page
   * being annotated. These are the events that reach page code, so these are
   * the ones that have to stop.
   */
  var blockPageInteraction = function (event) {
    if (isOverlayNode(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  };
  var BLOCKED_EVENTS = ['click', 'auxclick', 'dblclick', 'mousedown', 'mouseup', 'contextmenu'];

  var onScrollOrResize = function () {
    syncSelectionVisuals();
    positionEditor();
  };

  var onKeyDown = function (event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(null);
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && event.target === comment) {
      event.preventDefault();
      attach();
    }
  };

  document.addEventListener('pointermove', onPointerMove, true);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('pointerup', onPointerUp, true);
  BLOCKED_EVENTS.forEach(function (name) {
    window.addEventListener(name, blockPageInteraction, { capture: true, passive: false });
  });
  window.addEventListener('scroll', onScrollOrResize, true);
  window.addEventListener('resize', onScrollOrResize, true);
  window.addEventListener('keydown', onKeyDown, true);

  // ------------------------------------------------------------------ finish

  var teardown = function () {
    document.removeEventListener('pointermove', onPointerMove, true);
    document.removeEventListener('pointerdown', onPointerDown, true);
    document.removeEventListener('pointerup', onPointerUp, true);
    BLOCKED_EVENTS.forEach(function (name) {
      window.removeEventListener(name, blockPageInteraction, true);
    });
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize, true);
    window.removeEventListener('keydown', onKeyDown, true);
    setCursor('');
    if (cursorStyle.parentNode) cursorStyle.parentNode.removeChild(cursorStyle);
    if (host.parentNode) host.parentNode.removeChild(host);
    try { delete window['${ANNOTATION_ACTIVE_FLAG}']; } catch (error) { /* non-configurable */ }
  };

  var finish = function (payload) {
    if (settled) return;
    settled = true;
    teardown();
    // Removing the chrome is not enough: the host screenshots this page right
    // after we resolve, and the compositor can still hold a frame containing
    // our outlines. Yield two frames so the page has actually repainted.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { resolve(payload); });
    });
  };

  var attach = function () {
    if (!hasTargets()) return;
    finish({
      id: 'annotation-' + Date.now(),
      pageUrl: String(location.href),
      pageTitle: String(document.title || ''),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      devicePixelRatio: window.devicePixelRatio || 1,
      comment: comment.value,
      // Zero or one element, never more. Kept as a list so elements, regions
      // and strokes stay one uniform shape for everything downstream.
      elements: selected ? [{ id: selected.id, element: describe(selected.element) }] : [],
      regions: regions.map(function (entry) { return { id: entry.id, rect: entry.rect }; }),
      strokes: strokes.map(function (entry) {
        return { id: entry.id, points: entry.points, bounds: entry.bounds };
      })
    });
  };

  submit.addEventListener('click', attach);

  (document.body || document.documentElement).appendChild(host);
  setTool('select');
  syncChrome();
});`;
};
