export type BrowserAnnotationOverlayTheme = {
  readonly colorScheme: 'light' | 'dark';
  readonly primary: string;
  readonly primarySoft: string;
  readonly primaryFaint: string;
  readonly primaryContrast: string;
  readonly surface: string;
  readonly surfaceElevated: string;
  readonly glassSurface: string;
  readonly glassFilter: string;
  readonly border: string;
  readonly text: string;
  readonly mutedText: string;
  readonly danger: string;
};

export type BrowserAnnotationOverlayLabels = {
  readonly select: string;
  readonly marquee: string;
  readonly draw: string;
  readonly commentPlaceholder: string;
  readonly submit: string;
};

export type BrowserAnnotationVoice = {
  readonly shortcut: { key: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean } | null;
  readonly labels: {
    readonly start: string;
    readonly cancel: string;
    readonly insert: string;
    readonly listening: string;
    readonly processing: string;
  };
  readonly icons: { readonly mic: string; readonly close: string; readonly check: string; readonly loader: string };
};

export type AnnotationOverlayMessage = { type: 'voice'; action: 'start' | 'finish' | 'cancel' };

export type AnnotationAppMessage =
  | { type: 'voice'; phase: 'idle' | 'recording' | 'processing'; note?: string; failed?: boolean }
  | { type: 'insert'; text: string }
  | { type: 'level'; level: number };

const ANNOTATION_BINDING = '__openchamberAnnotationSend';
const ANNOTATION_RECEIVER = '__openchamberAnnotationReceive';

const ANNOTATION_ACTIVE_FLAG = '__openchamberBrowserAnnotationActive';

export const ANNOTATION_TEARDOWN_SCRIPT = `(() => {
  try {
    var host = document.querySelector('[data-openchamber-annotation]');
    if (host && host.parentNode) host.parentNode.removeChild(host);
  } catch (error) { /* page navigated away */ }
  try {
    var input = document.querySelector('[data-openchamber-annotation-input]');
    if (input && input.parentNode) input.parentNode.removeChild(input);
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
  voice: BrowserAnnotationVoice | null = null,
): string => {
  const config = JSON.stringify({ theme, labels, voice });
  return String.raw`new Promise((resolve) => {
  var CONFIG = ${config};
  var THEME = CONFIG.theme;
  var LABELS = CONFIG.labels;
  var VOICE = CONFIG.voice;
  var sendToApp = VOICE && typeof window['${ANNOTATION_BINDING}'] === 'function' ? window['${ANNOTATION_BINDING}'] : null;
  var OVERLAY_ATTR = 'data-openchamber-annotation';
  var Z_OVERLAY = 2147483646;
  var MAX_TEXT = 400;
  var MIN_RECT = 3;
  var EDITOR_GAP = 10;
  // Points per path of a stroke. Rewriting one path's d on every move costs
  // time with the whole stroke's length, so a long stroke stalled the pointer;
  // a stroke drawn as short paths rewrites only the last one.
  var STROKE_CHUNK_POINTS = 64;

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
  var settled = false;

  /**
   * Chromium draws a PDF in a viewer frame of its own, so the pointer and keys
   * over it never reach this document. A transparent layer over the viewer
   * takes them instead, and takes focus for Escape. A PDF has no elements to
   * pick, so it offers Region and Draw only. The wheel still reaches the
   * viewer: Chromium routes it past the layer, so the PDF scrolls as usual.
   */
  var isPdf = document.contentType === 'application/pdf';
  var inputLayer = null;
  if (isPdf) {
    inputLayer = document.createElement('div');
    inputLayer.setAttribute('data-openchamber-annotation-input', '');
    inputLayer.tabIndex = -1;
    inputLayer.style.cssText = 'position:fixed !important;inset:0 !important;z-index:' + (Z_OVERLAY - 1) + ' !important;outline:none !important;background:transparent !important';
  }
  var tool = isPdf ? 'marquee' : 'select';

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
  // A manual popover: shown, it joins the browser's top layer without making
  // the rest of the page inert. See "top layer" below.
  host.setAttribute('popover', 'manual');
  // Every declaration is !important: as a popover, and later inside a page
  // dialog, the host matches page rules such as [popover]{background:...},
  // which would otherwise paint a sheet over the whole page.
  host.style.cssText = [
    'all:initial', 'display:block', 'position:fixed', 'inset:0', 'width:auto', 'height:auto',
    'max-width:none', 'max-height:none', 'margin:0', 'padding:0', 'border:0', 'background:transparent',
    'overflow:visible', 'opacity:1', 'transform:none', 'z-index:' + Z_OVERLAY, 'pointer-events:none'
  ].join(' !important;') + ' !important';
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
    '.editor button{appearance:none;border:none;background:' + THEME.primary + ';color:' + THEME.primaryContrast + ';border-radius:999px;width:32px;height:32px;padding:0;display:flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer}',
    '.editor button svg{width:16px;height:16px;display:block}',
    '.editor button[disabled]{opacity:.5;cursor:default}',
    '.editor button.ghost{background:transparent;color:' + THEME.mutedText + ';width:28px;height:28px}',
    '.editor button.ghost:hover{background:' + THEME.primaryFaint + ';color:' + THEME.text + '}',
    '.editor button.ghost.confirm{color:' + THEME.primary + '}',
    '.voice{display:flex;align-items:center;gap:2px;flex-shrink:0}',
    '.rec{display:flex;align-items:center;gap:6px;padding:0 4px;font-size:12px;line-height:18px;color:' + THEME.mutedText + ';white-space:nowrap;font-variant-numeric:tabular-nums}',
    // A status such as a model download is cut short, so the comment keeps its room.
    '.rec span:last-child{max-width:120px;overflow:hidden;text-overflow:ellipsis}',
    '.wave{display:block;width:48px;height:16px}',
    // The dot and the spinner step on timers instead of infinite CSS
    // animations, which draw every frame for as long as they show: the dot
    // dims every other second, the spinner turns four times a second.
    '.dot{width:6px;height:6px;border-radius:50%;background:' + THEME.danger + '}',
    '.dot.dim{opacity:.4}',
    '@media (prefers-reduced-motion:reduce){.dot.dim{opacity:1}}',
    '.spin{display:flex;width:28px;height:28px;align-items:center;justify-content:center;color:' + THEME.mutedText + '}',
    '.spin svg{width:16px;height:16px}',
    '[hidden]{display:none !important}'
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
  var TOOLS = [['select', LABELS.select], ['marquee', LABELS.marquee], ['draw', LABELS.draw]];
  TOOLS.filter(function (entry) { return !isPdf || entry[0] !== 'select'; }).forEach(function (entry) {
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
  // Icon-only attach button (Remix attachment-2), matching the chat comment
  // input; the localized label stays available to assistive tech.
  submit.setAttribute('aria-label', LABELS.submit);
  submit.title = LABELS.submit;
  submit.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.8287 7.75737L9.1718 13.4142C8.78127 13.8047 8.78127 14.4379 9.1718 14.8284C9.56232 15.219 10.1955 15.219 10.586 14.8284L16.2429 9.17158C17.4144 8.00001 17.4144 6.10052 16.2429 4.92894C15.0713 3.75737 13.1718 3.75737 12.0002 4.92894L6.34337 10.5858C4.39075 12.5384 4.39075 15.7042 6.34337 17.6569C8.29599 19.6095 11.4618 19.6095 13.4144 17.6569L19.0713 12L20.4855 13.4142L14.8287 19.0711C12.095 21.8047 7.66283 21.8047 4.92916 19.0711C2.19549 16.3374 2.19549 11.9053 4.92916 9.17158L10.586 3.51473C12.5386 1.56211 15.7045 1.56211 17.6571 3.51473C19.6097 5.46735 19.6097 8.63317 17.6571 10.5858L12.0002 16.2427C10.8287 17.4142 8.92916 17.4142 7.75759 16.2427C6.58601 15.0711 6.58601 13.1716 7.75759 12L13.4144 6.34316L14.8287 7.75737Z" fill="currentColor"/></svg>';
  editor.append(comment, submit);

  // ------------------------------------------------------------------- voice

  var voicePhase = 'idle';
  var voiceNote = '';
  var voiceStartedAt = 0;
  var voiceTimer = null;
  var voiceBusyTimer = null;
  var voiceBusyStep = 0;
  // Enter while the recording runs finishes it, and the annotation goes once
  // the words are in the comment.
  var submitAfterVoice = false;

  var iconButton = function (path, label, className) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + path + '</svg>';
    return button;
  };

  var voiceBox = null, micButton = null, voiceStatus = null, voiceText = null, voiceCancel = null, voiceFinish = null, voiceBusy = null;
  var wave = null;
  if (sendToApp) {
    voiceBox = document.createElement('div');
    voiceBox.className = 'voice';
    micButton = iconButton(VOICE.icons.mic, VOICE.labels.start, 'ghost');
    voiceStatus = document.createElement('div');
    voiceStatus.className = 'rec';
    voiceStatus.setAttribute('role', 'status');
    voiceStatus.setAttribute('aria-label', VOICE.labels.listening);
    var dot = document.createElement('span');
    dot.className = 'dot';
    wave = document.createElement('canvas');
    wave.className = 'wave';
    wave.setAttribute('aria-hidden', 'true');
    voiceText = document.createElement('span');
    voiceStatus.append(dot, wave, voiceText);
    voiceBusy = document.createElement('span');
    voiceBusy.className = 'spin';
    voiceBusy.setAttribute('role', 'status');
    voiceBusy.setAttribute('aria-label', VOICE.labels.processing);
    voiceBusy.title = VOICE.labels.processing;
    voiceBusy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true">' + VOICE.icons.loader + '</svg>';
    voiceCancel = iconButton(VOICE.icons.close, VOICE.labels.cancel, 'ghost');
    voiceFinish = iconButton(VOICE.icons.check, VOICE.labels.insert, 'ghost confirm');
    voiceBox.append(micButton, voiceStatus, voiceBusy, voiceCancel, voiceFinish);
    editor.insertBefore(voiceBox, submit);
  }

  /**
   * Asks the app for its microphone. Only for the user's own input: the page
   * shares this document and can dispatch events at it, but cannot make them
   * trusted.
   */
  var askApp = function (event, action) {
    if (!sendToApp || settled || !event || !event.isTrusted) return;
    try { sendToApp(JSON.stringify({ type: 'voice', action: action })); } catch (error) { /* shell went away */ }
  };

  // The microphone level as the composer draws it: newest bar on the right,
  // silence a dot, speech a rounded bar, quiet speech raised to use the height.
  var waveBars = [];
  var WAVE_BAR = 2, WAVE_PITCH = 5, WAVE_CURVE = 0.65;
  var drawWave = function (level) {
    if (!wave) return;
    var width = 48, height = 16, ratio = window.devicePixelRatio || 1;
    if (wave.width !== width * ratio) {
      wave.width = width * ratio;
      wave.height = height * ratio;
    }
    waveBars.push(Math.max(0, Math.min(1, level)));
    var capacity = Math.floor(width / WAVE_PITCH);
    while (waveBars.length > capacity) waveBars.shift();
    var context = wave.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.strokeStyle = THEME.mutedText;
    context.fillStyle = THEME.mutedText;
    context.lineWidth = WAVE_BAR;
    context.lineCap = 'round';
    var right = width - WAVE_BAR / 2;
    for (var i = 0; i < waveBars.length; i += 1) {
      var x = right - (waveBars.length - 1 - i) * WAVE_PITCH;
      var half = (WAVE_BAR + (height - WAVE_BAR) * Math.pow(waveBars[i], WAVE_CURVE) - WAVE_BAR) / 2;
      context.beginPath();
      if (half < 0.25) {
        context.arc(x, height / 2, WAVE_BAR / 2, 0, Math.PI * 2);
        context.fill();
      } else {
        context.moveTo(x, height / 2 - half);
        context.lineTo(x, height / 2 + half);
        context.stroke();
      }
    }
  };

  var renderVoiceTime = function () {
    if (!voiceText) return;
    var elapsed = Math.max(0, Math.floor((Date.now() - voiceStartedAt) / 1000));
    dot.classList.toggle('dim', voicePhase === 'recording' && elapsed % 2 === 1);
    if (voiceNote) {
      voiceText.textContent = voiceNote;
      return;
    }
    voiceText.textContent = Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0');
  };

  var renderVoice = function () {
    if (!voiceBox) return;
    // A status such as a model download takes the wave's place.
    wave.hidden = Boolean(voiceNote);
    micButton.hidden = voicePhase !== 'idle';
    voiceStatus.hidden = voicePhase !== 'recording';
    voiceBusy.hidden = voicePhase !== 'processing';
    voiceCancel.hidden = voicePhase === 'idle';
    voiceFinish.hidden = voicePhase !== 'recording';
    renderVoiceTime();
  };

  /** Puts the transcript where the caret is, with a space before it when the text runs on. */
  var insertTranscript = function (text) {
    var start = comment.selectionStart == null ? comment.value.length : comment.selectionStart;
    var end = comment.selectionEnd == null ? start : comment.selectionEnd;
    var before = comment.value.slice(0, start);
    var spacer = before && !/\s$/.test(before) ? ' ' : '';
    comment.value = before + spacer + text + comment.value.slice(end);
    var caret = before.length + spacer.length + text.length;
    resizeComment();
    try { comment.setSelectionRange(caret, caret); } catch (error) { /* field went away */ }
  };

  /** Turns the processing spinner by one eighth. */
  var stepVoiceBusy = function () {
    voiceBusyStep = (voiceBusyStep + 1) % 8;
    var icon = voiceBusy && voiceBusy.firstChild;
    if (icon) icon.style.transform = 'rotate(' + voiceBusyStep * 45 + 'deg)';
  };

  var applyVoice = function (message) {
    var was = voicePhase;
    voicePhase = message.phase === 'recording' || message.phase === 'processing' ? message.phase : 'idle';
    voiceNote = typeof message.note === 'string' ? message.note : '';
    if (voicePhase === 'recording' && was !== 'recording') {
      voiceStartedAt = Date.now();
      waveBars = [];
      drawWave(0);
      voiceTimer = setInterval(renderVoiceTime, 1000);
    }
    if (voicePhase !== 'recording' && voiceTimer) {
      clearInterval(voiceTimer);
      voiceTimer = null;
    }
    if (voicePhase === 'processing' && !voiceBusyTimer) {
      voiceBusyStep = -1;
      stepVoiceBusy();
      voiceBusyTimer = setInterval(stepVoiceBusy, 250);
    }
    if (voicePhase !== 'processing' && voiceBusyTimer) {
      clearInterval(voiceBusyTimer);
      voiceBusyTimer = null;
    }
    renderVoice();
    if (voicePhase !== 'idle') return;
    var submitNow = submitAfterVoice && !message.failed;
    submitAfterVoice = false;
    if (submitNow) attach();
    else if (was !== 'idle') comment.focus({ preventScroll: true });
  };

  if (voiceBox) {
    micButton.addEventListener('click', function (event) { askApp(event, 'start'); });
    voiceFinish.addEventListener('click', function (event) { askApp(event, 'finish'); });
    voiceCancel.addEventListener('click', function (event) {
      submitAfterVoice = false;
      askApp(event, 'cancel');
    });
    window['${ANNOTATION_RECEIVER}'] = function (message) {
      if (settled || !message) return;
      if (message.type === 'insert' && typeof message.text === 'string') insertTranscript(message.text);
      else if (message.type === 'voice') applyVoice(message);
      else if (message.type === 'level' && typeof message.level === 'number' && voicePhase === 'recording') drawWave(message.level);
    };
    renderVoice();
  }

  /** The app's dictation shortcut, matched by physical key so Option and other layouts still hit it. */
  var isVoiceShortcut = function (event) {
    var shortcut = VOICE && VOICE.shortcut;
    if (!sendToApp || !shortcut) return false;
    if (event.metaKey !== shortcut.meta || event.ctrlKey !== shortcut.ctrl) return false;
    if (event.altKey !== shortcut.alt || event.shiftKey !== shortcut.shift) return false;
    var code = String(event.code || '');
    var key = code.indexOf('Key') === 0 || code.indexOf('Digit') === 0
      ? code.slice(code.indexOf('Key') === 0 ? 3 : 5).toLowerCase()
      : String(event.key || '').toLowerCase();
    return key === shortcut.key;
  };

  /**
   * Grows the box with its content.
   *
   * A hidden element reports scrollHeight 0, so measuring one collapses the
   * field to nothing, which is what left a sliver of a click target and an
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
        if (drag.chunkPoints >= STROKE_CHUNK_POINTS) {
          // The next path starts where this one ends, so the line stays whole.
          var last = drag.points[drag.points.length - 1];
          drag.path = document.createElementNS(svgNS, 'path');
          drag.group.appendChild(drag.path);
          drag.d = 'M' + last.x + ' ' + last.y;
          drag.chunkPoints = 1;
        }
        drag.points.push({ x: event.clientX, y: event.clientY });
        drag.d += ' L' + event.clientX + ' ' + event.clientY;
        drag.chunkPoints += 1;
        drag.path.setAttribute('d', drag.d);
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

    var group = document.createElementNS(svgNS, 'g');
    group.setAttribute('fill', 'none');
    group.setAttribute('stroke', THEME.primary);
    group.setAttribute('stroke-width', '2.5');
    group.setAttribute('stroke-linecap', 'round');
    group.setAttribute('stroke-linejoin', 'round');
    var path = document.createElementNS(svgNS, 'path');
    group.appendChild(path);
    svg.appendChild(group);
    drag = {
      kind: 'draw',
      group: group,
      path: path,
      d: 'M' + event.clientX + ' ' + event.clientY,
      chunkPoints: 1,
      points: [{ x: event.clientX, y: event.clientY }]
    };
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
      if (finished.group.parentNode) finished.group.parentNode.removeChild(finished.group);
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
    if (event.isComposing || event.keyCode === 229) return;
    if (isVoiceShortcut(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (voicePhase === 'idle') askApp(event, 'start');
      else if (voicePhase === 'recording') askApp(event, 'finish');
      return;
    }
    if (event.key === 'Escape' && voicePhase !== 'idle') {
      // Escape ends the recording first, and the annotation only after.
      event.preventDefault();
      event.stopImmediatePropagation();
      submitAfterVoice = false;
      askApp(event, 'cancel');
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      finish(null);
    }
  };

  var onCommentKeyDown = function (event) {
    // Do not let the annotated page treat typed letters as its own shortcuts.
    event.stopPropagation();
    // WebKit can report the composition-confirming Enter as keyCode 229.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      attach(event);
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
  comment.addEventListener('keydown', onCommentKeyDown);

  // --------------------------------------------------------------- top layer

  /**
   * Keeps the chrome above a modal dialog or popover the page opens.
   *
   * Those render in the browser's top layer, which no z-index reaches, and a
   * modal dialog also makes everything outside itself inert: the outlines drew
   * under the dialog and the comment box took no typing. So the host is shown
   * as a popover, which puts it in the top layer too, and it lives inside the
   * page's topmost modal dialog, where that inertness does not reach. Showing it
   * again whenever the page puts something new on top keeps it last, so above.
   *
   * Opening our own modal dialog instead would make the page's dialog inert,
   * which is the thing being annotated.
   */
  var modals = [];

  var isModalDialog = function (element) {
    if (element.tagName !== 'DIALOG') return false;
    try { return element.matches(':modal'); } catch (error) { return false; }
  };

  var trackDialog = function (dialog) {
    var index = modals.indexOf(dialog);
    if (index !== -1) modals.splice(index, 1);
    // Opened last, so on top. Dialogs already open when annotation starts are
    // taken in document order, which is the usual order of nesting.
    if (isModalDialog(dialog)) modals.push(dialog);
  };

  var topModal = function () {
    for (var i = modals.length - 1; i >= 0; i -= 1) {
      if (modals[i].isConnected && isModalDialog(modals[i])) return modals[i];
    }
    return null;
  };

  var placeHost = function () {
    var parent = topModal() || document.body || document.documentElement;
    var hadFocus = shadow.activeElement === comment;
    if (host.parentNode !== parent) parent.appendChild(host);
    try {
      if (host.matches(':popover-open')) host.hidePopover();
      host.showPopover();
    } catch (error) { /* no popover support: the z-index still covers ordinary pages */ }
    // Moving the host blurs the comment box mid-sentence.
    if (hadFocus) comment.focus({ preventScroll: true });
  };

  var topLayerObserver = new window.MutationObserver(function (records) {
    var changed = false;
    for (var i = 0; i < records.length; i += 1) {
      if (records[i].type === 'attributes' && records[i].target.tagName === 'DIALOG') {
        trackDialog(records[i].target);
        changed = true;
      }
    }
    if (!host.isConnected) {
      // Removed on purpose, not along with a dialog: the session was cancelled
      // from the app or replaced by a new one. End it, so its listeners stop
      // swallowing the page's clicks and nothing brings the host back.
      for (var j = 0; j < records.length; j += 1) {
        if (Array.prototype.indexOf.call(records[j].removedNodes, host) !== -1) {
          finish(null);
          return;
        }
      }
      changed = true;
    }
    if (!changed) return;
    placeHost();
    // Our own move is not a page change.
    topLayerObserver.takeRecords();
  });

  var onToggle = function (event) {
    if (event.target === host || event.newState !== 'open') return;
    placeHost();
    topLayerObserver.takeRecords();
  };

  // With the host inside the page's dialog, clicks on our chrome would reach
  // the dialog's own handlers, and a click outside its box commonly closes it.
  // Typing in the comment box would reach its key handlers the same way.
  var CHROME_EVENTS = BLOCKED_EVENTS.concat([
    'pointerdown', 'pointerup', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input'
  ]);
  var keepChromeEvent = function (event) { event.stopPropagation(); };
  CHROME_EVENTS.forEach(function (name) {
    host.addEventListener(name, keepChromeEvent);
  });

  var startTopLayer = function () {
    Array.prototype.forEach.call(document.querySelectorAll('dialog'), trackDialog);
    placeHost();
    topLayerObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['open']
    });
    document.addEventListener('toggle', onToggle, true);
  };

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
    comment.removeEventListener('keydown', onCommentKeyDown);
    topLayerObserver.disconnect();
    document.removeEventListener('toggle', onToggle, true);
    setCursor('');
    if (cursorStyle.parentNode) cursorStyle.parentNode.removeChild(cursorStyle);
    if (host.parentNode) host.parentNode.removeChild(host);
    if (inputLayer && inputLayer.parentNode) inputLayer.parentNode.removeChild(inputLayer);
    if (voiceTimer) clearInterval(voiceTimer);
    if (voiceBusyTimer) clearInterval(voiceBusyTimer);
    if (voiceBox) {
      try { delete window['${ANNOTATION_RECEIVER}']; } catch (error) { /* non-configurable */ }
    }
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

  var attach = function (event) {
    if (!hasTargets()) return;
    if (voicePhase !== 'idle') {
      if (!event || !event.isTrusted) return;
      submitAfterVoice = true;
      if (voicePhase === 'recording') askApp(event, 'finish');
      return;
    }
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

  if (inputLayer) {
    document.documentElement.appendChild(inputLayer);
    inputLayer.focus({ preventScroll: true });
  }
  startTopLayer();
  setTool(tool);
  syncChrome();
});`;
};
