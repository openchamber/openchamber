**Source visual truth**

- `/var/folders/5l/tlc329r51b17td86h3klclbw0000gn/T/codex-clipboard-b72085c8-56a0-4f95-a4a1-cd00fb4db792.png`

**Implementation evidence**

- Screenshot: `/tmp/openchamber-session-shortcut-hints.png`
- Viewport: 1280 × 720, dark theme
- State: session sidebar open; the delayed primary-modifier hint state was forced on only for the visual capture, then reverted. The production 500ms delay/release behavior is covered by the controller tests.
- Primary interactions tested: Command+2 selected the second Recent row; Command+3 selected the third numbered Project row and preserved that row's Project Focus identity.
- Console checked: no new runtime exception from numbered navigation or hint rendering. Existing unrelated React key and Base UI native-button warnings remain outside this change.

**Full-view comparison evidence**

- The reference and implementation were opened together at their native sizes. Both place compact rounded `⌘N` pills at the trailing edge of session rows, keep project/section headers unnumbered, preserve active-row contrast, and continue numbering across project boundaries.

**Focused region comparison evidence**

- Sidebar session rows were inspected directly. The implementation matches the reference interaction hierarchy: title truncation owns the flexible space, the shortcut pill remains legible at the right edge, active-row selection stays behind both title and pill, and rows 1–9 form one global visual sequence.

**Findings**

- No actionable P0/P1/P2 mismatch.
- Typography: uses the existing sidebar label and metadata scale; the hint remains secondary to the session title.
- Spacing/layout: pills are right-aligned without changing row height or project indentation.
- Colors/tokens: all hint surfaces and text use existing surface/muted theme tokens.
- Image quality/assets: no raster or custom icon asset is required for this native keyboard affordance.
- Copy/content: shortcut help now says “Switch Session”; all supported locale dictionaries were updated.

**Open Questions**

- None.

**Implementation Checklist**

- [x] Number visible session rows rather than containers.
- [x] Include Recent and expanded Project rows in one sequence.
- [x] Reveal hints after 500ms and clear them on release/blur/page hide.
- [x] Route Command+1…9 to the exact numbered Focus row.
- [x] Verify normal hidden state, numbered activation, visual hint state, and console output.

**Comparison history**

- Initial comparison: no P0/P1/P2 issues found; no visual correction loop was required.

**Follow-up Polish**

- None required for the requested state.

final result: passed
