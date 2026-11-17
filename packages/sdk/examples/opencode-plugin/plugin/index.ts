type ToolResult = { content: string };

type EmptyInputSchema = { type: 'object'; properties: object; additionalProperties: false };

type ToolDefinition = {
  name: string;
  description: string;
  options?: { codemode: boolean };
  input: EmptyInputSchema;
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
        options: { codemode: false },
        input: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          return { content: TEAPOT_STATUS };
        },
      });
    });
  },
};
