import { isString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';

// The page travels in the tool call's input, which OpenCode stores with the
// message and streams to every client, and through the callback request, whose
// JSON body is capped at 1 MB. 200,000 characters stays under that cap even for
// text that encodes to several bytes per character, and is far more than a
// chart or table page needs.
export const RENDER_PAGE_MAX_HTML_LENGTH = 200_000;
export const RENDER_PAGE_MAX_TITLE_LENGTH = 120;
// An answer is a choice and a few values, never a document: the page sends
// what the user picked and the agent builds the rest itself.
const RENDER_PAGE_MAX_SUMMARY_LENGTH = 500;
const RENDER_PAGE_MAX_ANSWER_DATA_LENGTH = 16_000;

// A local image a page names by its absolute path: a quoted string (an src
// attribute, a CSS url("..."), a string in the page's script) or an unquoted
// CSS url(...). The chat swaps each for the file's contents before drawing the
// page, which cannot read files itself. The UI reads pages with the same rule
// (packages/ui/src/components/chat/message/parts/renderPageImages.ts).
// A quoted path may hold spaces (macOS names screenshots that way); an
// unquoted url() ends at the first space or parenthesis.
const LOCAL_IMAGE_RE = /(["'`])((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>\n]*?\.(?:png|jpe?g|gif|webp))\1|url\(\s*((?:file:\/\/|\/(?!\/)|[A-Za-z]:[\\/])[^"'`<>()\s]*?\.(?:png|jpe?g|gif|webp))\s*\)/gi;
// The image grant route prepares at most this many images in one request.
const RENDER_PAGE_MAX_LOCAL_IMAGES = 12;

/** The local image paths a page names, in order, at most RENDER_PAGE_MAX_LOCAL_IMAGES. */
export const renderPageImageSources = (html) => {
  const sources = new Set();
  for (const match of html.matchAll(LOCAL_IMAGE_RE)) {
    sources.add(match[2] ?? match[3]);
    if (sources.size === RENDER_PAGE_MAX_LOCAL_IMAGES) break;
  }
  return [...sources];
};

// A page sent without a title is named after its own <title>, else its first
// h1 to h3, else "Page". Weaker models sent title and html in separate calls,
// and every call refused for a missing title cost the whole page again. The
// chat names such a page with the same rule (pageTitleFromHtml in
// packages/ui/src/lib/opencode/tools.ts); change both together.
const TITLE_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", nbsp: ' ' };
const elementText = (html, pattern) => (pattern.exec(html)?.[1] ?? '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (_, entity) => TITLE_ENTITIES[entity])
  .replace(/\s+/g, ' ')
  .trim();
// A plain slice at the title cap can land between the halves of a surrogate
// pair, leaving a lone high surrogate that names the page and encodes as
// U+FFFD; move a cut that lands inside a pair back to the pair boundary,
// before the trailing trim (same guard as client-auth/pairing.js).
const clipPairSafe = (text, limit) => {
  const clipped = text.slice(0, limit);
  const last = clipped.charCodeAt(clipped.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
};

const renderPageTitleFromHtml = (html) => {
  const title = elementText(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i)
    || elementText(html, /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
  return clipPairSafe(title, RENDER_PAGE_MAX_TITLE_LENGTH).trim();
};
const RENDER_PAGE_FALLBACK_TITLE = 'Page';

const SHOWN_NOTE = "Shown to the user in the chat above your reply. Don't announce, describe or restate the page; reply with only what it doesn't already say.";

const ANSWERED_NOTE = "The user answered on the page. summary is their choice in words, data is what the page sent. Continue the task from it; the chat already shows the summary under the page, so don't repeat it back.";

/**
 * What the agent reads when the user wrote in the chat instead of answering on
 * the page. The plugin builds that result itself (see ../agent-tool/runtime.js),
 * because the wait ends there, before this server hears of it.
 */
export const RENDER_PAGE_CLOSED_IN_CHAT_NOTE = "The user did not answer on the page and wrote in the chat instead; their message follows this result. Continue from that message and don't ask the same question on a page again unless they want it.";

const pageKey = (sessionId, callId) => `${sessionId}\u0000${callId}`;

/**
 * Pages that wait for the user's answer, keyed by session and tool call. The
 * call's request stays open while its page waits: an answer resolves it, and an
 * aborted request (the user stopped the turn, wrote in the chat, or OpenCode
 * went away) drops it. Nothing is kept once a call ends, so a page answers at
 * most once and a stale answer finds nothing to resolve.
 *
 * `onWaitChange` hears when a page starts and stops waiting, so the server can
 * show the session as waiting for the user the way it does for a form.
 */
export const createPageAnswers = ({ onWaitChange = () => {} } = {}) => {
  const waiting = new Map();

  // A listener failure must not break the call the user is answering.
  const announce = (change) => {
    try {
      onWaitChange(change);
    } catch (error) {
      console.warn('[render.page] wait listener failed:', error?.message ?? error);
    }
  };

  const wait = ({ sessionId, callId, title, directory, signal }) => new Promise((resolve, reject) => {
    const key = pageKey(sessionId, callId);
    if (waiting.has(key)) {
      reject(new OpenChamberControlError('This call already shows a page that waits for an answer', 409));
      return;
    }
    if (signal?.aborted) {
      reject(new OpenChamberControlError('The page stopped waiting before the user answered', 499));
      return;
    }
    const onAbort = () => {
      waiting.delete(key);
      announce({ type: 'settled', sessionId, callId });
      reject(new OpenChamberControlError('The page stopped waiting before the user answered', 499));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    waiting.set(key, (answer) => {
      waiting.delete(key);
      signal?.removeEventListener('abort', onAbort);
      announce({ type: 'settled', sessionId, callId });
      resolve(answer);
    });
    announce({ type: 'waiting', sessionId, callId, title, directory: directory || null });
  });

  const answer = (input = {}) => {
    const sessionId = isString(input.sessionId) ? input.sessionId.trim() : '';
    const callId = isString(input.callId) ? input.callId.trim() : '';
    if (!sessionId || !callId) {
      throw new OpenChamberControlError('sessionId and callId are required', 400);
    }
    const summary = isString(input.summary) ? input.summary.trim() : '';
    if (!summary) {
      throw new OpenChamberControlError('summary is required: what the user chose, in a few words', 400);
    }
    if (summary.length > RENDER_PAGE_MAX_SUMMARY_LENGTH) {
      throw new OpenChamberControlError(`summary is ${summary.length} characters; the limit is ${RENDER_PAGE_MAX_SUMMARY_LENGTH}`, 400);
    }
    const data = input.data === undefined ? null : input.data;
    const dataLength = JSON.stringify(data).length;
    if (dataLength > RENDER_PAGE_MAX_ANSWER_DATA_LENGTH) {
      throw new OpenChamberControlError(`data is ${dataLength} characters as JSON; the limit is ${RENDER_PAGE_MAX_ANSWER_DATA_LENGTH}`, 413);
    }
    const resolve = waiting.get(pageKey(sessionId, callId));
    if (!resolve) {
      throw new OpenChamberControlError('This page is no longer waiting for an answer', 404);
    }
    resolve({ answered: true, summary, data });
    return { answered: true };
  };

  return { wait, answer };
};

/**
 * `render.page`: the chat draws the page straight from the call's input, so
 * this checks that the input is a page the chat will draw and that the tool is
 * still on (a plugin generated before it was switched off must not keep
 * drawing). With `awaitAnswer` the call then waits for the user's answer.
 */
export const createRenderPageAction = ({ isEnabled, pageAnswers }) => async (input, { sessionId, callId, directory, signal } = {}) => {
  if (!await isEnabled()) {
    throw new OpenChamberControlError('The render tool is turned off in OpenChamber settings', 403);
  }
  const html = isString(input.html) ? input.html : '';
  if (!html.trim()) {
    throw new OpenChamberControlError('html is required: one complete, self-contained HTML document. Send html and title together in one call', 400);
  }
  if (html.length > RENDER_PAGE_MAX_HTML_LENGTH) {
    throw new OpenChamberControlError(`html is ${html.length} characters; the limit is ${RENDER_PAGE_MAX_HTML_LENGTH}. Make the page smaller, for example by drawing data with a script instead of writing out every element`, 400);
  }
  const title = (isString(input.title) ? input.title.trim() : '')
    || renderPageTitleFromHtml(html)
    || RENDER_PAGE_FALLBACK_TITLE;
  if (title.length > RENDER_PAGE_MAX_TITLE_LENGTH) {
    throw new OpenChamberControlError(`title is ${title.length} characters; the limit is ${RENDER_PAGE_MAX_TITLE_LENGTH}`, 400);
  }
  if (input.awaitAnswer !== true) {
    return { shown: true, title, note: SHOWN_NOTE };
  }
  // A plugin generated before pages could wait sends no call id.
  if (!sessionId || !callId) {
    throw new OpenChamberControlError('This connection cannot wait for an answer on a page; show the page without awaitAnswer and ask in text', 400);
  }
  const answer = await pageAnswers.wait({ sessionId, callId, title, directory, signal });
  return { title, answer, note: ANSWERED_NOTE };
};
