/**
 * The agent's page actions, composed from the desktop driver's steps.
 *
 * The driver (`packages/electron/browser-panel-driver.mjs`) knows frames,
 * scripts and real input; this module knows what an action means. A snapshot
 * reads every frame, cross-origin ones included, and numbers what it lists as
 * refs (`e1`, `e2`, ...). An action names its element by ref, by a selector of
 * the top document, or by the label of a link or button, and the element is
 * then found in its own frame. Pointer actions measure the element there and
 * press at that point of the frame, so the page gets the events a person's
 * click would send.
 *
 * Refs live until the next snapshot of the tab. A ref whose element has since
 * left the page says so, and asks for a new snapshot.
 *
 * A JavaScript dialog holds the page until it is answered: nothing else can
 * run there meanwhile. An action that opens one answers with it, and every
 * later action refuses until `browser.dialog` answers it.
 *
 * Every answer of the driver and of a page script is parsed here, at the
 * boundary, before anything reads it.
 */
import { z } from 'zod';
import type { JsonValue } from '@openchamber/sdk';

import {
  buildDraggableScript,
  buildElementExpression,
  buildHtmlDragScript,
  buildFieldValueScript,
  buildFileInputScript,
  buildFindByTextScript,
  buildFocusFieldScript,
  buildFocusScript,
  buildInspectScript,
  buildPointScript,
  buildScrollScript,
  buildScrollToScript,
  buildSelectScript,
  buildSnapshotScript,
  buildWaitConditionScript,
  MAX_SNAPSHOT_ELEMENTS,
  MAX_SNAPSHOT_TEXT_CHARS,
  STALE_ELEMENT_CODE,
  type ElementTarget,
} from './pageActions';
import { uploadTicketSchema } from './uploads';

export type JsonObject = { [key: string]: JsonValue };

/** One driver step; resolves with what the driver answered over IPC. */
export type DriveStep = (op: string, args?: JsonObject) => Promise<JsonValue>;

/** What an agent action may carry, checked once when the action arrives. */
export const pageActionParametersSchema = z.object({
  ref: z.string().optional(),
  selector: z.string().optional(),
  text: z.string().optional(),
  to: z.string().optional(),
  toSelector: z.string().optional(),
  value: z.string().optional(),
  label: z.string().optional(),
  key: z.string().optional(),
  direction: z.string().optional(),
  submit: z.boolean().optional(),
  accept: z.boolean().optional(),
  gone: z.boolean().optional(),
  timeoutMs: z.number().optional(),
  dialog: z.enum(['accept', 'dismiss']).optional(),
  upload: uploadTicketSchema.optional(),
});

type PageActionParameters = z.infer<typeof pageActionParametersSchema>;

const dialogSchema = z.object({
  type: z.string(),
  message: z.string(),
  defaultPrompt: z.string().optional(),
  url: z.string(),
});
export type PageDialog = z.infer<typeof dialogSchema>;

const frameSchema = z.object({ frameId: z.string(), parentFrameId: z.string().nullable(), url: z.string() });
type Frame = z.infer<typeof frameSchema>;
const framesSchema = z.array(frameSchema).min(1);

const pointSchema = z.object({ x: z.number(), y: z.number() });
type Point = z.infer<typeof pointSchema>;
const boundsSchema = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });

/** A driver step that a dialog may cut short: the page's value, or the dialog. */
const watchedOutcomeSchema = z.object({ dialog: dialogSchema.optional(), value: z.json().optional() });

/** How a page script says it failed; `code` marks an element that left the page. */
const scriptFailureSchema = z.object({ ok: z.literal(false), error: z.string().optional(), code: z.string().optional() });

/** A script answer the driver passes on as it is, besides its `ok`. */
const scriptRecordSchema = z.record(z.string(), z.json());

const snapshotElementSchema = z.object({ id: z.number(), bounds: boundsSchema }).catchall(z.json());
const snapshotSchema = z.object({
  doc: z.string(),
  text: z.string(),
  elements: z.array(snapshotElementSchema),
  textTruncated: z.boolean().optional(),
  textTotalChars: z.number().optional(),
  elementsTruncated: z.boolean().optional(),
  interactiveElementsOnPage: z.number().optional(),
}).catchall(z.json());
type SnapshotResult = z.infer<typeof snapshotSchema>;

const foundSchema = z.discriminatedUnion('found', [
  z.object({ found: z.literal(false) }),
  z.object({ found: z.literal(true), exact: z.boolean(), id: z.number(), doc: z.string() }),
]);
const elementPointSchema = pointSchema.extend({ label: z.string(), selector: z.string().optional() });
const focusedFieldSchema = z.object({ selector: z.string().optional() });
const fieldValueSchema = z.object({ value: z.string(), valueTruncated: z.boolean() });
const fileInputSchema = z.object({ multiple: z.boolean() });
const draggableSchema = z.object({ draggable: z.boolean() });
const htmlDragSchema = z.object({ accepted: z.boolean() });
const presenceSchema = z.object({ present: z.boolean() });
const inspectSchema = z.object({ bounds: boundsSchema, selector: z.string().optional() }).catchall(z.json());

/** An element an action names, in its frame; `frame` is set for one below the top document. */
type Resolved = { frameId: string; target: ElementTarget; name: string; frame: Frame | null };
type ElementPoint = Point & { frameId: string; label: string; selector: string | null };
type Bounds = z.infer<typeof boundsSchema>;
/** Where an inspected element is: on the page with its frame, or by selector in the top document. */
type Placement = { bounds: Bounds; frame: string } | { bounds: Bounds; selector: string } | { bounds: Bounds };

/** How long `browser.wait` may wait, inside the server's 20 s for one action. */
const MAX_WAIT_MS = 15_000;
const WAIT_POLL_MS = 250;

/** A parameter's value when it holds any text. */
const nonEmpty = (value: string | undefined): string | null => (value ? value : null);

const dialogNote = (dialog: PageDialog): string => (
  `The page opened a ${dialog.type} dialog${dialog.message ? ` saying "${dialog.message}"` : ''} and waits for an answer. `
  + 'Answer it with browser.dialog (accept true or false) before anything else.'
);

class DialogOpenError extends Error {
  constructor(readonly dialog: PageDialog) {
    super(dialogNote(dialog));
  }
}

const staleRefError = (ref: string): Error => new Error(
  `${ref} is not on the page any more, or comes from an older snapshot. Take a new browser.snapshot and use its refs.`,
);

/** A dialog as an answer shows it; `defaultPrompt` only when the page gave one. */
type DialogAnswer = { type: string; message: string; url: string } | { type: string; message: string; url: string; defaultPrompt: string };

const dialogJson = (dialog: PageDialog): DialogAnswer => (dialog.defaultPrompt === undefined
  ? { type: dialog.type, message: dialog.message, url: dialog.url }
  : { type: dialog.type, message: dialog.message, url: dialog.url, defaultPrompt: dialog.defaultPrompt });

/** Shifts bounds measured in a frame onto the page. */
const onPage = (bounds: Bounds, origin: Point): Bounds => ({
  x: Math.round(bounds.x + origin.x),
  y: Math.round(bounds.y + origin.y),
  width: bounds.width,
  height: bounds.height,
});

export const createPageDriver = ({
  drive,
  withInput,
}: {
  drive: DriveStep;
  /** Runs real input with the page drawn: a page that is not composited takes none. */
  withInput: <T>(run: () => Promise<T>) => Promise<T>;
}) => {
  let refs = new Map<string, { frameId: string; id: number; doc: string }>();

  const listFrames = async (): Promise<Frame[]> => {
    const parsed = framesSchema.safeParse(await drive('frames'));
    if (!parsed.success) throw new Error('The page has no frame to act in yet');
    return parsed.data;
  };

  const openDialog = async (): Promise<PageDialog | null> => dialogSchema.nullable().parse(await drive('dialog'));

  /** Throws the open dialog's explanation: a page held by one runs nothing. */
  const ensureNoDialog = async (): Promise<void> => {
    const open = await openDialog();
    if (open) throw new DialogOpenError(open);
  };

  /** A driver step that may be cut short by a dialog the page opens. */
  const watched = async (op: string, args: JsonObject): Promise<JsonValue | undefined> => {
    const outcome = watchedOutcomeSchema.parse(await drive(op, args));
    if (outcome.dialog) throw new DialogOpenError(outcome.dialog);
    return outcome.value;
  };

  /** Runs a page script in a frame and parses what it answered with `schema`. */
  const evaluate = async <T,>(frameId: string, expression: string, schema: z.ZodType<T>, refName?: string): Promise<T> => {
    const value = await watched('evaluate', { frameId, expression });
    const failure = scriptFailureSchema.safeParse(value);
    if (failure.success) {
      if (refName && failure.data.code === STALE_ELEMENT_CODE) throw staleRefError(refName);
      throw new Error(failure.data.error || 'Browser action failed');
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new Error('The page returned no usable result');
    return parsed.data;
  };

  /** A script's answer as the agent reads it, without the `ok` every script sends. */
  const record = async (frameId: string, expression: string, refName?: string): Promise<JsonObject> => {
    const result = await evaluate(frameId, expression, scriptRecordSchema, refName);
    delete result.ok;
    return result;
  };

  /** Where a frame's content starts in the top viewport, for the bounds a snapshot reports. */
  const frameOrigin = async (frame: Frame, topFrameId: string): Promise<Point> => {
    if (frame.frameId === topFrameId) return { x: 0, y: 0 };
    const origin = pointSchema.safeParse(await drive('frameOrigin', { frameId: frame.frameId }));
    if (!origin.success) throw new Error('Could not tell where the frame sits on the page');
    return origin.data;
  };

  /**
   * The element an action names. A ref goes to its frame; a selector reads
   * the top document; a label is looked for in every frame, an exact match
   * anywhere before a partial one.
   */
  const resolve = async (
    ref: string | null,
    selector: string | null,
    label: string | null,
  ): Promise<Resolved> => {
    const frames = await listFrames();
    const below = (frameId: string): Frame | null => {
      const frame = frames.find((entry) => entry.frameId === frameId);
      return frame && frame.frameId !== frames[0].frameId ? frame : null;
    };
    if (ref) {
      const known = refs.get(ref);
      // A frame that navigated or left takes its refs with it.
      if (!known || !frames.some((frame) => frame.frameId === known.frameId)) throw staleRefError(ref);
      return { frameId: known.frameId, target: { id: known.id, doc: known.doc }, name: ref, frame: below(known.frameId) };
    }
    if (selector) return { frameId: frames[0].frameId, target: { selector }, name: selector, frame: null };
    if (label) {
      let partial: Resolved | null = null;
      for (const frame of frames) {
        let found: z.infer<typeof foundSchema>;
        try {
          found = await evaluate(frame.frameId, buildFindByTextScript(label), foundSchema);
        } catch (error) {
          if (error instanceof DialogOpenError) throw error;
          continue;
        }
        if (!found.found) continue;
        const match: Resolved = { frameId: frame.frameId, target: { id: found.id, doc: found.doc }, name: label, frame: below(frame.frameId) };
        if (found.exact) return match;
        partial ??= match;
      }
      if (partial) return partial;
      throw new Error(`No clickable element has the label ${label}`);
    }
    throw new Error('Name the element with ref from browser.snapshot, a selector, or text');
  };

  const resolveTarget = (parameters: PageActionParameters, allowText = false): Promise<Resolved> => resolve(
    nonEmpty(parameters.ref),
    nonEmpty(parameters.selector),
    allowText ? nonEmpty(parameters.text) : null,
  );

  /**
   * Brings the element on screen in its frame and answers where to press it
   * there; the driver sends the press to that frame's own session.
   */
  const pointOf = async (resolved: Resolved, requireEnabled = true): Promise<ElementPoint> => {
    const local = await evaluate(resolved.frameId, buildPointScript(resolved.target, { requireEnabled }), elementPointSchema, resolved.name);
    return {
      frameId: resolved.frameId,
      x: local.x,
      y: local.y,
      label: local.label,
      // A selector of a frame's document reaches nothing from the top one.
      selector: resolved.frame ? null : local.selector ?? null,
    };
  };

  /** Adds what names the element in an answer: the ref the agent used, else its selector. */
  const nameInto = (answer: JsonObject, ref: string | undefined, selector: string | null): JsonObject => {
    if (ref) answer.ref = ref;
    else if (selector) answer.selector = selector;
    return answer;
  };

  /**
   * Runs an input action. A dialog it opens is part of its answer: the press
   * happened, and the page now waits on the agent.
   */
  const input = async (run: () => Promise<JsonObject>): Promise<JsonObject> => {
    await ensureNoDialog();
    return withInput(async () => {
      try {
        return await run();
      } catch (error) {
        if (error instanceof DialogOpenError) return { dialog: dialogJson(error.dialog), note: dialogNote(error.dialog) };
        throw error;
      }
    });
  };

  const snapshot = async (parameters: PageActionParameters): Promise<JsonObject> => {
    const open = await openDialog();
    // The page is held by the dialog, and reading it would wait as long.
    if (open) return { dialog: dialogJson(open), note: dialogNote(open) };
    const scope = nonEmpty(parameters.selector);
    const frames = await listFrames();
    const [top, ...children] = frames;
    const nextRefs = new Map<string, { frameId: string; id: number; doc: string }>();
    const elements: JsonObject[] = [];
    let interactiveTotal = 0;
    let textTotal = 0;
    let textTruncated = false;

    const take = (frame: Frame, result: SnapshotResult, origin: Point | null) => {
      interactiveTotal += result.interactiveElementsOnPage ?? result.elements.length;
      if (result.textTruncated) textTruncated = true;
      textTotal += result.textTotalChars ?? result.text.length;
      for (const { id, bounds, ...rest } of result.elements) {
        const ref = `e${nextRefs.size + 1}`;
        nextRefs.set(ref, { frameId: frame.frameId, id, doc: result.doc });
        // A selector of a frame's document reaches nothing from the top one.
        const { selector: _frameSelector, ...framed } = rest;
        elements.push(origin
          ? { ref, ...framed, bounds: onPage(bounds, origin), frame: frame.url }
          : { ref, ...rest, bounds });
      }
    };

    const topResult = await evaluate(top.frameId, buildSnapshotScript({ selector: scope ?? undefined }), snapshotSchema);
    take(top, topResult, null);
    let pageText = topResult.text;

    // A scoped snapshot reads the part of the top document it names; frames are outside it.
    const framesRead: JsonObject[] = [];
    if (!scope) {
      for (const frame of children) {
        const elementBudget = Math.max(0, MAX_SNAPSHOT_ELEMENTS - elements.length);
        const textBudget = Math.max(0, MAX_SNAPSHOT_TEXT_CHARS - pageText.length);
        let result: SnapshotResult;
        try {
          result = await evaluate(frame.frameId, buildSnapshotScript({ maxElements: elementBudget, maxTextChars: textBudget }), snapshotSchema);
        } catch (error) {
          if (error instanceof DialogOpenError) throw error;
          // A frame that went away or refuses scripts leaves the others readable.
          continue;
        }
        if (result.elements.length === 0 && !result.text && !result.elementsTruncated) continue;
        let origin: Point = { x: 0, y: 0 };
        try {
          origin = await frameOrigin(frame, top.frameId);
        } catch {
          // Bounds then read as frame-relative; the refs still work.
        }
        take(frame, result, origin);
        if (result.text) pageText += `\n\n[frame ${frame.url}]\n${result.text}`;
        framesRead.push({ url: frame.url, elements: result.elements.length });
      }
    }
    refs = nextRefs;

    const {
      elements: _topElements, interactiveElementsOnPage: _topTotal, elementsTruncated: _topTruncated,
      textTruncated: _topTextTruncated, textTotalChars: _topTextTotal, doc: _topDoc, ...page
    } = topResult;
    delete page.ok;
    // What the caps dropped, said only when they dropped something.
    return Object.assign(
      { ...page, text: pageText, elements },
      textTruncated ? { textTruncated: true, textTotalChars: textTotal } : null,
      interactiveTotal > elements.length ? { elementsTruncated: true, interactiveElementsOnPage: interactiveTotal } : null,
      framesRead.length > 0 ? { frames: framesRead } : null,
    );
  };

  const click = (parameters: PageActionParameters) => input(async () => {
    const point = await pointOf(await resolveTarget(parameters, true));
    await watched('click', { frameId: point.frameId, x: point.x, y: point.y });
    const answer = nameInto({ clicked: true }, parameters.ref, point.selector);
    if (point.label) answer.label = point.label;
    return answer;
  });

  const hover = (parameters: PageActionParameters) => input(async () => {
    const point = await pointOf(await resolveTarget(parameters, true), false);
    await watched('hover', { frameId: point.frameId, x: point.x, y: point.y });
    const answer = nameInto({ hovered: true }, parameters.ref, point.selector);
    if (point.label) answer.label = point.label;
    return answer;
  });

  const drag = (parameters: PageActionParameters) => input(async () => {
    const source = await resolveTarget(parameters);
    const destination = await resolve(nonEmpty(parameters.to), nonEmpty(parameters.toSelector), null);
    const destinationName = nonEmpty(parameters.to) ?? nonEmpty(parameters.toSelector);
    const { draggable } = await evaluate(source.frameId, buildDraggableScript(source.target), draggableSchema, source.name);
    if (draggable) {
      // An HTML drag would start the system's drag session in the app's
      // window, so the page gets the drag as its own events instead.
      if (source.frameId !== destination.frameId) throw new Error('An HTML drag can only drop inside the same frame of the page');
      const { accepted } = await evaluate(source.frameId, buildHtmlDragScript(source.target, destination.target), htmlDragSchema, source.name);
      const answer = nameInto({ dragged: true, to: destinationName, mode: 'html' }, parameters.ref, null);
      if (!accepted) answer.note = 'The target did not accept the drop: its dragover was not cancelled.';
      return answer;
    }
    // The drop target first, then the source: measuring the source last
    // keeps it where it is on screen when the press starts.
    const to = await pointOf(destination, false);
    const from = await pointOf(source, false);
    await watched('drag', {
      from: { frameId: from.frameId, x: from.x, y: from.y },
      to: { frameId: to.frameId, x: to.x, y: to.y },
    });
    return nameInto({ dragged: true, to: destinationName ?? to.selector, mode: 'pointer' }, parameters.ref, from.selector);
  });

  const type = (parameters: PageActionParameters) => input(async () => {
    const resolved = await resolveTarget(parameters);
    const value = parameters.value ?? '';
    const focused = await evaluate(resolved.frameId, buildFocusFieldScript(resolved.target), focusedFieldSchema, resolved.name);
    // The field's content is selected, so the new text replaces it.
    if (value) await watched('insertText', { text: value });
    else await watched('press', { key: 'Delete' });
    if (parameters.submit) await watched('press', { key: 'Enter' });
    const answer = nameInto({ typed: true }, parameters.ref, resolved.frame ? null : focused.selector ?? null);
    try {
      const typed = await evaluate(resolved.frameId, buildFieldValueScript(resolved.target), fieldValueSchema, resolved.name);
      answer.value = typed.value;
      if (typed.valueTruncated) answer.valueTruncated = true;
    } catch (error) {
      // A submit that navigated took the field with it; the typing still happened.
      if (error instanceof DialogOpenError) throw error;
    }
    return answer;
  });

  const press = (parameters: PageActionParameters) => input(async () => {
    const key = nonEmpty(parameters.key);
    if (!key) throw new Error('key is required, such as Enter, Escape, Tab or Meta+a');
    if (nonEmpty(parameters.ref) || nonEmpty(parameters.selector)) {
      const resolved = await resolveTarget(parameters);
      await evaluate(resolved.frameId, buildFocusScript(resolved.target), scriptRecordSchema, resolved.name);
    }
    await watched('press', { key });
    return { pressed: key };
  });

  const select = async (parameters: PageActionParameters): Promise<JsonObject> => {
    await ensureNoDialog();
    const resolved = await resolveTarget(parameters);
    const result = await record(resolved.frameId, buildSelectScript(resolved.target, { label: parameters.label, value: parameters.value }), resolved.name);
    if (resolved.frame) delete result.selector;
    if (parameters.ref) result.ref = parameters.ref;
    return result;
  };

  const scroll = async (parameters: PageActionParameters): Promise<JsonObject> => {
    await ensureNoDialog();
    if (nonEmpty(parameters.ref) || nonEmpty(parameters.selector)) {
      const resolved = await resolveTarget(parameters);
      return record(resolved.frameId, buildScrollToScript(resolved.target), resolved.name);
    }
    const direction = nonEmpty(parameters.direction);
    if (!direction) throw new Error('browser.scroll requires direction, ref or selector');
    const frames = await listFrames();
    return record(frames[0].frameId, buildScrollScript({ direction }));
  };

  const inspect = async (parameters: PageActionParameters): Promise<JsonObject> => {
    await ensureNoDialog();
    const resolved = await resolveTarget(parameters);
    const { bounds, selector, ...styles } = await evaluate(resolved.frameId, buildInspectScript(resolved.target), inspectSchema, resolved.name);
    delete styles.ok;
    // Bounds read the way a snapshot reports them: on the page.
    const placement: Placement = resolved.frame
      ? { bounds: onPage(bounds, await frameOrigin(resolved.frame, (await listFrames())[0].frameId)), frame: resolved.frame.url }
      : selector ? { bounds, selector } : { bounds };
    return Object.assign({ ...styles, ...placement }, parameters.ref ? { ref: parameters.ref } : null);
  };

  /** Attaches files the shell staged for this upload to a file input. */
  const upload = async (parameters: PageActionParameters, stagedPaths: string[]): Promise<JsonObject> => {
    await ensureNoDialog();
    const resolved = await resolveTarget(parameters);
    const { multiple } = await evaluate(resolved.frameId, buildFileInputScript(resolved.target), fileInputSchema, resolved.name);
    if (stagedPaths.length > 1 && !multiple) throw new Error('This file input takes one file; pass one path');
    await drive('setFiles', { frameId: resolved.frameId, expression: buildElementExpression(resolved.target), files: stagedPaths });
    return { uploaded: stagedPaths.length };
  };

  const answerDialog = async (parameters: PageActionParameters): Promise<JsonValue> => {
    if (parameters.accept === undefined) throw new Error('accept is required: true to accept, false to dismiss');
    return drive('answerDialog', parameters.value === undefined
      ? { accept: parameters.accept }
      : { accept: parameters.accept, promptText: parameters.value });
  };

  /**
   * Waits until text shows on the page, or an element shows, or, with `gone`,
   * until either has left. Checks every quarter second.
   */
  const wait = async (parameters: PageActionParameters, sleep: (ms: number) => Promise<void>, now: () => number): Promise<JsonObject> => {
    await ensureNoDialog();
    const wantedText = nonEmpty(parameters.text);
    const gone = parameters.gone === true;
    const timeoutMs = Math.min(MAX_WAIT_MS, Math.max(0, parameters.timeoutMs ?? MAX_WAIT_MS));
    const resolved = wantedText ? null : await resolveTarget(parameters);
    const startedAt = now();
    for (;;) {
      let present = false;
      if (resolved) {
        present = (await evaluate(resolved.frameId, buildWaitConditionScript({ target: resolved.target }), presenceSchema)).present;
      } else {
        for (const frame of await listFrames()) {
          try {
            if ((await evaluate(frame.frameId, buildWaitConditionScript({ text: wantedText ?? '' }), presenceSchema)).present) {
              present = true;
              break;
            }
          } catch (error) {
            if (error instanceof DialogOpenError) throw error;
          }
        }
      }
      const waited = now() - startedAt;
      if (present !== gone) return { met: true, waitedMs: waited };
      if (waited >= timeoutMs) {
        const what = wantedText ? `the text "${wantedText}"` : resolved?.name ?? 'it';
        throw new Error(`Waited ${(waited / 1000).toFixed(1)} s, and ${what} ${gone ? 'is still on the page' : 'did not show up'}.`);
      }
      await sleep(WAIT_POLL_MS);
    }
  };

  return { snapshot, click, hover, drag, type, press, select, scroll, inspect, upload, answerDialog, wait, ensureNoDialog };
};
