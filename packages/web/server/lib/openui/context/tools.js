export const OPENUI_CONTEXT_GROUPS = Object.freeze([
  'data', 'interaction', 'html', 'advanced', 'examples',
]);

export const OPENCHAMBER_OPENUI_ACTION_DEFINITIONS = Object.freeze([
  { action: 'openui.read', title: 'Read OpenUI instructions', description: 'Read selected reference groups' },
  { action: 'openui.prompt', title: 'Ask with OpenUI', description: 'Collect required user input; waits for the answer' },
]);

export const OPENCHAMBER_OPENUI_ACTIONS = Object.freeze(
  OPENCHAMBER_OPENUI_ACTION_DEFINITIONS.map(({ action }) => action),
);

export const OPENUI_TOOL = {
  name: 'openchamber_openui',
  description: 'OpenUI references and input collection. Call directly, including when other tools use Code Mode.',
  definitions: OPENCHAMBER_OPENUI_ACTION_DEFINITIONS,
  parameters: {
    ui: { type: 'string', description: 'Required for openui.prompt: one complete OpenUI DSL program without fences, at most 200000 characters, with a terminal submit action.' },
    groups: {
      type: 'array',
      items: { type: 'string', enum: OPENUI_CONTEXT_GROUPS },
      minItems: 1,
      maxItems: OPENUI_CONTEXT_GROUPS.length,
      description: 'Required for openui.read. Select matching groups from the resident guidance.',
    },
  },
};
