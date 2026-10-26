import fs from 'node:fs/promises';
import path from 'node:path';
import { inspectLocalImage } from '../markdown-image-grants/inspect-image.js';
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
// How much the local images a page shows may weigh together, in file bytes.
// The chat reads each one into the page as a data URL, and the browser holds
// it decoded on top, so the weight of a page is what bounds the chat's memory.
export const RENDER_PAGE_IMAGE_BUDGET_BYTES = 25 * 1024 * 1024;

/** The local image paths a page names, in order, once each. */
export const renderPageImageSources = (html) => {
  const sources = new Set();
  for (const match of html.matchAll(LOCAL_IMAGE_RE)) sources.add(match[2] ?? match[3]);
  return [...sources];
};

/**
 * Checks every local image a page names and decides which the chat shows: in
 * page order, while their sizes add up to at most the budget. From the first
 * image that does not fit on, none does (`too-heavy`), so the page shows a
 * run from its top. A missing or unreadable image weighs nothing.
 * `inspect(source)` resolves to what `inspectLocalImage` does. The image grant
 * route serves a page with this rule and the agent is told with it, so both
 * agree on what the user sees.
 */
export const fitRenderPageImages = async (html, inspect) => {
  const images = [];
  let shownBytes = 0;
  let totalBytes = 0;
  let full = false;
  for (const source of renderPageImageSources(html)) {
    const inspected = await inspect(source);
    if (inspected.status !== 'ready') {
      images.push({ source, ...inspected });
      continue;
    }
    totalBytes += inspected.size;
    full = full || shownBytes + inspected.size > RENDER_PAGE_IMAGE_BUDGET_BYTES;
    if (full) {
      images.push({ source, status: 'too-heavy', size: inspected.size });
      continue;
    }
    shownBytes += inspected.size;
    images.push({ source, ...inspected });
  }
  return { images, totalBytes };
};

const NOT_SHOWN_REASONS = {
  'too-heavy': 'past the page budget',
  missing: 'file not found',
  error: 'not a readable PNG, JPEG, GIF or WebP of at most 10 MB',
};
const toMegabytes = (bytes) => Math.round(bytes / (1024 * 1024) * 10) / 10;

/**
 * What the agent hears about the page's local images the user will not see,
 * or null when every one shows. Without it the agent heard "shown" and
 * reported a gallery whose later images were broken.
 */
const describeHiddenImages = async (html, directory) => {
  const { images, totalBytes } = await fitRenderPageImages(html, (source) => (
    inspectLocalImage({ source, directory, fsPromises: fs, path }).catch(() => ({ status: 'error' }))
  ));
  const hidden = images.filter((image) => image.status !== 'ready');
  if (hidden.length === 0) return null;
  const tooHeavy = hidden.some((image) => image.status === 'too-heavy');
  return {
    images: {
      shown: images.length - hidden.length,
      notShown: hidden.map((image) => ({ src: image.source, reason: NOT_SHOWN_REASONS[image.status] })),
      ...(tooHeavy && { weightMB: toMegabytes(totalBytes), budgetMB: toMegabytes(RENDER_PAGE_IMAGE_BUDGET_BYTES) }),
    },
    note: tooHeavy
      ? 'Some local images on the page do not show; images.notShown says which. A page shows its images in page order while their files add up to at most budgetMB, and these weigh weightMB: split the page or use smaller images.'
      : 'Some local images on the page do not show; images.notShown says which and why.',
  };
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
const renderPageTitleFromHtml = (html) => (
  elementText(html, /<title\b[^>]*>([\s\S]*?)<\/title>/i)
  || elementText(html, /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i)
).slice(0, RENDER_PAGE_MAX_TITLE_LENGTH).trim();
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
  const hidden = await describeHiddenImages(html, directory);
  if (input.awaitAnswer !== true) {
    return hidden
      ? { shown: true, title, note: `${SHOWN_NOTE} ${hidden.note}`, images: hidden.images }
      : { shown: true, title, note: SHOWN_NOTE };
  }
  // A plugin generated before pages could wait sends no call id.
  if (!sessionId || !callId) {
    throw new OpenChamberControlError('This connection cannot wait for an answer on a page; show the page without awaitAnswer and ask in text', 400);
  }
  const answer = await pageAnswers.wait({ sessionId, callId, title, directory, signal });
  return hidden
    ? { title, answer, note: `${ANSWERED_NOTE} ${hidden.note}`, images: hidden.images }
    : { title, answer, note: ANSWERED_NOTE };
};
