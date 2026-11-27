export type A2uiSchemaTopic = 'all' | 'forms' | 'charts' | 'cogmap';

/**
 * Compact static pointer loaded into `openchamber.guidance` when rendering is enabled.
 * Replaces the previous ~1,100-token always-on UI_BLOCKS_GUIDANCE so ordinary turns
 * stay lean and the full A2UI catalog loads on demand via `render.schema` as a normal
 * tool result without invalidating prompt caches.
 */
export const A2UI_POINTER_GUIDANCE =
  'A2UI visual UI (inline ```a2ui or openchamber_render a2ui): DO NOT write Markdown tables for numeric series/curves (hourly forecasts, metrics, trends) or long walls of text (>3 paragraphs) for multi-section explanations, step-by-step flows, or comparisons—call openchamber_render action "render.schema" (topic: "charts"|"forms"|"all") first and cluster with LineChart/BarChart, Steps, Tabs, Cards, Details, or Callout. '
  + 'For 4+ questions or choices needing details/notes, use QuestionBatch + awaitAnswer (keep 1–3 simple questions on question). '
  + 'Skip A2UI for short factual answers.';

const CORE_PROTOCOL = [
  '# A2UI Wire Format',
  '3 separate envelopes (each JSON object holds one top-level key: createSurface, updateComponents, or updateDataModel):',
  '1. {"createSurface":{"surfaceId":"s1","title":"Optional title"}}',
  '2. {"updateComponents":{"surfaceId":"s1","components":[{"id":"root","component":"Column","children":[...]},...]}}',
  '3. {"updateDataModel":{"surfaceId":"s1","value":{...}}}',
  '',
  'Delivery:',
  '- Blocking question/form (PREFERRED): call openchamber_render with action "render.page", passing a2ui as a native JSON array of envelopes [ {...}, {...}, {...} ] (or shorthand object { "surfaceId": "s1", "components": [...], "data": {...} }) — never hand-escape a huge JSONL string when calling the tool — plus title and awaitAnswer: true (or answerLater: true).',
  '- Inline in reply: wrap JSONL (one JSON object per line) or JSON array in a ```a2ui code fence. User submission arrives as your next turn.',
  '',
  'Data binding & reactivity (client-side, zero extra LLM turns):',
  '- Bind props to data model with {"path":"/foo/bar"} or template strings "${/foo/bar}".',
  '- Inside List templates (children: {"componentId":"tpl","path":"/items"}), relative paths like {"path":"title"} resolve per item.',
  '- Conditional visibility: "visibleWhen": {"call":"equals","args":{"left":{"path":"/mode"},"right":"custom"}} (supported calls: equals, notEquals, not, and, or, isEmpty, nonEmpty, count, countAnswered, gt, gte, lt, lte, formatString).',
  '- Local Button actions: action: {"functionCall":{"call":"openModal","args":{"modalId":"m1"}}} | closeModal | {"call":"setData","args":{"path":"/tab","value":"b"}}.',
  '- Agent Button submit: action: {"event":{"name":"submit","context":{"answers":{"path":"/answers"}}}}.',
].join('\n');

const LAYOUT_COMPONENTS = [
  '## Layout & Display Components',
  '- Column / Row: { id, component, children: string[] | { componentId, path } }',
  '- Card: { id, component:"Card", title?, child?: string, children?: string[] }',
  '- List: { id, component:"List", direction?: "vertical"|"horizontal", children: string[] | { componentId, path } }',
  '- Tabs: { id, component:"Tabs", tabs: [{ title, child?: string, children?: string[] }] }',
  '- Details: { id, component:"Details", title, defaultOpen?: boolean, child?: string, children?: string[] }',
  '- Modal: { id, component:"Modal", title, entryPointChild: string, contentChild: string }',
  '- Divider: { id, component:"Divider" }',
  '- Text: { id, component:"Text", text, variant?: "h1"|"h2"|"h3"|"body"|"caption" } (supports Markdown)',
  '- Badge: { id, component:"Badge", label, tone?: "neutral"|"info"|"success"|"warning"|"error" }',
  '- Callout: { id, component:"Callout", title?, text, tone? }',
  '- KeyValue: { id, component:"KeyValue", items: [{ label, value }] }',
  '- Table: { id, component:"Table", columns: string[], rows: (string|number)[][] }',
  '- Stat: { id, component:"Stat", label, value, delta?, tone? }',
  '- Progress: { id, component:"Progress", label, value, max? }',
  '- Steps: { id, component:"Steps", items: [{ title, description?, status?: "done"|"current"|"todo"|"blocked" }] }',
].join('\n');

const FORM_COMPONENTS = [
  '## Interactive Form & Questionnaire Components',
  '- QuestionBatch (BEST for 3-50+ questions with options & details):',
  '  { id, component:"QuestionBatch", title?, description?, items:{"path":"/questions"}, answersPath?:"/answers", notesPath?:"/notes", pageSize?:5, requireAll?:false, submitAction?:"submit", submitLabel?:"Submit selections" }',
  '  Each item in /questions: { id, question, category?, detail?, recommended?, multiple?:false, allowNote?:true, options: [{ label, value, description?, detail?, badge? }] }',
  '  Provides live progress bar, All/Unanswered/Answered filters, auto-folding or pagination, expandable local Details (0 extra tokens), per-question notes, "Apply recommended", and one compact JSON submit.',
  '- ChoicePicker: { id, component:"ChoicePicker", label?, variant?:"mutuallyExclusive"|"multipleSelection", value:{"path":"/pick"}, options:[{ label, value, description?, detail? }] }',
  '- TextField: { id, component:"TextField", label?, placeholder?, variant?:"shortText"|"longText"|"number", value:{"path":"/text"} }',
  '- CheckBox: { id, component:"CheckBox", label, value:{"path":"/flag"} }',
  '- Slider: { id, component:"Slider", label?, min, max, step?, unit?, value:{"path":"/num"} }',
  '- DateTimeInput: { id, component:"DateTimeInput", label?, enableTime?:false, value:{"path":"/date"} }',
  '- Button: { id, component:"Button", label, variant?:"primary"|"secondary"|"ghost"|"destructive", action:{ event:{ name, context } } | { functionCall:{ call, args } } }',
  '',
  '### Example: Multi-question batch',
  '{"createSurface":{"surfaceId":"q1","title":"API design choices"}}',
  '{"updateComponents":{"surfaceId":"q1","components":[{"id":"root","component":"Column","children":["batch"]},{"id":"batch","component":"QuestionBatch","title":"Architecture Decisions","items":{"path":"/questions"},"pageSize":5}]}}',
  '{"updateDataModel":{"surfaceId":"q1","value":{"questions":[{"id":"auth","question":"Auth strategy?","recommended":"jwt","detail":"Affects stateless scaling.","options":[{"label":"JWT","value":"jwt","description":"Stateless access tokens"},{"label":"Sessions","value":"sessions","description":"Server-stored cookies"},{"label":"API Keys","value":"keys","description":"Service-to-service only"}]}],"answers":{}}}}',
].join('\n');

const CHART_COMPONENTS = [
  '## Data Visualization Components',
  '- LineChart: { id, component:"LineChart", title?, labels: string[] | {"path":...}, series: [{ name, values: (number|null)[] }], unit?, deltaMode?: "absolute"|"percent" } (1 series draws as an area chart with headline + delta; multiple series draw interactive multi-line chart)',
  '- BarChart: { id, component:"BarChart", title?, labels: string[], series: [{ name, values: (number|null)[] }], unit?, whole?: boolean } (whole: true shows total and % share per bar)',
  '',
  '### Example: Area trend chart',
  '{"createSurface":{"surfaceId":"c1"}}',
  '{"updateComponents":{"surfaceId":"c1","components":[{"id":"root","component":"Column","children":["chart"]},{"id":"chart","component":"LineChart","title":"Upload duration (1 GB)","labels":["Mo","Di","Mi","Do","Fr","Sa","So"],"unit":"s","series":[{"name":"Duration","values":[52,49,54,47,31,18,12]}]}]}}',
  '{"updateDataModel":{"surfaceId":"c1","value":{}}}',
].join('\n');

const COGMAP_COMPONENTS = [
  '## Cognitive Map Component (Eden & Ackermann Causal Mapping)',
  '- CognitiveMap: { id, component:"CognitiveMap", title?, mapId?: string, focus?: string, height?: number, dsl?: string, nodes?: {"path":"/nodes"} | [...], edges?: {"path":"/edges"} | [...], pacing?: "auto"|"collab", interactive?: boolean }',
  '  - PREFERRED (ultra-low tokens, ~25 tokens): pass `mapId` referencing a map built via `openchamber_cogmap` (`cogmap.mutate`). The card binds live to the session store over SSE, supports zero-token pan/zoom/path-tracing/notes, one-click laddering ("Why?", "How?", "Challenge"), and "Open in Panel".',
  '  - Standalone snapshot: pass compact `dsl` string or `nodes`/`edges` in `updateDataModel` (nodes: `{ id, label, pole?, role: "goal"|"option"|"factor"|"constraint"|"assumption", note?, status?: "proposed"|"agreed" }`, edges: `{ from, to, sign: "+"|"-"|"?", label? }`).',
  '',
  '### Example: Live-linked Cognitive Map + Takeaways',
  '{"createSurface":{"surfaceId":"cm1"}}',
  '{"updateComponents":{"surfaceId":"cm1","components":[{"id":"root","component":"Column","children":["map","callout"]},{"id":"map","component":"CognitiveMap","mapId":"m1","focus":"n2","height":360},{"id":"callout","component":"Callout","title":"Key leverage point","text":"Improve POS demand forecast (n4) to raise service levels while lowering safety stock lockup.","tone":"info"}]}}',
  '{"updateDataModel":{"surfaceId":"cm1","value":{}}}',
].join('\n');

export function normalizeA2uiSchemaTopic(raw: unknown): A2uiSchemaTopic {
  if (raw === 'forms' || raw === 'charts' || raw === 'cogmap' || raw === 'all') return raw;
  return 'all';
}

export function buildA2uiSchemaReference(topic: A2uiSchemaTopic = 'all'): string {
  const sections = [CORE_PROTOCOL, '', LAYOUT_COMPONENTS];
  if (topic === 'all' || topic === 'forms') sections.push('', FORM_COMPONENTS);
  if (topic === 'all' || topic === 'charts') sections.push('', CHART_COMPONENTS);
  if (topic === 'all' || topic === 'cogmap') sections.push('', COGMAP_COMPONENTS);
  return sections.join('\n');
}
