/**
 * The manual model and effort choices the user made, and their answers to
 * suggestions built from them, kept in `<dataDir>/model-choices.json`.
 *
 * An event never carries message text: where the choice was made, what was
 * chosen, what it replaced, the session's model, and a size bucket of the
 * input the UI computed. The file keeps the newest 5,000 events from the last
 * 90 days; older ones are dropped on every write. Decisions carry no expiry
 * (a declined suggestion stays declined), so they are bounded by count
 * alone: the newest 5,000, dropped on every write the same way.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

import { renameWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFile } from '../shared/bounded-file-read.js';

const MODEL_CHOICE_FILE_NAME = 'model-choices.json';
export const MAX_MODEL_CHOICE_EVENTS = 5_000;
export const MODEL_CHOICE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const MAX_MODEL_CHOICE_DECISIONS = 5_000;

/**
 * Maximum read bytes for model-choices.json.
 * A legitimate file holds at most 5,000 events and 5,000 decisions (the
 * write-side bounds above). An event carries three model refs of at most
 * 300 chars and two variants of at most 64, plus enum fields and a
 * timestamp: under 1,200 chars, so at most ~4.3 KiB even if every text
 * char were a four-byte UTF-8 char — ~21 MiB for 5,000. A decision is an
 * id of at most 400 chars plus a verdict and a timestamp: at most
 * ~1.7 KiB on the same basis — ~8.5 MiB for 5,000. The legitimate worst
 * case is therefore ~30 MiB; 64 MiB gives over 2x headroom over it.
 */
export const MODEL_CHOICES_MAX_BYTES = 64 * 1024 * 1024; // 64 MiB

const MODEL_CHOICE_SURFACES = ['goal-writer', 'composer'];
const MODEL_CHOICE_INPUT_SIZES = ['empty', 'short', 'medium', 'long', 'unknown'];

const modelRefSchema = z.string().trim().min(3).max(300).regex(/^[^/\s]+\/\S+$/);
const variantSchema = z.string().trim().min(1).max(64).nullable();
const selectionSchema = z.object({ model: modelRefSchema, variant: variantSchema });

/** What the UI sends for one choice; unknown keys are dropped. */
const modelChoiceInputSchema = z.object({
  surface: z.enum(MODEL_CHOICE_SURFACES),
  kind: z.enum(['model', 'effort']),
  chosen: selectionSchema,
  replaced: selectionSchema.nullable(),
  sessionModel: modelRefSchema.nullable(),
  inputSize: z.enum(MODEL_CHOICE_INPUT_SIZES),
});

const storedEventSchema = modelChoiceInputSchema.extend({ at: z.number().int().nonnegative() });
const decisionSchema = z.object({
  id: z.string().min(1).max(400),
  decision: z.enum(['approved', 'declined']),
  at: z.number().int().nonnegative(),
});
const fileSchema = z.object({
  version: z.literal(1),
  events: z.array(storedEventSchema),
  decisions: z.array(decisionSchema),
});

export class ModelChoiceStoreError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const createModelChoiceStore = ({ dataDir, now = Date.now, fs = fsPromises }) => {
  const filePath = path.join(dataDir, MODEL_CHOICE_FILE_NAME);
  let queue = Promise.resolve();

  // One read-modify-write at a time, so two choices made together both land.
  const serialized = (operation) => {
    const run = queue.then(operation, operation);
    queue = run.catch(() => undefined);
    return run;
  };

  // A missing file is no history. A malformed one is an error, never an empty
  // history: writing over it would erase what it held. Clearing removes it.
  const read = async () => {
    // Bounded, handle-judged read (#1610): at most the cap + 1 byte is
    // ever buffered, and a FIFO or other non-regular file at the path is
    // refused promptly instead of wedging the serialized queue behind a
    // read that never settles. Unexpected I/O errors still throw.
    const result = await readBoundedFile(filePath, MODEL_CHOICES_MAX_BYTES, { fs });
    if (!result.ok) {
      if (result.reason === 'missing') return { version: 1, events: [], decisions: [] };
      // Over-cap or non-regular is unreadable, with the same strict
      // answer as a malformed file: an error, never an empty history.
      throw new ModelChoiceStoreError('The model choice history is unreadable; clear it in Settings to start again', 500);
    }
    const text = result.buffer.toString('utf8');
    let parsed;
    try {
      parsed = fileSchema.safeParse(JSON.parse(text));
    } catch {
      parsed = { success: false };
    }
    if (!parsed.success) {
      throw new ModelChoiceStoreError('The model choice history is unreadable; clear it in Settings to start again', 500);
    }
    return parsed.data;
  };

  const retained = (events) => {
    const cutoff = now() - MODEL_CHOICE_RETENTION_MS;
    return events.filter((event) => event.at >= cutoff).slice(-MAX_MODEL_CHOICE_EVENTS);
  };

  const retainedDecisions = (decisions) => decisions.slice(-MAX_MODEL_CHOICE_DECISIONS);

  const write = async (data) => {
    await fs.mkdir(dataDir, { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tempPath, JSON.stringify(data), 'utf8');
    await renameWithRetry(fs.rename, tempPath, filePath);
  };

  /** Appends one validated choice. Returns the stored event. */
  const record = (input) => serialized(async () => {
    const parsed = modelChoiceInputSchema.safeParse(input);
    if (!parsed.success) throw new ModelChoiceStoreError('Invalid model choice', 400);
    const data = await read();
    const event = { ...parsed.data, at: now() };
    await write({ ...data, events: retained([...data.events, event]), decisions: retainedDecisions(data.decisions) });
    return event;
  });

  /** Events inside the retention window, oldest first, and every decision. */
  const snapshot = () => serialized(async () => {
    const data = await read();
    return { events: retained(data.events), decisions: retainedDecisions(data.decisions) };
  });

  const decide = (id, decision) => serialized(async () => {
    const data = await read();
    const decisions = [...data.decisions.filter((entry) => entry.id !== id), { id, decision, at: now() }];
    await write({ ...data, events: retained(data.events), decisions: retainedDecisions(decisions) });
  });

  /** Removes the file: every event and every decision. */
  const clear = () => serialized(async () => {
    await fs.rm(filePath, { force: true });
  });

  return { record, snapshot, decide, clear, filePath };
};
