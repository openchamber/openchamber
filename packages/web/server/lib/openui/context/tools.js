export const OPENUI_CONTEXT_GROUPS = Object.freeze([
  'data', 'interaction', 'html', 'advanced', 'examples',
]);

export const OPENCHAMBER_OPENUI_ACTION_DEFINITIONS = Object.freeze([
  { action: 'openui.read', title: 'Read OpenUI instructions', description: 'Read task and capability references; omit groups for usage rules and routes' },
  { action: 'openui.prompt', title: 'Ask with OpenUI', description: 'Collect required user input with one complete ui program; waits for the answer' },
]);

export const OPENCHAMBER_OPENUI_ACTIONS = Object.freeze(
  OPENCHAMBER_OPENUI_ACTION_DEFINITIONS.map(({ action }) => action),
);

export const OPENUI_TOOL = {
  name: 'openchamber_openui',
  description: 'Read OpenUI instructions and examples with openui.read. Use openui.prompt to collect input needed to continue; it waits for the user response. Deliver display-only or locally interactive UI in an inline openui-lang block.',
  definitions: OPENCHAMBER_OPENUI_ACTION_DEFINITIONS,
  parameters: {
    ui: { type: 'string', description: 'Required for openui.prompt: one complete OpenUI DSL program, at most 200000 characters. The prompt waits for the user response.' },
    groups: {
      type: 'array',
      items: { type: 'string', enum: OPENUI_CONTEXT_GROUPS },
      maxItems: OPENUI_CONTEXT_GROUPS.length,
      description: 'Omit or pass [] for usage rules and routes. Read matching task and capability groups; reuse loaded references.',
    },
  },
};
