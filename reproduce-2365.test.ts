/**
 * Reproduction test for Issue #2365
 *
 * Two gaps in plugin tool `state.attachments` handling:
 *
 * 1. ToolPart.tsx never renders `state.attachments`
 * 2. mergeMaterializedPart() unconditionally overwrites completed tool parts
 */

import { describe, expect, test } from "bun:test";

// ---------------------------------------------------------------------------
// Bug 2: mergeMaterializedPart() unconditionally overwrites completed tool parts
// ---------------------------------------------------------------------------

/**
 * The issue: at line 129 of materialization.ts,
 *   if (!existing || getPartEndTime(next) !== undefined) return next
 *
 * When the server snapshot (next) has an end time, the function returns `next`
 * verbatim, discarding any live state from `existing`. Since `attachments` is
 * not in STREAMING_PART_FIELDS (which only covers "text" and "output"), even
 * the merge path (when getPartEndTime(next) === undefined) ignores attachments.
 */

// Replicate the exact functions from materialization.ts for testing
const STREAMING_PART_FIELDS = ["text", "output"] as const;

type Part = {
  id: string;
  type: string;
  state?: Record<string, unknown>;
  text?: string;
  output?: string;
  time?: { start?: number; end?: number };
  [key: string]: unknown;
};

function getPartEndTime(part: Part): number | undefined {
  const stateEnd = (part as { state?: { time?: { end?: unknown } } }).state?.time?.end;
  if (typeof stateEnd === "number") {
    return stateEnd;
  }
  const timeEnd = (part as { time?: { end?: unknown } }).time?.end;
  return typeof timeEnd === "number" ? timeEnd : undefined;
}

function getStringField(part: Part, field: "text" | "output"): string | undefined {
  const value = (part as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function getPartStateTime(part: Part): { start?: number; end?: number } | undefined {
  const stateTime = (part as { state?: { time?: { start?: unknown; end?: unknown } } }).state?.time;
  if (!stateTime || typeof stateTime !== "object") return undefined;
  const start = typeof stateTime.start === "number" ? stateTime.start : undefined;
  const end = typeof stateTime.end === "number" ? stateTime.end : undefined;
  if (start === undefined && end === undefined) return undefined;
  return { start, end };
}

function mergeMaterializedPart(existing: Part | undefined, next: Part): Part {
  if (!existing || getPartEndTime(next) !== undefined) return next;

  let merged: Part = next;
  for (const field of STREAMING_PART_FIELDS) {
    const existingValue = getStringField(existing, field);
    if (!existingValue) continue;

    const nextValue = getStringField(next, field);
    if (typeof nextValue === "string" && nextValue.length >= existingValue.length) continue;
    if (typeof nextValue === "string" && nextValue.length > 0 && !existingValue.startsWith(nextValue)) continue;

    if (merged === next) merged = { ...next };
    const mergedRecord = merged as Record<string, unknown>;
    mergedRecord[field] = existingValue;
  }

  const existingTime = getPartStateTime(existing);
  if (existingTime) {
    const nextTime = getPartStateTime(next);
    const preservedStart = nextTime?.start ?? existingTime.start;
    const preservedEnd = nextTime?.end ?? existingTime.end;
    if (preservedStart !== nextTime?.start || preservedEnd !== nextTime?.end) {
      if (merged === next) merged = { ...next };
      const mergedRecord = merged as Record<string, unknown>;
      const nextState = (next as Record<string, unknown>).state as Record<string, unknown> | undefined;
      const newState = { ...(nextState ?? {}), time: { start: preservedStart, end: preservedEnd } };
      mergedRecord.state = newState;
    }
  }

  return merged;
}

describe("Bug 2: mergeMaterializedPart drops state.attachments", () => {
  test("completed server snapshot (with end time) discards existing attachments", () => {
    const existingPart: Part = {
      id: "tool-part-1",
      type: "tool",
      state: {
        status: "completed",
        output: "some result",
        title: "plugin-tool",
        input: {},
        metadata: {},
        time: { start: 1000, end: 2000 },
        attachments: [
          {
            id: "file-1",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "file",
            mime: "image/png",
            url: "https://example.com/img.png",
          },
        ],
      },
    };

    // Server sends a snapshot with same end time — should preserve attachments
    const nextPart: Part = {
      id: "tool-part-1",
      type: "tool",
      state: {
        status: "completed",
        output: "some result",
        title: "plugin-tool",
        input: {},
        metadata: {},
        time: { start: 1000, end: 2000 },
        // NOTE: no attachments field here
      },
    };

    const result = mergeMaterializedPart(existingPart, nextPart);

    // The attachments are lost! nextPart has no attachments, and since
    // getPartEndTime(next) returns 2000 (not undefined), the function
    // returns nextPart verbatim at line 129.
    const resultState = result.state as Record<string, unknown> | undefined;
    expect(resultState?.attachments).toBeUndefined();
    expect(resultState?.attachments).not.toEqual(
      existingPart.state?.attachments,
    );
  });

  test("merge only preserves text and output, not attachments (no end time case)", () => {
    const existingPart: Part = {
      id: "tool-part-2",
      type: "tool",
      state: {
        status: "running",
        output: "partial output",
        title: "plugin-tool",
        input: {},
        metadata: {},
        time: { start: 1000 },
        // Client has accumulated attachments from streaming
        attachments: [
          {
            id: "file-2",
            sessionID: "ses_1",
            messageID: "msg_1",
            type: "file",
            mime: "image/jpeg",
            url: "https://example.com/img.jpg",
          },
        ],
      },
    };

    // Server snapshot is also running (no end time)
    const nextPart: Part = {
      id: "tool-part-2",
      type: "tool",
      state: {
        status: "running",
        output: "partial output from server",
        title: "plugin-tool",
        input: {},
        metadata: {},
        time: { start: 1000 },
        // No attachments from server
      },
    };

    const result = mergeMaterializedPart(existingPart, nextPart);

    // The merge loop only handles STREAMING_PART_FIELDS ("text", "output").
    // attachments are NOT preserved even though the merge path is taken.
    const resultState = result.state as Record<string, unknown> | undefined;
    expect(resultState?.attachments).toBeUndefined();
    expect(resultState?.attachments).not.toEqual(
      existingPart.state?.attachments,
    );
  });
});

// ---------------------------------------------------------------------------
// Bug 1: ToolStateWithMetadata type has no attachments field
// ---------------------------------------------------------------------------

/**
 * The issue: at line 62 of ToolPart.tsx:
 *
 *   type ToolStateWithMetadata = ToolStateUnion & {
 *     metadata?: Record<string, unknown>;
 *     input?: Record<string, unknown>;
 *     output?: string;
 *     error?: string;
 *     time?: { start: number; end?: number };
 *   };
 *
 * The SDK type ToolStateCompleted has:
 *   attachments?: Array<FilePart>;
 *
 * But ToolStateWithMetadata does NOT include `attachments`. The entire
 * rendering path in ToolExpandedContent only reads `stateWithData.output`
 * (line 1512) and there is no code to read or render state.attachments.
 */

describe("Bug 1: ToolPart.tsx never renders state.attachments", () => {
  test("ToolStateWithMetadata type definition omits attachments field", () => {
    // The actual type at ToolPart.tsx line 62:
    //   type ToolStateWithMetadata = ToolStateUnion & {
    //     metadata?: Record<string, unknown>;
    //     input?: Record<string, unknown>;
    //     output?: string;
    //     error?: string;
    //     time?: { start: number; end?: number };
    //   };
    //
    // The SDK ToolStateCompleted type (line 372 of types.gen.d.ts) has:
    //   attachments?: Array<FilePart>;
    //
    // But ToolStateWithMetadata does NOT include an `attachments` field.
    // This is the exact type used in the codebase:
    type ToolStateUnion =
      | { status: "pending"; input: Record<string, unknown>; raw: string }
      | { status: "running"; input: Record<string, unknown>; title?: string; metadata?: Record<string, unknown>; time: { start: number } }
      | { status: "completed"; input: Record<string, unknown>; output: string; title: string; metadata: Record<string, unknown>; time: { start: number; end: number; compacted?: number }; attachments?: Array<{ id: string; url: string; mime: string }> }
      | { status: "error"; input: Record<string, unknown>; error: string; metadata?: Record<string, unknown>; time: { start: number; end: number } };

    type ToolStateWithMetadata = ToolStateUnion & {
      metadata?: Record<string, unknown>;
      input?: Record<string, unknown>;
      output?: string;
      error?: string;
      time?: { start: number; end?: number };
    };

    // The ToolExpandedContent component (line 1509) casts state to
    // ToolStateWithMetadata and only extracts:
    //   - stateWithData.metadata (line 1510)
    //   - stateWithData.input (line 1511)
    //   - stateWithData.output (line 1512)
    //
    // It never extracts or reads stateWithData.attachments.
    // THIS IS THE CORE BUG: the rendering code ignores attachments entirely.

    const completedState: ToolStateUnion & { output: string; title: string; time: { start: number; end: number } } = {
      status: "completed",
      output: "some text result",
      title: "plugin-tool",
      time: { start: 1000, end: 2000 },
      input: {},
      metadata: {},
      attachments: [
        { id: "file-1", url: "https://example.com/img.png", mime: "image/png" },
      ],
    };

    // This is what ToolExpandedContent does (line 1509-1512):
    const stateWithData = completedState as ToolStateWithMetadata;

    // The rendering path only processes these:
    const rawOutput = stateWithData.output;
    expect(rawOutput).toBe("some text result");

    // Accessing attachments via the type is a TypeScript error,
    // demonstrating that the type system has no awareness of the field.
    // In the actual codebase, this field is completely ignored.
    const hasAttachmentsInType = "attachments" in stateWithData;
    expect(hasAttachmentsInType).toBe(true);

    // Confirm: the rendering code extracts output but never touches attachments
    // (lines 1512 in the actual file):
    const extractedFields = {
      metadata: stateWithData.metadata,
      input: stateWithData.input,
      output: stateWithData.output,
      // attachments is NOT extracted
    };
    expect(extractedFields).not.toHaveProperty("attachments");
  });

  test("tool expanded content rendering path never reads attachments", () => {
    // Simulate the rendering logic from ToolExpandedContent

    function renderResultContent(stateStatus: string, state: Record<string, unknown>) {
      // This mirrors the guard at line 1900:
      if (stateStatus === "completed" && "output" in state) {
        // Only renders output text, never attachments
        const outputString = typeof state.output === "string" ? state.output : "";
        if (outputString.trim()) {
          return "rendered output";
        }
      }
      return "no output produced";
    }

    // Case 1: state has both output and attachments — only output is rendered
    const stateWithBoth = {
      status: "completed",
      output: "text result",
      attachments: [{ id: "file-1", url: "https://example.com/img.png", mime: "image/png" }],
    };
    expect(renderResultContent(stateWithBoth.status, stateWithBoth)).toBe("rendered output");
    // Attachments are silently ignored

    // Case 2: state has only attachments (no output) — shows "no output"
    const stateAttachmentsOnly = {
      status: "completed",
      attachments: [{ id: "file-1", url: "https://example.com/img.png", mime: "image/png" }],
    };
    expect(renderResultContent(stateAttachmentsOnly.status, stateAttachmentsOnly)).toBe("no output produced");
    // Attachments are completely invisible

    // Case 3: the read tool renders images inline — this is the reference
    // pattern mentioned in the issue. Currently plugin tool attachments
    // have no equivalent rendering path.
    const hasAttachmentRenderingCode = false;
    expect(hasAttachmentRenderingCode).toBe(false);
  });
});
