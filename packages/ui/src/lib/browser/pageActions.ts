/**
 * Scripts the agent's browser actions run inside the page.
 *
 * Each builder returns a self-contained expression evaluated in the page's own
 * context, so none of them may reference anything from this module at runtime.
 * Inputs are embedded with `JSON.stringify`, which is what keeps a selector or
 * a typed value from terminating the expression and becoming code.
 *
 * Every script resolves to `{ ok, ... }` instead of throwing, so a failed match
 * comes back as an explainable result rather than an opaque evaluation error.
 */

/**
 * Budget caps. The snapshot cost is bounded by these, not by the size of the
 * page: a document with ten thousand nodes returns the same shape as one with
 * two hundred, because only visible interactive elements are collected and both
 * lists are cut off here. What the caps drop is always reported, so a partial
 * answer never reads as a complete one.
 */
const MAX_TEXT_CHARS = 6_000;
const MAX_ELEMENTS = 120;
/** Enough to recognise a control; full labels are what made entries expensive. */
const MAX_LABEL_CHARS = 80;

/**
 * Shared helpers, injected into each script. `describe` builds the same kind of
 * selector the other actions accept, so a snapshot result is directly usable as
 * input to click or type.
 */
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

const wrap = (body: string): string => `(() => {\n${HELPERS}\n${body}\n})()`;

/**
 * `selector` narrows the snapshot to one subtree.
 *
 * A long page truncates against the caps no matter how they are tuned, which
 * leaves the agent hunting. Scoping answers that directly: ask about the part
 * you mean and the caps stop mattering.
 */
export const buildSnapshotScript = ({ selector }: { selector?: string } = {}): string => wrap(`
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
    // Empty and default-valued fields are left out rather than serialized as
    // "" and false. Repeated across a hundred entries that overhead dwarfed
    // the information it carried.
    var entry = {
      selector: cssPath(element),
      tag: element.tagName.toLowerCase(),
      bounds: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
    };
    // The list covers the whole document so anything can be clicked without
    // scrolling to it first, which means bounds alone do not say what is on
    // screen — a negative y reads as a bug otherwise.
    if (rect.bottom > 0 && rect.top < window.innerHeight) entry.inViewport = true;
    var type = element.getAttribute('type');
    if (type) entry.type = type;
    var role = element.getAttribute('role');
    if (role) entry.role = role;
    var labelText = label(element);
    if (labelText) entry.label = labelText;
    if (element.disabled === true) entry.disabled = true;
    // Flagged rather than described: reporting the accessible name of every
    // element would cost more than it tells, while its absence on something
    // clickable is a defect worth naming.
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
  // State what was dropped. A capped list that reports only its own length
  // reads as the whole page, and the agent acts as if it had seen everything.
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

export const buildClickScript = ({ selector, text }: { selector?: string; text?: string }): string => wrap(`
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

export const buildTypeScript = ({ selector, value, submit }: { selector: string; value: string; submit: boolean }): string => wrap(`
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
    // Frameworks track the value through the native setter; assigning the
    // property directly leaves React and friends unaware of the change.
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
export const buildScrollScript = ({ selector, direction }: { selector?: string; direction?: string }): string => wrap(`
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
    // Instant on purpose: the page's own smooth scrolling would still be
    // animating when the next action runs against it.
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
export const buildInspectScript = ({ selector }: { selector: string }): string => wrap(`
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
