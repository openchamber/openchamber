/**
 * Reproduction test for issue #2129: Stop button not available on Android mobile.
 *
 * This test performs static analysis on ChatInput.tsx to verify that the stop
 * button (ComposerActionButtons with canAbort=true) is missing from the
 * collapsed mobile composer pill state.
 *
 * Root cause: The mobile collapsed composer pill (~line 4890-4971 in ChatInput.tsx)
 * renders only:
 *   - MobileSessionPanelTrigger
 *   - ComposerAttachmentControls
 *   - A tap-to-expand placeholder button
 *   - Mic button
 *   - New session button
 * But does NOT render ComposerActionButtons (which contains the stop button).
 *
 * The stop button only exists in the expanded composer (~lines 5276-5342 for
 * mobile expanded, and ~lines 5344-5399 for desktop). When the user sends a
 * message on Android mobile and the keyboard dismisses, the composer collapses
 * to the pill after ~250ms (line 4278). If the assistant is still generating,
 * there is no stop button visible — the user must tap to re-expand the composer
 * first. There is no auto-expand logic triggered by sessionPhase changes.
 *
 * Lines referenced above are in ChatInput.tsx as of the current commit.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHAT_INPUT_PATH = join(
  __dirname,
  "components/chat/ChatInput.tsx",
);

const source = readFileSync(CHAT_INPUT_PATH, "utf-8");
const lines = source.split("\n");

describe("Stop button on mobile (issue #2129)", () => {
  test("collapsed mobile composer does NOT contain ComposerActionButtons", () => {
    // The collapsed mobile composer spans from line 4890 (the opening
    // `{isMobile && !mobileComposerExpanded ? (`) to line 4972
    // (`) : (`). Extract these lines.
    const collapsedStartIdx = lines.findIndex((l) =>
      l.includes("isMobile && !mobileComposerExpanded ?")
    );
    expect(collapsedStartIdx).not.toBe(-1);

    const collapsedEndIdx = lines.findIndex((l, i) =>
      i > collapsedStartIdx && l.trim().startsWith(") : (")
    );
    expect(collapsedEndIdx).not.toBe(-1);

    const collapsedBlock = lines
      .slice(collapsedStartIdx, collapsedEndIdx + 1)
      .join("\n");

    // Verify collapsed block does NOT contain ComposerActionButtons
    expect(collapsedBlock).not.toContain("ComposerActionButtons");
    expect(collapsedBlock).not.toContain("canAbort");
    expect(collapsedBlock).not.toContain("stopGeneratingAria");
    expect(collapsedBlock).not.toContain("StopIcon");

    // Verify the collapsed block contains the pill's actual components
    expect(collapsedBlock).toContain("MobileSessionPanelTrigger");
    expect(collapsedBlock).toContain("ComposerAttachmentControls");
    expect(collapsedBlock).toContain("expandMobileComposer");
    expect(collapsedBlock).toContain('name="mic"');
    // But NO queue button (visible in expanded when canAbort and hasContent)
    expect(collapsedBlock).not.toContain('name="send-plane-2"');
  });

  test("expanded mobile composer footer does contain ComposerActionButtons", () => {
    // The expanded mobile footer starts at `{isMobile ? (` around line 5276
    const footerStartIdx = lines.findIndex((l, i) =>
      i > 5200 && l.trim().startsWith("{isMobile ? (")
    );
    expect(footerStartIdx).not.toBe(-1);

    // Find the matching closing pattern
    const footerEndIdx = lines.findIndex((l, i) =>
      i > footerStartIdx && l.trim().startsWith(") : (")
    );
    expect(footerEndIdx).not.toBe(-1);

    const expandedMobileFooter = lines
      .slice(footerStartIdx, footerEndIdx + 1)
      .join("\n");

    // Verify expanded footer contains ComposerActionButtons with canAbort
    expect(expandedMobileFooter).toContain("ComposerActionButtons");
    expect(expandedMobileFooter).toContain("canAbort={canAbort}");
    // stopGeneratingAria is defined inside ComposerActionButtons component,
    // not at the usage site — verify the stop icon class prop is passed
    expect(expandedMobileFooter).toContain("stopIconSizeClass");
  });

  test("canAbort is computed as sessionPhase !== 'idle'", () => {
    const ok =
      lines[1747]?.includes('const canAbort = sessionPhase !== "idle"') ||
      lines[1747]?.includes("const canAbort = sessionPhase !== 'idle'");
    expect(ok).toBe(true);
  });

  test("StopIcon appears inside ComposerActionButtons component", () => {
    const stopIconLines = lines.filter((l) => l.includes("<StopIcon"));
    // StopIcon is defined inside the ComposerActionButtons component at ~line 857
    expect(stopIconLines.length).toBeGreaterThanOrEqual(1);
  });

  test("mobile composer auto-collapses after blur, no auto-expand on generation", () => {
    // The auto-collapse timer: find where setMobileComposerExpanded(false)
    // appears within ~10 lines of a 250ms setTimeout
    const collapseBlock = lines.findIndex((l, i) =>
      l.includes("setMobileComposerExpanded(false)") &&
      lines.slice(Math.max(0, i - 5), i + 5).some((sl) => sl.includes("250"))
    );
    expect(collapseBlock).not.toBe(-1);

    // There should be no reference to auto-expanding the composer based on
    // generation state (canAbort, sessionPhase, isWorking, etc.)
    const expandOnSessionActive = lines.filter((l) =>
      (l.includes("mobileComposerExpanded") || l.includes("expandMobileComposer")) &&
      (l.includes("sessionPhase") || l.includes("canAbort") || l.includes("isWorking"))
    );
    expect(expandOnSessionActive.length).toBe(0);
  });
});
