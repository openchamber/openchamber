/**
 * Scripts the agent's browser actions run inside the page.
 *
 * Each builder returns a self-contained expression evaluated in one frame of
 * the page, so none of them may reference anything from this module at
 * runtime. Inputs are embedded with `JSON.stringify`, which is what keeps a
 * selector or a typed value from terminating the expression and becoming code.
 *
 * On the desktop they run in an isolated world of each frame
 * (`packages/electron/browser-panel-driver.mjs`): the page shares the DOM but
 * cannot see or change the scripts' own state. That state is the element
 * registry: a snapshot numbers the elements it lists, and later actions name
 * an element by that number. The registry lives on `window`, which in that
 * world is the scripts' own.
 *
 * Every script resolves to `{ ok, ... }` instead of throwing, so a failed match
 * comes back as an explainable result rather than an opaque evaluation error.
 */

/**
 * Budget caps. The snapshot cost is bounded by these, not by the size of the
 * page: a document with ten thousand nodes returns the same shape as one with
 * two hundred, because only visible interactive elements are collected and both
 * lists are cut off here. What the caps drop is always reported, so a partial
 * answer never reads as a complete one. The caller splits them across frames.
 */
export const MAX_SNAPSHOT_TEXT_CHARS = 6_000;
export const MAX_SNAPSHOT_ELEMENTS = 120;
/** Enough to recognise a control; full labels are what made entries expensive. */
const MAX_LABEL_CHARS = 80;
/** Enough to discover a select without letting one control dominate a snapshot. */
const MAX_OPTION_COUNT = 32;
/** Longest a scroll waits for paint frames before it reports anyway. */
const SCROLL_SETTLE_MAX_MS = 100;

/**
 * How an action names its element: a number from the last snapshot of this
 * frame, a CSS selector in the top document, or the visible label of a link
 * or button.
 */
export type ElementTarget = { id: number; doc: string } | { selector: string } | { text: string };

/** The registry's answer when a numbered element is gone or was never listed. */
export const STALE_ELEMENT_CODE = 'stale';

const INTERACTIVE_SELECTOR = 'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"], [contenteditable="true"], [draggable="true"]';

/**
 * Shared helpers, injected into each script. `cssPath` builds the same kind of
 * selector the actions accept, so a snapshot result is directly usable.
 */
const HELPERS = `
  var MAX_LABEL_CHARS = ${MAX_LABEL_CHARS};
  var MAX_OPTION_COUNT = ${MAX_OPTION_COUNT};
  var INTERACTIVE = ${JSON.stringify(INTERACTIVE_SELECTOR)};
  var registry = function () {
    var store = window.__openchamberAgent;
    if (!store) {
      // A new document gets a new registry, and its own name: numbers restart
      // there, so a number is valid only together with the document it came from.
      store = { elements: new Map(), next: 1, doc: String(Date.now()) + '-' + Math.random().toString(36).slice(2) };
      window.__openchamberAgent = store;
    }
    return store;
  };
  var register = function (element) {
    var store = registry();
    var id = store.next;
    store.next += 1;
    store.elements.set(id, element);
    return id;
  };
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
  var boundedText = function (value) {
    var text = String(value);
    if (text.length <= MAX_LABEL_CHARS) return { value: text, truncated: false };
    var end = MAX_LABEL_CHARS;
    var last = text.charCodeAt(end - 1);
    if (last >= 0xD800 && last <= 0xDBFF) end -= 1;
    return { value: text.slice(0, end), truncated: true };
  };
  var selectOptionLabel = function (option) {
    var explicit = option.getAttribute('label');
    if (explicit !== null) return explicit;
    return String(option.textContent || '').replace(/\\s+/g, ' ').trim();
  };
  var isOptionDisabled = function (element) {
    if (element.disabled === true) return true;
    if (typeof element.matches === 'function' && element.matches(':disabled')) return true;
    var parent = element.parentElement;
    while (parent) {
      if (parent.tagName === 'OPTGROUP' && parent.disabled === true) return true;
      parent = parent.parentElement;
    }
    return false;
  };
  var isUnique = function (selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch (error) {
      return false;
    }
  };
  /** Inside a shadow root no document selector reaches it; only its number does. */
  var inShadow = function (element) {
    return typeof element.getRootNode === 'function' && element.getRootNode() !== document;
  };

  /**
   * Names an element by what it is, falling back to where it sits.
   *
   * A positional chain like 'main > section:nth-of-type(3) > div > a' survives
   * only until the markup shifts, and says nothing about what it points at.
   * Anything the page states about identity — an id, a test id, an accessible
   * name — outlives edits and reads as the thing it selects. The chain remains
   * as the last resort, because something always has to work.
   */
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
      // A value containing a quote would need escaping for no real gain: such
      // attributes are rare, and the positional chain still covers them.
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

  /** Where an element is: its selector where one reaches it, else its tag. */
  var whereOf = function (element) {
    return inShadow(element) ? element.tagName.toLowerCase() : cssPath(element);
  };
  /** What names an element in an answer: where it is and what it says. */
  var describe = function (element) {
    if (!element || element.nodeType !== 1) return 'nothing';
    var name = label(element);
    return name ? whereOf(element) + ' "' + name + '"' : whereOf(element);
  };

  /** What a screen reader would announce, or '' when there is nothing to say. */
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

  /** The root and every open shadow root under it, in tree order. */
  var eachRoot = function (root, visit) {
    visit(root);
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i += 1) {
      if (all[i].shadowRoot) eachRoot(all[i].shadowRoot, visit);
    }
  };
  var queryDeep = function (root, selector) {
    var found = [];
    eachRoot(root, function (scope) {
      var matches = scope.querySelectorAll(selector);
      for (var i = 0; i < matches.length; i += 1) found.push(matches[i]);
    });
    return found;
  };

  /** The best match for a link or button label: exact first, then containing. */
  var findByText = function (needle) {
    var wanted = String(needle).replace(/\\s+/g, ' ').trim().toLowerCase();
    var candidates = queryDeep(document, 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], input[type="submit"], input[type="button"], summary, label');
    var partial = null;
    for (var i = 0; i < candidates.length; i += 1) {
      var element = candidates[i];
      if (!visible(element)) continue;
      var text = label(element).toLowerCase();
      if (!text) continue;
      if (text === wanted) return { element: element, exact: true };
      if (!partial && text.indexOf(wanted) !== -1) partial = element;
    }
    return partial ? { element: partial, exact: false } : null;
  };

  var resolveTarget = function (target) {
    if (typeof target.id === 'number') {
      if (target.doc !== registry().doc) return { ok: false, code: '${STALE_ELEMENT_CODE}', error: 'That element is from a page that has since been replaced' };
      var known = registry().elements.get(target.id);
      if (!known || !known.isConnected) return { ok: false, code: '${STALE_ELEMENT_CODE}', error: 'That element is gone from the page' };
      return { ok: true, element: known };
    }
    if (typeof target.selector === 'string') {
      var bySelector = null;
      try { bySelector = document.querySelector(target.selector); }
      catch (error) { return { ok: false, error: 'Invalid selector: ' + target.selector }; }
      if (!bySelector) return { ok: false, error: 'No element matches ' + target.selector };
      return { ok: true, element: bySelector };
    }
    var byText = findByText(target.text);
    if (!byText) return { ok: false, error: 'No clickable element has the label ' + target.text };
    return { ok: true, element: byText.element };
  };
`;

const wrap = (body: string): string => `(() => {\n${HELPERS}\n${body}\n})()`;

const withTarget = (target: ElementTarget, body: string): string => wrap(`
  var resolved = resolveTarget(${JSON.stringify(target)});
  if (!resolved.ok) return { ok: false, error: resolved.error, code: resolved.code };
  var target = resolved.element;
  ${body}
`);

/**
 * Lists the visible interactive elements of one frame and numbers them for
 * later actions, open shadow roots included. Earlier numbers of this frame
 * stop working. File inputs are listed even when hidden: pages commonly hide
 * them behind a styled button, and an upload needs the input itself.
 *
 * `selector` narrows the snapshot to one subtree. A long page truncates
 * against the caps no matter how they are tuned, which leaves the agent
 * hunting. Scoping answers that directly: ask about the part you mean and the
 * caps stop mattering.
 */
export const buildSnapshotScript = ({
  selector,
  maxElements = MAX_SNAPSHOT_ELEMENTS,
  maxTextChars = MAX_SNAPSHOT_TEXT_CHARS,
}: { selector?: string; maxElements?: number; maxTextChars?: number } = {}): string => wrap(`
  var scopeSelector = ${JSON.stringify(selector ?? '')};
  var maxElements = ${JSON.stringify(maxElements)};
  var maxTextChars = ${JSON.stringify(maxTextChars)};
  var root = document;
  if (scopeSelector) {
    try { root = document.querySelector(scopeSelector); }
    catch (error) { return { ok: false, error: 'Invalid selector: ' + scopeSelector }; }
    if (!root) return { ok: false, error: 'No element matches ' + scopeSelector };
  }
  var store = registry();
  store.elements = new Map();
  var doc = store.doc;
  // A frame drawn at no size (a tracking pixel, a hidden widget) shows nothing.
  var shown = window.innerWidth >= 1 && window.innerHeight >= 1;
  var interactive = shown ? queryDeep(root, INTERACTIVE) : [];
  var elements = [];
  var visibleTotal = 0;
  for (var i = 0; i < interactive.length; i += 1) {
    var element = interactive[i];
    var isFileInput = element.tagName === 'INPUT' && String(element.type).toLowerCase() === 'file';
    var isVisible = visible(element);
    if (!isVisible && !isFileInput) continue;
    visibleTotal += 1;
    if (elements.length >= maxElements) continue;

    var rect = element.getBoundingClientRect();
    // Empty and default-valued fields are left out rather than serialized as
    // "" and false. Repeated across a hundred entries that overhead dwarfed
    // the information it carried.
    var entry = { id: register(element) };
    if (!inShadow(element)) entry.selector = cssPath(element);
    else entry.inShadowRoot = true;
    entry.tag = element.tagName.toLowerCase();
    entry.bounds = { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    // The list covers the whole document so anything can be clicked without
    // scrolling to it first, which means bounds alone do not say what is on
    // screen — a negative y reads as a bug otherwise.
    if (isVisible && rect.bottom > 0 && rect.top < window.innerHeight) entry.inViewport = true;
    if (!isVisible) entry.hidden = true;
    var type = element.getAttribute('type');
    if (type) entry.type = type;
    var role = element.getAttribute('role');
    if (role) entry.role = role;
    var labelText = label(element);
    if (labelText) entry.label = labelText;
    if (element.disabled === true) entry.disabled = true;
    if (element.getAttribute('aria-checked') === 'true' || element.checked === true) entry.checked = true;
    if (element.getAttribute('aria-expanded') === 'true') entry.expanded = true;
    if (isFileInput) {
      if (element.multiple) entry.multiple = true;
      var accept = element.getAttribute('accept');
      if (accept) entry.accept = accept;
    }
    if (element.tagName === 'SELECT') {
      entry.multiple = element.multiple === true;
      entry.options = [];
      var optionList = element.options;
      for (var optionIndex = 0; optionIndex < optionList.length && optionIndex < MAX_OPTION_COUNT; optionIndex += 1) {
        var option = optionList[optionIndex];
        var optionLabelText = boundedText(selectOptionLabel(option));
        var optionValueText = boundedText(option.value);
        if (optionLabelText.truncated || optionValueText.truncated) entry.optionsTruncated = true;
        entry.options.push({
          label: optionLabelText.value,
          value: optionValueText.value,
          selected: option.selected === true,
          disabled: isOptionDisabled(option)
        });
      }
      if (optionList.length > MAX_OPTION_COUNT) entry.optionsTruncated = true;
    }
    // Flagged rather than described: reporting the accessible name of every
    // element would cost more than it tells, while its absence on something
    // clickable is a defect worth naming.
    if (isVisible && !accessibleName(element)) entry.missingAccessibleName = true;
    elements.push(entry);
  }
  // The text follows the scope too: a dialog's snapshot that carried the page
  // under it gave no way to tell which lines were in the dialog.
  var textRoot = root === document ? document.body : root;
  var body = shown && textRoot ? (textRoot.innerText || '') : '';
  var text = body.replace(/\\n{3,}/g, '\\n\\n').trim();
  var docEl = document.documentElement;
  var result = {
    ok: true,
    doc: doc,
    url: String(location.href),
    title: String(document.title || ''),
    scope: scopeSelector || 'document',
    scrollY: Math.round(window.scrollY),
    maxScrollY: Math.max(0, Math.round(docEl.scrollHeight - window.innerHeight)),
    text: text.slice(0, maxTextChars),
    elements: elements
  };
  // State what was dropped. A capped list that reports only its own length
  // reads as the whole page, and the agent acts as if it had seen everything.
  if (text.length > maxTextChars) {
    result.textTruncated = true;
    result.textTotalChars = text.length;
  }
  if (visibleTotal > elements.length) {
    result.elementsTruncated = true;
    result.interactiveElementsOnPage = visibleTotal;
  }
  return result;
`);

/**
 * Finds the link or button with a visible label and numbers it, so the action
 * that asked can reach it the way it reaches a snapshot element. `exact` lets
 * the caller prefer an exact match in a later frame over a partial one here.
 */
export const buildFindByTextScript = (text: string): string => wrap(`
  var found = findByText(${JSON.stringify(text)});
  if (!found) return { ok: true, found: false };
  return { ok: true, found: true, exact: found.exact, id: register(found.element), doc: registry().doc };
`);

/**
 * Brings the element on screen and answers the point a pointer should press,
 * in this frame's viewport. Refuses when something else is drawn over that
 * point: a real click would land on the cover, and reporting success there
 * would hide that the page is in the way (a cookie banner, an open menu).
 */
export const buildPointScript = (target: ElementTarget, { requireEnabled = true }: { requireEnabled?: boolean } = {}): string => withTarget(target, `
  if (${requireEnabled ? 'true' : 'false'} && target.disabled === true) return { ok: false, error: describe(target) + ' is disabled' };
  target.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  var rect = target.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return { ok: false, error: describe(target) + ' is not drawn on the page' };
  var x = rect.left + rect.width / 2;
  var y = rect.top + rect.height / 2;
  var scope = target.getRootNode();
  var hit = typeof scope.elementFromPoint === 'function' ? scope.elementFromPoint(x, y) : document.elementFromPoint(x, y);
  // The target, something inside it, or something holding it (a label around
  // an input) all take the click as the agent meant it.
  if (hit && hit !== target && !target.contains(hit) && !hit.contains(target)) {
    return { ok: false, error: describe(hit) + ' is drawn over ' + describe(target) + '. Close or move it first, or act on it instead.' };
  }
  var answer = { ok: true, x: x, y: y, label: label(target) };
  if (!inShadow(target)) answer.selector = cssPath(target);
  return answer;
`);

/**
 * Puts the keyboard in a text field with its whole content selected, so the
 * text the driver then inserts replaces what was there.
 */
export const buildFocusFieldScript = (target: ElementTarget): string => withTarget(target, `
  var tag = target.tagName;
  var editable = tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
  if (!editable) return { ok: false, error: describe(target) + ' is not a text field' };
  if (target.disabled === true || target.readOnly === true) return { ok: false, error: describe(target) + ' is not editable' };
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  target.focus();
  if (target.isContentEditable) {
    var range = document.createRange();
    range.selectNodeContents(target);
    var selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } else if (typeof target.select === 'function') {
    target.select();
  }
  var answer = { ok: true, label: label(target) };
  if (!inShadow(target)) answer.selector = cssPath(target);
  return answer;
`);

/** Moves the keyboard to the element, for keys pressed there. */
export const buildFocusScript = (target: ElementTarget): string => withTarget(target, `
  target.focus();
  return { ok: true };
`);

/**
 * Whether dragging the element starts an HTML drag: `draggable`, which links
 * and images are by default. Such a drag runs as page events
 * (`buildHtmlDragScript`); anything else gets a real pointer drag.
 */
export const buildDraggableScript = (target: ElementTarget): string => withTarget(target, `
  var node = target;
  while (node && node.nodeType === 1) {
    if (node.draggable === true) return { ok: true, draggable: true };
    node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
  }
  return { ok: true, draggable: false };
`);

/**
 * An HTML drag and drop as the page's own events: dragstart on the source,
 * dragenter, dragover and drop on the target, dragend on the source, all with
 * one DataTransfer, so what the source puts in it is what the drop reads.
 * The target accepts only when its dragover is cancelled, as in a browser.
 */
export const buildHtmlDragScript = (source: ElementTarget, destination: ElementTarget): string => wrap(`
  var from = resolveTarget(${JSON.stringify(source)});
  if (!from.ok) return { ok: false, error: from.error, code: from.code };
  var to = resolveTarget(${JSON.stringify(destination)});
  if (!to.ok) return { ok: false, error: to.error, code: to.code };
  var centre = function (element) {
    var rect = element.getBoundingClientRect();
    return { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
  };
  var data = new DataTransfer();
  var fire = function (element, type, at) {
    var init = { bubbles: true, cancelable: true, composed: true, dataTransfer: data, clientX: at.clientX, clientY: at.clientY };
    return element.dispatchEvent(new DragEvent(type, init));
  };
  from.element.scrollIntoView({ block: 'center', behavior: 'instant' });
  var start = centre(from.element);
  if (!fire(from.element, 'dragstart', start)) return { ok: false, error: describe(from.element) + ' refused to start a drag' };
  to.element.scrollIntoView({ block: 'nearest', behavior: 'instant' });
  var end = centre(to.element);
  fire(to.element, 'dragenter', end);
  var accepted = !fire(to.element, 'dragover', end);
  if (accepted) fire(to.element, 'drop', end);
  fire(from.element, 'dragend', end);
  return { ok: true, accepted: accepted };
`);

/** What a text field holds after typing, to report it back. */
export const buildFieldValueScript = (target: ElementTarget): string => withTarget(target, `
  var value = target.isContentEditable ? String(target.innerText || '') : String(target.value == null ? '' : target.value);
  return { ok: true, value: value.slice(0, 200), valueTruncated: value.length > 200 };
`);

/** Checks that the element is a file input before files are attached to it. */
export const buildFileInputScript = (target: ElementTarget): string => withTarget(target, `
  if (!(target.tagName === 'INPUT' && String(target.type).toLowerCase() === 'file')) {
    return { ok: false, error: describe(target) + ' is not a file input. browser.snapshot lists the page\\'s file inputs, hidden ones too.' };
  }
  if (target.disabled === true) return { ok: false, error: 'The file input is disabled' };
  return { ok: true, multiple: target.multiple === true };
`);

/** The element itself, for the driver to hand to the browser as a node. */
export const buildElementExpression = (target: ElementTarget): string => wrap(`
  var resolved = resolveTarget(${JSON.stringify(target)});
  return resolved.ok ? resolved.element : null;
`);

export const buildSelectScript = (target: ElementTarget, { label: optionLabel, value }: { label?: string; value?: string }): string => {
  const hasLabel = optionLabel !== undefined;
  const hasValue = value !== undefined;
  const criterion = hasLabel === hasValue ? '' : hasLabel ? 'label' : 'value';
  return withTarget(target, `
  var criterion = ${JSON.stringify(criterion)};
  var wanted = ${JSON.stringify(hasLabel ? optionLabel : value)};
  if (!criterion) return { ok: false, error: 'browser.select requires exactly one of label or value' };
  var name = whereOf(target);
  if (!(target instanceof window.HTMLSelectElement)) return { ok: false, error: name + ' is not a native HTML select' };
  if (isOptionDisabled(target)) return { ok: false, error: 'The select ' + name + ' is disabled' };
  if (target.multiple) return { ok: false, error: 'Multiple selects are not supported for browser.select' };

  var matches = [];
  for (var i = 0; i < target.options.length; i += 1) {
    var option = target.options[i];
    var candidate = criterion === 'label' ? selectOptionLabel(option) : String(option.value);
    if (candidate === wanted) matches.push(option);
  }
  if (matches.length === 0) return { ok: false, error: 'No option in ' + name + ' has the exact ' + criterion + ' ' + wanted };
  if (matches.length > 1) return { ok: false, error: 'More than one option in ' + name + ' has the exact ' + criterion + ' ' + wanted };
  var match = matches[0];
  if (isOptionDisabled(match)) return { ok: false, error: 'The matching option in ' + name + ' is disabled' };

  target.scrollIntoView({ block: 'center' });
  for (var j = 0; j < target.options.length; j += 1) target.options[j].selected = target.options[j] === match;
  var selected = target.selectedOptions;
  if (selected.length !== 1 || selected[0] !== match || target.value !== match.value) {
    return { ok: false, error: 'The option in ' + name + ' could not be selected' };
  }
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  var answer = { ok: true, label: selectOptionLabel(match), value: String(target.value), url: String(location.href) };
  if (!inShadow(target)) answer.selector = cssPath(target);
  return answer;
`);
};

/**
 * Scrolling, reported after it has actually happened.
 *
 * Two things made this lie. Pages commonly set `scroll-behavior: smooth`, which
 * turns a programmatic scroll into an animation — so the position read straight
 * afterwards is the position before the scroll, and the result said nothing
 * moved. And a scroll that is already at the end is indistinguishable from one
 * that failed unless the limits are reported too. An agent reading "scrollY: 0"
 * from a scroll that worked learns a superstition it will apply for the rest of
 * the session.
 */
const SCROLL_SETTLE = `
  // Two frames let the layout catch up, but a page in a hidden background tab
  // is not composited and gets no frames at all while still reporting itself
  // visible, so the wait is capped by a timer. The scroll
  // itself is instant, so the position read then is already the final one.
  var settle = function (extra) {
    return new Promise(function (resolve) {
      var done = false;
      var finish = function () {
        if (done) return;
        done = true;
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
      };
      requestAnimationFrame(function () {
        requestAnimationFrame(finish);
      });
      setTimeout(finish, ${SCROLL_SETTLE_MAX_MS});
    });
  };
`;

export const buildScrollToScript = (target: ElementTarget): string => withTarget(target, `
  ${SCROLL_SETTLE}
  // Instant on purpose: the page's own smooth scrolling would still be
  // animating when the next action runs against it.
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  return settle({ scrolledTo: describe(target) });
`);

export const buildScrollScript = ({ direction }: { direction: string }): string => wrap(`
  ${SCROLL_SETTLE}
  var direction = ${JSON.stringify(direction)};
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

/**
 * Whether what `browser.wait` waits for is on the page of this frame: text
 * anywhere in it, shadow roots included, or an element by selector or number.
 * A numbered element counts as there while it is connected and drawn.
 */
export const buildWaitConditionScript = ({ text, target }: { text?: string; target?: ElementTarget }): string => wrap(`
  var wantedText = ${JSON.stringify(text ?? '')};
  var target = ${JSON.stringify(target ?? null)};
  if (wantedText) {
    var needle = wantedText.replace(/\\s+/g, ' ').trim().toLowerCase();
    var present = false;
    eachRoot(document, function (scope) {
      if (present) return;
      var host = scope === document ? document.body : scope;
      var content = host ? String((scope === document ? host.innerText : host.textContent) || '') : '';
      if (content.replace(/\\s+/g, ' ').toLowerCase().indexOf(needle) !== -1) present = true;
    });
    return { ok: true, present: present };
  }
  var resolved = resolveTarget(target);
  if (!resolved.ok) return resolved.code ? { ok: true, present: false } : { ok: true, present: false, reason: resolved.error };
  return { ok: true, present: visible(resolved.element) };
`);

/**
 * Resolves once the page has gone quiet: no new resource and no change to the
 * DOM tree or its text for `quietMs`, or `maxMs` after it started.
 *
 * The load event says only that the document and its static imports arrived.
 * An app then fetches its lazy chunks and replaces its splash screen, and a
 * screenshot taken in between shows the splash as if it were the page.
 * Attribute changes are left out: hover classes and live styles change on a
 * finished page all the time and would hold every wait to its limit. A
 * running animation that will finish counts as a change: a splash fades out
 * by style alone, and a hidden tab, which gets no frames, starts that fade
 * only once a capture shows it.
 */
export const buildQuietScript = ({ quietMs, maxMs }: { quietMs: number; maxMs: number }): string => wrap(`
  var quietMs = ${JSON.stringify(quietMs)};
  var maxMs = ${JSON.stringify(maxMs)};
  return new Promise(function (resolve) {
    var startedAt = performance.now();
    var lastChange = startedAt;
    var bump = function () { lastChange = performance.now(); };
    var mutations = new MutationObserver(bump);
    mutations.observe(document, { subtree: true, childList: true, characterData: true });
    var resources = null;
    try {
      resources = new PerformanceObserver(bump);
      resources.observe({ type: 'resource' });
    } catch (error) {
      resources = null;
    }
    // A fade or slide that will end is the page still changing. One that
    // loops forever (a spinner, a pulsing logo) or follows scrolling never
    // ends on its own and is ignored, and so is a page whose own
    // getAnimations throws: the wait must still end.
    var animating = function () {
      try {
        if (typeof document.getAnimations !== 'function') return false;
        var list = document.getAnimations();
        for (var i = 0; i < list.length; i += 1) {
          var animation = list[i];
          if (animation.playState !== 'running' && !animation.pending) continue;
          if (animation.timeline && animation.timeline !== document.timeline) continue;
          var timing = animation.effect && animation.effect.getTiming ? animation.effect.getTiming() : null;
          if (timing && timing.iterations === Infinity) continue;
          return true;
        }
      } catch (error) {
        return false;
      }
      return false;
    };
    var check = function () {
      var now = performance.now();
      if (animating()) lastChange = now;
      var quiet = now - lastChange >= quietMs;
      if (quiet || now - startedAt >= maxMs) {
        mutations.disconnect();
        if (resources) resources.disconnect();
        resolve({ ok: true, quiet: quiet });
        return;
      }
      setTimeout(check, Math.max(16, Math.min(quietMs - (now - lastChange), maxMs - (now - startedAt))));
    };
    setTimeout(check, quietMs);
  });
`);

/** Properties that answer "how does this look", without dumping the whole cascade. */
const INSPECTED_STYLE_PROPS = [
  'color', 'background-color', 'background-image', 'opacity',
  'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
  'border-radius', 'border-width', 'border-style', 'border-color', 'box-shadow',
  'display', 'position', 'width', 'height', 'padding', 'margin', 'gap',
  'flex-direction', 'justify-content', 'align-items', 'z-index', 'overflow', 'visibility',
];

/**
 * Reads how one element actually renders.
 *
 * The snapshot describes structure, which leaves questions of appearance
 * answerable only by reading the source and hoping the build agrees. Computed
 * styles come from the live page, so a colour reported from here is the colour
 * on screen — and unlike a screenshot it is readable by an agent that cannot
 * see images.
 */
export const buildInspectScript = (target: ElementTarget): string => withTarget(target, `
  var computed = window.getComputedStyle(target);
  var styles = {};
  var props = ${JSON.stringify(INSPECTED_STYLE_PROPS)};
  for (var i = 0; i < props.length; i += 1) {
    var value = computed.getPropertyValue(props[i]);
    if (value) styles[props[i]] = String(value).trim();
  }

  var rect = target.getBoundingClientRect();
  var answer = {
    ok: true,
    tag: target.tagName.toLowerCase(),
    label: label(target),
    bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
    inViewport: rect.bottom > 0 && rect.top < window.innerHeight,
    styles: styles
  };
  if (!inShadow(target)) answer.selector = cssPath(target);
  return answer;
`);
