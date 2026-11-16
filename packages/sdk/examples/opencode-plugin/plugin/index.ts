// An OpenCode plugin shipped inside an OpenChamber extension. OpenChamber lists
// this folder in the OpenCode config it manages while the extension is on, and
// OpenCode loads `index.js` from here with a plain `import()`: nothing is
// installed beside it, so the file imports nothing and types the little it
// touches of the plugin API itself.

// What a tool answers: text for the model. No `output` field, since the tool
// declares no output schema, and OpenCode refuses a bare string.
type ToolResult = { content: string };

/** The tool's input as plain JSON Schema; this tool takes nothing. */
type EmptyInputSchema = { type: 'object'; properties: object; additionalProperties: false };

type ToolDefinition = {
  name: string;
  description: string;
  options?: { codemode: boolean };
  input: EmptyInputSchema;
  // OpenCode calls it with the input and the call's context; this tool reads neither.
  execute: () => Promise<ToolResult>;
};

type ToolList = { add: (tool: ToolDefinition) => void };

type PluginContext = {
  tool: { transform: (edit: (tools: ToolList) => void) => Promise<void> };
};

const TEAPOT_STATUS = 'The teapot is warm and holds 418 ml. It refuses to brew coffee.';

export default {
  id: 'teapot-tools',
  setup: async (ctx: PluginContext) => {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: 'teapot_status',
        description: 'Reports the state of the office teapot. Takes no input.',
        // Offered to the model directly, outside OpenCode's Code Mode catalog.
        options: { codemode: false },
        input: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          return { content: TEAPOT_STATUS };
        },
      });
    });
  },
};
