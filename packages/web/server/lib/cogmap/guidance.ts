import type { CogMapPacing } from './types.js';

/**
 * Compact static pointer (~85 tokens) kept in `openchamber.guidance` so ordinary
 * sessions keep prefix prompt caches warm while still knowing `openchamber_cogmap`
 * exists for causal problem structuring.
 */
export const COGMAP_POINTER_GUIDANCE =
  'Cognitive Maps (openchamber_cogmap): For complex causal scenarios, trade-offs, strategy, or means-ends problem structuring, build an interactive Eden & Ackermann Cognitive Map with openchamber_cogmap (cogmap.mutate for surgical deltas, cogmap.read for compact DSL, cogmap.analyze for heads/tails/loops, cogmap.open for the side panel). '
  + 'Never redraw the full graph in prose or Mermaid—embed a compact A2UI CognitiveMap linked by mapId (~25 tokens) or update the live panel.';

/**
 * Mode-level guidance written to the `openchamber.cogmap` instruction entry ONLY
 * while Cognitive Map Mode is active for a session. Kept static per pacing setting
 * so LLM prompt caches stay intact across turns.
 */
export function buildCogMapModeGuidance(pacing: CogMapPacing): string {
  const pacingRule = pacing === 'auto'
    ? 'Pacing: AUTONOMOUS. Build a cohesive 8–16 node Cognitive Map in 1–2 cogmap.mutate calls, run cogmap.analyze to surface heads, leverage tails, hubs, and feedback loops, then open the map (cogmap.open) or embed a compact A2UI CognitiveMap (`{"id":"cm","component":"CognitiveMap","mapId":"<id>"}`) paired with 2–4 Stat/Callout takeaways. Keep chat prose concise (2–4 sentences).'
    : 'Pacing: CO-CREATE. Work step by step WITH the user: add only 3–5 proposed nodes per turn via cogmap.mutate so the user can edit, accept/reject, or steer the graph. Keep chat replies to 1–2 crisp sentences explaining what you added and inviting the user to ladder up ("Why?"), ladder down ("How?"), or edit directly on the canvas.';

  return [
    '# Cognitive Map Mode (Eden & Ackermann Means-Ends Causal Mapping)',
    pacingRule,
    'Modeling rules:',
    '- Action-oriented phrases: each node label is a short state or action phrase (4–8 words), never a bare noun.',
    '- Contrast poles: include `pole` (rendered as `label ... pole`) whenever a concept is ambiguous or represents a strategic tension (e.g. label: "High safety stock", pole: "lean inventory").',
    '- Roles: `goal` (Head / desired end, top), `option` (Action / lever, bottom), `factor` (intermediate cause/state), `constraint` (risk/limit), `assumption` (uncertain belief).',
    '- Strict causality: edges (`+` promotes/leads to, `-` inhibits/reduces, `?` uncertain) mean causality or influence—never taxonomy ("is a") or membership.',
    '- Notes for zero-token exploration: put deeper rationale, caveats, or data facts inside each node\'s `note` field so the user can inspect details locally without extra turns.',
    '- Token efficiency: NEVER re-emit the whole graph. Use `cogmap.mutate` with only incremental deltas. Never specify X/Y coordinates (layout is deterministic bottom-to-top).',
    '- Bidirectional laddering: when you receive a laddering intent (`ladder_up` = Why/Ends, `ladder_down` = How/Causes, `challenge` = Stress-test/Contrast, `loops` = Feedback loops, `explain` = Drill into node) or `<cogmap-user-delta>`, integrate the user\'s canvas edits and add 2–4 targeted nodes/edges via `cogmap.mutate`.',
  ].join('\n');
}
