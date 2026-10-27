export const OPENUI_CONTEXT_GROUPS = Object.freeze([
  'data', 'interaction', 'html', 'advanced', 'examples',
]);

export const OPENCHAMBER_OPENUI_PROMPT_ACTION_DEFINITIONS = Object.freeze([
  { action: 'openui.prompt', title: 'Ask with OpenUI', description: 'Collect required user input with one complete ui program; waits for the answer' },
]);

export const OPENCHAMBER_OPENUI_PROMPT_ACTIONS = Object.freeze(
  OPENCHAMBER_OPENUI_PROMPT_ACTION_DEFINITIONS.map(({ action }) => action),
);

export const OPENCHAMBER_OPENUI_READ_ACTION_DEFINITIONS = Object.freeze([
  { action: 'openui.read', title: 'Read OpenUI instructions', description: 'Read task and capability references; omit groups for usage rules and routes' },
]);

export const OPENCHAMBER_OPENUI_READ_ACTIONS = Object.freeze(
  OPENCHAMBER_OPENUI_READ_ACTION_DEFINITIONS.map(({ action }) => action),
);

export const OPENUI_PROMPT_TOOL = {
  name: 'prompt_openui',
  description: 'Ask for user input needed to continue the task and wait for the answer. Deliver display-only or locally interactive UI in an inline openui-lang block. Pass only ui.',
  definitions: OPENCHAMBER_OPENUI_PROMPT_ACTION_DEFINITIONS,
  parameters: {
    ui: { type: 'string', description: 'One complete OpenUI DSL program, at most 200000 characters. This tool always waits for the user response.' },
  },
};

export const OPENUI_READ_TOOL = {
  name: 'openchamber_openui',
  description: 'Read OpenUI instructions and examples by group.',
  definitions: OPENCHAMBER_OPENUI_READ_ACTION_DEFINITIONS,
  parameters: {
    groups: {
      type: 'array',
      items: { type: 'string', enum: OPENUI_CONTEXT_GROUPS },
      maxItems: OPENUI_CONTEXT_GROUPS.length,
      description: 'Omit or pass [] for usage rules and routes. Read matching task and capability groups; reuse loaded references.',
    },
  },
};
