import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { A2uiSurface, type A2uiHost } from './A2uiSurface';
import { describeA2uiReplyAnswer, type A2uiAnswerData } from './answer';
import type { A2uiJson } from './protocol';

const CATEGORIES = ['Architecture', 'Data', 'Security', 'UX', 'Performance', 'Operations'] as const;

const THIRTY_QUESTIONS_DATA: A2uiJson[] = [
  {
    id: 'q01', category: 'Architecture', question: 'Primary API transport between web client and backend?', recommended: 'rest-sse',
    detail: 'Choosing the transport shapes caching, proxy compatibility, and reconnect complexity across web, desktop, and mobile.',
    options: [
      { label: 'REST + SSE', value: 'rest-sse', description: 'Standard HTTP endpoints with Server-Sent Events for live streams', detail: 'Works cleanly behind corporate HTTP/2 proxies and load balancers with simple EventSource reconnect.' },
      { label: 'WebSockets', value: 'ws', description: 'Single bidirectional persistent socket for commands and events', detail: 'Lower framing overhead for high-frequency messages, but requires custom heartbeat and proxy upgrade rules.' },
      { label: 'gRPC-Web', value: 'grpc-web', description: 'Typed protobuf RPCs over HTTP/2', detail: 'Strict schema evolution across languages, adds Envoy/proxy dependency and heavier browser tooling.' },
    ],
  },
  {
    id: 'q02', category: 'Architecture', question: 'Where should A2UI payloads be validated before rendering?', recommended: 'both',
    detail: 'Validation catches malformed LLM JSONL before it hits UI state.',
    options: [
      { label: 'Client only', value: 'client', description: 'Validate inside the React renderer and report notDrawn on failure' },
      { label: 'Server only', value: 'server', description: 'Reject invalid JSONL in the render tool before returning to chat' },
      { label: 'Client + optional server lint', value: 'both', description: 'Fast client validation with structured feedback back to the model' },
    ],
  },
  {
    id: 'q03', category: 'Architecture', question: 'How should large multi-question surfaces handle session reload?', recommended: 'session-storage',
    detail: 'Answering 25 of 30 questions and refreshing the page should not discard progress.',
    options: [
      { label: 'sessionStorage draft', value: 'session-storage', description: 'Keep unsent data-model edits per session/message in browser sessionStorage' },
      { label: 'Server draft endpoint', value: 'server-draft', description: 'Sync partial answers to server for cross-device resume' },
      { label: 'In-memory only', value: 'memory', description: 'Reset answers on page reload' },
    ],
  },
  {
    id: 'q04', category: 'Architecture', question: 'Should A2UI coexist with legacy openui-lang blocks?', recommended: 'coexist',
    options: [
      { label: 'Keep openui-lang renderer for old history', value: 'coexist', description: 'Existing transcripts stay readable while new sessions use A2UI' },
      { label: 'Remove openui-lang completely', value: 'remove', description: 'Smaller bundle, older UI blocks show raw source' },
      { label: 'Auto-transpile openui-lang to A2UI', value: 'transpile', description: 'Maintain a compatibility translator layer' },
    ],
  },
  {
    id: 'q05', category: 'Architecture', question: 'How should the A2UI catalog reach the AI model?', recommended: 'on-demand-tool',
    detail: 'Keeping the system prompt static preserves LLM prefix prompt caching across turns.',
    options: [
      { label: 'On-demand tool (render.schema)', value: 'on-demand-tool', description: '~55-token static pointer; full catalog loads as a tool result only when needed' },
      { label: 'Always-on system prompt', value: 'always-on', description: 'Zero tool calls, but pays ~1,500 tokens on every turn even for plain text' },
      { label: 'Manual slash command only', value: 'manual', description: 'User explicitly enables A2UI mode per thread' },
    ],
  },
  {
    id: 'q06', category: 'Data', question: 'Maximum JSON answer payload size from a waiting render page?', recommended: '32kb',
    options: [
      { label: '16 KB (legacy limit)', value: '16kb', description: 'Tight cap; long notes on 30+ items could hit 413' },
      { label: '32 KB (recommended)', value: '32kb', description: 'Comfortably fits 50+ answers with per-item notes' },
      { label: '128 KB', value: '128kb', description: 'Allows large free-form tables or multi-paragraph form dumps' },
    ],
  },
  {
    id: 'q07', category: 'Data', question: 'Format of submitted answers sent back in inline reply blocks?', recommended: 'compact-markdown',
    options: [
      { label: 'Compact bullet list + notes', value: 'compact-markdown', description: 'Human-readable and token-efficient for the model' },
      { label: 'Raw JSON block', value: 'raw-json', description: 'Machine-strict JSON with full data model snapshot' },
      { label: 'Both summary + JSON attachment', value: 'both', description: 'Most verbose, duplicates tokens' },
    ],
  },
  {
    id: 'q08', category: 'Data', question: 'How should unanswered questions be represented on partial submit?', recommended: 'explicit-list',
    options: [
      { label: 'Explicit unanswered ID list', value: 'explicit-list', description: 'Model clearly sees which items were skipped' },
      { label: 'Omit silently', value: 'omit', description: 'Only include answered keys' },
      { label: 'Block partial submit completely', value: 'block', description: 'Require 100% completion before enabling submit' },
    ],
  },
  {
    id: 'q09', category: 'Data', question: 'Support both JSONL and single JSON array envelopes?', recommended: 'both',
    options: [
      { label: 'Both JSONL and JSON array', value: 'both', description: 'JSONL streams line-by-line; JSON array works smoothly in tool arguments' },
      { label: 'JSONL strictly', value: 'jsonl', description: 'One message per line only' },
      { label: 'JSON array strictly', value: 'array', description: 'Cannot stream incrementally until closing bracket' },
    ],
  },
  {
    id: 'q10', category: 'Data', question: 'How should JSON Pointer updates handle missing intermediate objects?', recommended: 'autocreate',
    options: [
      { label: 'Auto-create intermediate objects', value: 'autocreate', description: 'Writing /answers/q1 works even if /answers was omitted initially' },
      { label: 'Strict pre-declared schema', value: 'strict', description: 'Ignore writes unless parent exists in updateDataModel' },
      { label: 'Flat key map only', value: 'flat', description: 'Disallow nested pointers' },
    ],
  },
  {
    id: 'q11', category: 'Security', question: 'How should dynamic expressions (visibleWhen / formatString) evaluate?', recommended: 'allowlist',
    detail: 'Preventing arbitrary JS execution lets A2UI render natively in React without an iframe sandbox.',
    options: [
      { label: 'Allowlisted pure functions only', value: 'allowlist', description: 'equals, not, and, or, count, formatString — zero eval/Function' },
      { label: 'Sandboxed iframe evaluator', value: 'iframe', description: 'Heavyweight, adds postMessage latency' },
      { label: 'No expressions at all', value: 'none', description: 'Static layout only; loses conditional details' },
    ],
  },
  {
    id: 'q12', category: 'Security', question: 'How should Markdown inside A2UI Text/Details be rendered?', recommended: 'streamdown-safe',
    options: [
      { label: 'OpenChamber safe MarkdownContent', value: 'streamdown-safe', description: 'Reuses sanitized Streamdown pipeline (no raw HTML execution)' },
      { label: 'Plain text only', value: 'plain', description: 'No code formatting, bold, or links' },
      { label: 'Allow raw HTML inside Text', value: 'raw-html', description: 'Higher XSS risk' },
    ],
  },
  {
    id: 'q13', category: 'Security', question: 'Policy for unknown component types in an A2UI payload?', recommended: 'fail-loud',
    options: [
      { label: 'Report validation error + show source', value: 'fail-loud', description: 'Waiting pages send errors back to the agent for immediate retry' },
      { label: 'Silently drop unknown nodes', value: 'drop', description: 'Risk of hiding required form fields' },
      { label: 'Render generic JSON box', value: 'json-box', description: 'Leaks internal wire format to user' },
    ],
  },
  {
    id: 'q14', category: 'Security', question: 'External links inside A2UI descriptions?', recommended: 'host-handler',
    options: [
      { label: 'Route through OpenChamber link handler', value: 'host-handler', description: 'Consistent external URL confirmation and desktop/mobile handling' },
      { label: 'Strip all links', value: 'strip', description: 'Breaks documentation citations' },
      { label: 'Direct target=_blank', value: 'blank', description: 'Bypasses desktop shell URL safety' },
    ],
  },
  {
    id: 'q15', category: 'Security', question: 'Guard against double submission on slow networks?', recommended: 'idempotent',
    options: [
      { label: 'Synchronous lock + idempotent input ID', value: 'idempotent', description: 'Reuses stableReplyInputId so retries admit once' },
      { label: 'Disable button after click only', value: 'button-only', description: 'Vulnerable to network-timeout retries' },
      { label: 'Allow re-submission anytime', value: 'resubmit', description: 'Can trigger duplicate agent turns' },
    ],
  },
  {
    id: 'q16', category: 'UX', question: 'Default layout for 10+ questions in QuestionBatch?', recommended: 'paged-5',
    detail: 'Pagination keeps scroll height predictable inside a chat thread while letting users jump directly to any page.',
    options: [
      { label: 'Paginated (5 questions per page)', value: 'paged-5', description: 'Compact height with page indicators + toggle to Show all' },
      { label: 'Single-question wizard (1 per page)', value: 'wizard-1', description: 'Very focused, but requires 30 Next clicks' },
      { label: 'All 30 visible with auto-folding', value: 'all-fold', description: 'Fast scanning; answered rows collapse to 1 line' },
    ],
  },
  {
    id: 'q17', category: 'UX', question: 'Behavior when a user selects an option in compact list mode?', recommended: 'auto-fold',
    options: [
      { label: 'Auto-fold to 1-line summary + Change button', value: 'auto-fold', description: 'Keeps undecided questions visually prominent' },
      { label: 'Stay expanded', value: 'stay-open', description: 'Easier to compare all options after picking' },
      { label: 'Hide completely until filtered', value: 'hide', description: 'Can feel jarring if clicked accidentally' },
    ],
  },
  {
    id: 'q18', category: 'UX', question: 'Offer a one-click "Apply recommended" action?', recommended: 'remaining-only',
    options: [
      { label: 'Fill unanswered questions only', value: 'remaining-only', description: 'Respects every manual pick the user already made' },
      { label: 'Overwrite all answers with recommended', value: 'overwrite', description: 'Risk of erasing careful manual choices' },
      { label: 'Do not show bulk apply', value: 'none', description: 'Forces clicking all 30 items manually' },
    ],
  },
  {
    id: 'q19', category: 'UX', question: 'How should option-level detailed explanations appear?', recommended: 'inline-expand',
    options: [
      { label: 'Inline expandable "More" drawer', value: 'inline-expand', description: 'Zero layout jumps, works on desktop & mobile without extra turns' },
      { label: 'Hover tooltip only', value: 'tooltip', description: 'Hard to read long explanations or use on touchscreens' },
      { label: 'Separate modal per option', value: 'modal', description: 'Extra clicks to dismiss between comparisons' },
    ],
  },
  {
    id: 'q20', category: 'UX', question: 'Should each question support a per-item qualification note?', recommended: 'collapsible',
    options: [
      { label: 'Collapsible "Add note" trigger', value: 'collapsible', description: 'Zero visual clutter until needed; lets user add conditions' },
      { label: 'Always-visible text box on every card', value: 'always', description: 'Adds 30 empty textareas to the chat' },
      { label: 'Single global note only', value: 'global-only', description: 'Harder to reference specific question IDs' },
    ],
  },
  {
    id: 'q21', category: 'Performance', question: 'How should the A2UI renderer bundle be loaded?', recommended: 'lazy',
    options: [
      { label: 'Lazy onDemand chunk', value: 'lazy', description: 'Zero cost for sessions that never render an A2UI surface' },
      { label: 'Eager in main chat bundle', value: 'eager', description: 'Slightly faster first render, increases initial JS parse' },
      { label: 'Separate web worker', value: 'worker', description: 'Overkill for declarative component trees' },
    ],
  },
  {
    id: 'q22', category: 'Performance', question: 'Chart rendering technology for LineChart & BarChart?', recommended: 'native-svg',
    options: [
      { label: 'Lightweight native SVG + CSS vars', value: 'native-svg', description: 'Matches visualKit.ts theme live with zero charting library bloat' },
      { label: 'ECharts / Chart.js bundle', value: 'echarts', description: 'Rich chart types, adds 300+ KB gzipped' },
      { label: 'Server-side PNG rendering', value: 'png', description: 'Static, no hover tooltips or live dark/light theme sync' },
    ],
  },
  {
    id: 'q23', category: 'Performance', question: 'How should streaming A2UI JSONL handle incomplete lines?', recommended: 'ignore-tail',
    options: [
      { label: 'Render parsed lines, ignore partial tail', value: 'ignore-tail', description: 'Progressive display without error flashes mid-stream' },
      { label: 'Wait until closing fence before parsing', value: 'wait-end', description: 'Shows raw JSON until stream finishes' },
      { label: 'Show partial syntax error immediately', value: 'error-live', description: 'Noisy red flicker during generation' },
    ],
  },
  {
    id: 'q24', category: 'Performance', question: 'Token budget target for always-on session UI guidance?', recommended: 'under-100',
    options: [
      { label: 'Under 100 tokens (static pointer)', value: 'under-100', description: 'Replaces ~700-token openui-lang guidance; saves tokens every turn' },
      { label: 'Keep ~700 tokens always-on', value: '700', description: 'No savings vs current baseline' },
      { label: 'Inline full ~2,000-token A2UI spec', value: '2000', description: 'High context spend on non-UI coding turns' },
    ],
  },
  {
    id: 'q25', category: 'Performance', question: 'How should Activity folding treat inline A2UI blocks?', recommended: 'hoist',
    options: [
      { label: 'Hoist out of collapsed Activity', value: 'hoist', description: 'Matches openui-lang so visual summaries stay visible' },
      { label: 'Collapse inside Activity', value: 'collapse', description: 'Users miss charts emitted before a final tool step' },
      { label: 'Hoist charts only, fold forms', value: 'charts-only', description: 'Inconsistent visibility rules' },
    ],
  },
  {
    id: 'q26', category: 'Operations', question: 'Target runtimes for initial testing?', recommended: 'web-first',
    options: [
      { label: 'Web UI first (shared packages/ui)', value: 'web-first', description: 'Fast HMR iteration; Desktop & Mobile inherit packages/ui automatically' },
      { label: 'Electron desktop only', value: 'desktop-only', description: 'Slower rebuild loop' },
      { label: 'Separate mobile native renderer first', value: 'native-mobile', description: 'Duplicates component maintenance early' },
    ],
  },
  {
    id: 'q27', category: 'Operations', question: 'How should developers test A2UI without burning LLM credits?', recommended: 'demo-route',
    options: [
      { label: 'Built-in ?a2ui-demo=1 playground', value: 'demo-route', description: 'Instant local test harness with 30-question batch, charts & streaming sim' },
      { label: 'Unit tests only', value: 'unit-only', description: 'Cannot visually verify theme, layout, or ergonomics' },
      { label: 'Live model calls for every tweak', value: 'live-only', description: 'Slow and expensive iteration' },
    ],
  },
  {
    id: 'q28', category: 'Operations', question: 'Default schema topic when agent omits `topic` on render.schema?', recommended: 'all',
    options: [
      { label: '"all" (layout + forms + charts)', value: 'all', description: 'One tool call covers every component; agents can still narrow to "forms" or "charts"' },
      { label: '"forms" only', value: 'forms', description: 'Requires a second call if agent also wants a chart' },
      { label: 'Error if omitted', value: 'error', description: 'Causes unnecessary retry turns' },
    ],
  },
  {
    id: 'q29', category: 'Operations', question: 'Error recovery when a waiting A2UI render_page fails validation?', recommended: 'not-drawn',
    options: [
      { label: 'Auto-report notDrawn errors to agent', value: 'not-drawn', description: 'Agent sees exact line/component error and retries immediately' },
      { label: 'Leave waiting spinner forever', value: 'hang', description: 'User must manually decline or cancel' },
      { label: 'Fallback to raw JSON text only', value: 'raw', description: 'Agent never learns the UI failed to render' },
    ],
  },
  {
    id: 'q30', category: 'Operations', question: 'Next milestone after validating this web prototype?', recommended: 'live-agent-eval',
    options: [
      { label: 'Benchmark real agent sessions (token & UX)', value: 'live-agent-eval', description: 'Measure cache hit rate, output tokens, and first-try validity' },
      { label: 'Add custom chart types (Pie, Scatter, Heatmap)', value: 'more-charts', description: 'Expand visualization catalog first' },
      { label: 'Package as standalone @openchamber/a2ui', value: 'package-split', description: 'Extract into separate workspace package' },
    ],
  },
];

const THIRTY_QUESTIONS_JSONL = [
  JSON.stringify({ createSurface: { surfaceId: 'triage-30', title: '30-Question Architecture & Product Triage' } }),
  JSON.stringify({
    updateComponents: {
      surfaceId: 'triage-30',
      components: [
        { id: 'root', component: 'Column', children: ['intro', 'batch'] },
        {
          id: 'intro',
          component: 'Callout',
          tone: 'info',
          title: 'Single-turn 30-question triage (A2UI QuestionBatch)',
          text: 'Pick options, inspect expandable **Details** / **More** locally (0 extra LLM tokens), filter unanswered items, or click **Apply recommended**. Submitting sends one compact JSON payload back to the model.',
        },
        {
          id: 'batch',
          component: 'QuestionBatch',
          title: 'OpenChamber A2UI Design Decisions',
          description: `30 decisions across ${CATEGORIES.join(', ')} — 3 options each`,
          items: { path: '/questions' },
          answersPath: '/answers',
          notesPath: '/notes',
          pageSize: 5,
          submitAction: 'submit_triage',
          submitLabel: 'Send all selections to agent',
        },
      ],
    },
  }),
  JSON.stringify({
    updateDataModel: {
      surfaceId: 'triage-30',
      value: { questions: THIRTY_QUESTIONS_DATA, answers: {}, notes: {} },
    },
  }),
].join('\n');

const CHARTS_DASHBOARD_JSONL = [
  JSON.stringify({ createSurface: { surfaceId: 'viz-dashboard', title: 'Upload Retry Telemetry' } }),
  JSON.stringify({
    updateComponents: {
      surfaceId: 'viz-dashboard',
      components: [
        { id: 'root', component: 'Column', children: ['kpis', 'upload_chart', 'bar_chart', 'steps_card'] },
        { id: 'kpis', component: 'Row', children: ['kpi1', 'kpi2', 'kpi3'] },
        { id: 'kpi1', component: 'Stat', label: '1-GB Upload (unstable net)', value: '12 s', delta: '−40 s seit Mo', tone: 'success' },
        { id: 'kpi2', component: 'Stat', label: 'Always-on UI prompt cost', value: '~55 tok', delta: '−92% vs 700 tok', tone: 'success' },
        { id: 'kpi3', component: 'Stat', label: '503 / Timeout recovery', value: '99.4%', delta: '+11.2%', tone: 'info' },
        {
          id: 'upload_chart',
          component: 'LineChart',
          title: 'Upload-Dauer einer 1-GB-Datei bei instabiler Verbindung',
          labels: ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'],
          unit: 's',
          deltaMode: 'absolute',
          series: [{ name: 'Upload duration', values: [52, 49, 54, 47, 31, 18, 12] }],
        },
        {
          id: 'bar_chart',
          component: 'BarChart',
          title: 'Context token overhead per session (always-loaded guidance)',
          labels: ['Legacy openui-lang (always-on)', 'Always-on full A2UI spec', 'A2UI pointer + on-demand render.schema'],
          unit: 'tok',
          series: [{ name: 'Tokens', values: [700, 1850, 55] }],
        },
        {
          id: 'steps_card',
          component: 'Card',
          title: 'Prompt-cache-safe on-demand loading flow',
          children: ['flow_steps'],
        },
        {
          id: 'flow_steps',
          component: 'Steps',
          items: [
            { title: 'Session starts with tiny ~55-token static pointer', description: 'System prompt stays constant across turns so provider prefix caching stays hot.', status: 'done' },
            { title: 'Agent calls render.schema only when UI is needed', description: 'Catalog returns as a normal tool result appended at the end of history.', status: 'done' },
            { title: 'Agent emits ```a2ui or openchamber_render({ a2ui, awaitAnswer })', description: 'Client renders natively with OpenChamber theme and sends one structured answer back.', status: 'current' },
          ],
        },
      ],
    },
  }),
  JSON.stringify({ updateDataModel: { surfaceId: 'viz-dashboard', value: {} } }),
].join('\n');

const REACTIVE_FORM_JSONL = [
  JSON.stringify({ createSurface: { surfaceId: 'reactive-demo', title: 'Reactive Deployment Config' } }),
  JSON.stringify({
    updateComponents: {
      surfaceId: 'reactive-demo',
      components: [
        { id: 'root', component: 'Column', children: ['card_main', 'detail_local', 'detail_cloud', 'detail_hybrid', 'actions_row'] },
        {
          id: 'card_main',
          component: 'Card',
          title: 'Select deployment mode (watch reactive details update locally)',
          children: ['mode_picker', 'workers_slider', 'summary_kv'],
        },
        {
          id: 'mode_picker',
          component: 'ChoicePicker',
          label: 'Target environment',
          variant: 'mutuallyExclusive',
          value: { path: '/mode' },
          options: [
            { label: 'Local workstation', value: 'local', description: 'Runs on localhost with zero external egress', detail: 'Uses local OpenCode runtime and local filesystem directly.' },
            { label: 'Cloud VM', value: 'cloud', description: 'Remote host accessed over TLS / tunnel', detail: 'Requires auth passkey or token and reverse-proxy SSE buffering disabled.' },
            { label: 'Hybrid relay', value: 'hybrid', description: 'Local compute paired with remote web/mobile access', detail: 'Keeps code on your workstation while exposing a signed relay endpoint.' },
          ],
        },
        {
          id: 'workers_slider',
          component: 'Slider',
          label: 'Max concurrent subagents',
          min: 1,
          max: 12,
          step: 1,
          unit: 'agents',
          value: { path: '/workers' },
        },
        {
          id: 'summary_kv',
          component: 'KeyValue',
          items: [
            { label: 'Selected mode', value: '${/mode}' },
            { label: 'Concurrency limit', value: '${/workers} agents' },
          ],
        },
        {
          id: 'detail_local',
          component: 'Callout',
          tone: 'success',
          title: 'Local mode selected',
          text: 'Zero extra network setup required. OpenChamber binds to `localhost` and talks directly to your local server.',
          visibleWhen: { call: 'equals', args: { left: { path: '/mode' }, right: 'local' } },
        },
        {
          id: 'detail_cloud',
          component: 'Card',
          title: 'Cloud VM parameters (shown conditionally via visibleWhen)',
          children: ['cloud_host', 'cloud_tls'],
          visibleWhen: { call: 'equals', args: { left: { path: '/mode' }, right: 'cloud' } },
        },
        { id: 'cloud_host', component: 'TextField', label: 'Server hostname', placeholder: 'oc.example.com', value: { path: '/cloudHost' } },
        { id: 'cloud_tls', component: 'CheckBox', label: 'Require passkey authentication', value: { path: '/requirePasskey' } },
        {
          id: 'detail_hybrid',
          component: 'Callout',
          tone: 'info',
          title: 'Hybrid relay details',
          text: 'Your code stays on this machine. Mobile and remote browsers connect through an authenticated relay tunnel.',
          visibleWhen: { call: 'equals', args: { left: { path: '/mode' }, right: 'hybrid' } },
        },
        {
          id: 'actions_row',
          component: 'Row',
          children: ['modal_compare', 'btn_submit'],
        },
        {
          id: 'modal_compare',
          component: 'Modal',
          title: 'Deployment Trade-offs',
          entryPointChild: 'btn_compare',
          contentChild: 'compare_table',
        },
        { id: 'btn_compare', component: 'Button', label: 'Compare trade-offs (Modal)', variant: 'secondary', action: { functionCall: { call: 'openModal', args: { modalId: 'modal_compare' } } } },
        {
          id: 'compare_table',
          component: 'Table',
          columns: ['Mode', 'Latency', 'Data stays local', 'Remote mobile'],
          rows: [
            ['Local', '< 5 ms', 'Yes', 'LAN only'],
            ['Cloud VM', '20–60 ms', 'No', 'Yes'],
            ['Hybrid relay', '15–40 ms', 'Yes', 'Yes'],
          ],
        },
        {
          id: 'btn_submit',
          component: 'Button',
          label: 'Apply configuration',
          variant: 'primary',
          action: {
            event: {
              name: 'apply_deploy_config',
              context: {
                mode: { path: '/mode' },
                workers: { path: '/workers' },
                cloudHost: { path: '/cloudHost' },
                requirePasskey: { path: '/requirePasskey' },
              },
            },
          },
        },
      ],
    },
  }),
  JSON.stringify({
    updateDataModel: {
      surfaceId: 'reactive-demo',
      value: { mode: 'local', workers: 4, cloudHost: '', requirePasskey: true },
    },
  }),
].join('\n');

const COGMAP_DEMO_JSONL = [
  JSON.stringify({ createSurface: { surfaceId: 'cogmap-demo', title: 'Supply Chain Resilience (Eden & Ackermann)' } }),
  JSON.stringify({
    updateComponents: {
      surfaceId: 'cogmap-demo',
      components: [
        { id: 'root', component: 'Column', children: ['intro', 'map'] },
        {
          id: 'intro',
          component: 'Callout',
          tone: 'info',
          title: 'Means-Ends Cognitive Map with Contrast Poles & Feedback Loops',
          text: 'Click any concept to trace its **causal cone** (causes & consequences), filter **Heads / Tails / Hubs / Loops**, or click **Why? / How? / Challenge / Loops** to inspect the minimal laddering intent sent back to the agent.',
        },
        {
          id: 'map',
          component: 'CognitiveMap',
          title: 'Supply Chain Resilience Strategy',
          focus: 'n4',
          height: 440,
          dsl: [
            '# map:demo rev:3 pacing:collab "Supply Chain Resilience Strategy"',
            'n1: Protect customer SLA ... tolerate stockouts & churn [goal] // Maintain >= 99.2% on-time fulfillment during tier-1 disruptions.',
            'n2: Preserve working capital ... tie up cash in idle inventory [goal]',
            'n3: Shorter disruption recovery time ... weeks of halted assembly [factor]',
            'n4: Multi-region dual sourcing ... single-factory lock-in [factor] // Primary leverage hub connecting procurement options to resilience goals.',
            'n5: Qualification overhead & unit cost ... cheap single-vendor volume discount [constraint]',
            'n6: Pre-qualify regional backup suppliers ... scramble on spot market [option]',
            'n7: Buffer safety stock for 90-day lead parts ... strict just-in-time [option]',
            'n8: Lead-time telemetry flags delays 14d early ... discover outages at dock [assumption]',
            'n6 +> n4 | n8 +> n3 | n4 +> n3 | n4 +> n5',
            'n7 +> n3 | n7 -> n2 | n5 -> n2 | n3 +> n1',
            'n1 +> n4 (revenue funds dual-sourcing) | n5 ?> n6 (audit bottleneck)',
          ].join('\n'),
        },
      ],
    },
  }),
  JSON.stringify({ updateDataModel: { surfaceId: 'cogmap-demo', value: {} } }),
].join('\n');

type DemoTab = 'batch30' | 'cogmap' | 'charts' | 'reactive' | 'playground';

export function A2uiDemoPage() {
  const { currentTheme, setThemeMode, themeMode } = useThemeSystem();
  const [tab, setTab] = React.useState<DemoTab>('batch30');
  const [submissions, setSubmissions] = React.useState<Array<{ at: string; summary: string; answer: A2uiAnswerData; syntheticText: string }>>([]);
  const [resetKey, setResetKey] = React.useState(0);

  // Playground state + streaming simulation
  const [playgroundSource, setPlaygroundSource] = React.useState(CHARTS_DASHBOARD_JSONL);
  const [streamedText, setStreamedText] = React.useState(CHARTS_DASHBOARD_JSONL);
  const [isStreamingSim, setIsStreamingSim] = React.useState(false);

  const runStreamingSim = React.useCallback(() => {
    const lines = playgroundSource.split('\n');
    setIsStreamingSim(true);
    setStreamedText('');
    let cursor = 0;
    const step = () => {
      cursor += 1;
      if (cursor >= lines.length) {
        setStreamedText(playgroundSource);
        setIsStreamingSim(false);
        return;
      }
      // Show complete lines plus a partial prefix of the next line to prove streaming resilience.
      const nextLine = lines[cursor] ?? '';
      const partial = nextLine.slice(0, Math.min(24, nextLine.length));
      setStreamedText([...lines.slice(0, cursor), partial].join('\n'));
      window.setTimeout(step, 450);
    };
    window.setTimeout(step, 200);
  }, [playgroundSource]);

  const demoHost = React.useMemo<A2uiHost>(
    () => ({
      kind: 'demo',
      answered: null,
      submit: async (answer, summary) => {
        setSubmissions((prev) => [
          {
            at: new Date().toLocaleTimeString(),
            summary,
            answer,
            syntheticText: describeA2uiReplyAnswer(answer),
          },
          ...prev,
        ]);
      },
    }),
    [],
  );

  const toggleAppearance = () => {
    setThemeMode(currentTheme.metadata.variant === 'dark' ? 'light' : 'dark');
  };

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto flex max-w-4xl flex-col gap-5 px-4 py-6 sm:px-6">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">OpenChamber A2UI Prototype</span>
              <span className="oc-badge" data-tone="info">Option B · Native React</span>
            </div>
            <p className="typography-meta text-muted-foreground">
              Interactive web harness for native A2UI surfaces, 30-question batch triage, inline charts, and cache-safe on-demand schema loading.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={toggleAppearance}>
              <Icon name={currentTheme.metadata.variant === 'dark' ? 'sun' : 'moon'} className="size-3.5" />
              {currentTheme.metadata.variant === 'dark' ? 'Light theme' : 'Dark theme'} ({themeMode})
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setResetKey((k) => k + 1);
                setSubmissions([]);
              }}
            >
              Reset state
            </Button>
          </div>
        </header>

        <nav className="flex flex-wrap items-center gap-1.5" aria-label="Demo scenarios">
          {(
            [
              ['batch30', '1. 30-Question Batch (3 options each)'],
              ['cogmap', '2. Cognitive Map (Means-Ends)'],
              ['charts', '3. Charts & Telemetry'],
              ['reactive', '4. Reactive Form & Modal'],
              ['playground', '5. Live JSONL + Streaming'],
            ] as const
          ).map(([id, label]) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={tab === id ? 'default' : 'outline'}
              onClick={() => setTab(id)}
            >
              {label}
            </Button>
          ))}
        </nav>

        <main className="rounded-xl border border-border bg-background p-4 shadow-xs">
          {tab === 'batch30' && (
            <A2uiSurface key={`batch30-${resetKey}`} source={THIRTY_QUESTIONS_JSONL} complete host={demoHost} showPageNote />
          )}
          {tab === 'cogmap' && (
            <A2uiSurface key={`cogmap-${resetKey}`} source={COGMAP_DEMO_JSONL} complete host={demoHost} />
          )}
          {tab === 'charts' && (
            <A2uiSurface key={`charts-${resetKey}`} source={CHARTS_DASHBOARD_JSONL} complete host={demoHost} />
          )}
          {tab === 'reactive' && (
            <A2uiSurface key={`reactive-${resetKey}`} source={REACTIVE_FORM_JSONL} complete host={demoHost} showPageNote />
          )}
          {tab === 'playground' && (
            <div className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="typography-meta font-medium">A2UI JSONL Source</span>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setPlaygroundSource(REACTIVE_FORM_JSONL);
                      setStreamedText(REACTIVE_FORM_JSONL);
                    }}
                  >
                    Load reactive example
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      setPlaygroundSource(CHARTS_DASHBOARD_JSONL);
                      setStreamedText(CHARTS_DASHBOARD_JSONL);
                    }}
                  >
                    Load charts example
                  </Button>
                  <Button type="button" size="xs" disabled={isStreamingSim} onClick={runStreamingSim}>
                    {isStreamingSim ? 'Streaming…' : 'Simulate streaming'}
                  </Button>
                </div>
              </div>
              <textarea
                value={playgroundSource}
                onChange={(event) => {
                  setPlaygroundSource(event.target.value);
                  setStreamedText(event.target.value);
                }}
                rows={9}
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs text-foreground"
              />
              <div className="rounded-lg border border-dashed border-border p-3">
                <div className="mb-1 typography-micro text-muted-foreground">
                  Live rendered surface {isStreamingSim ? '(streaming partial JSONL…)' : '(settled)'}
                </div>
                <A2uiSurface
                  key={`play-${resetKey}`}
                  source={streamedText}
                  complete={!isStreamingSim}
                  host={demoHost}
                />
              </div>
            </div>
          )}
        </main>

        {submissions.length > 0 && (
          <section className="flex flex-col gap-3 rounded-xl border border-border bg-muted/20 p-4">
            <div className="flex items-center justify-between">
              <h2 className="typography-meta font-semibold">
                Agent Payload Inspector ({submissions.length} submission{submissions.length === 1 ? '' : 's'})
              </h2>
              <span className="typography-micro text-muted-foreground">
                Exact single-turn payload delivered via answerRenderedPage / resumeWithSyntheticInput
              </span>
            </div>
            {submissions.map((entry, idx) => (
              <div key={idx} className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 typography-meta">
                  <span className="font-medium text-[var(--status-success)]">
                    [{entry.at}] action: {entry.answer.action} ({entry.answer.surfaceId})
                  </span>
                  <span className="typography-micro tabular-nums text-muted-foreground">
                    {JSON.stringify(entry.answer).length.toLocaleString()} bytes JSON
                  </span>
                </div>
                <div className="typography-micro text-muted-foreground">Summary: {entry.summary}</div>
                <details>
                  <summary className="cursor-pointer typography-micro font-medium text-foreground/80">
                    Inspect structured JSON payload & synthetic reply text
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded bg-foreground/5 p-2 font-mono text-xs">
                    {JSON.stringify(entry.answer, null, 2)}
                  </pre>
                  <pre className="mt-2 max-h-48 overflow-auto rounded bg-foreground/5 p-2 font-mono text-xs">
                    {entry.syntheticText}
                  </pre>
                </details>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
