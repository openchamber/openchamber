// packages/sdk/examples/opencode-plugin/plugin/index.ts
var TEAPOT_STATUS = "The teapot is warm and holds 418 ml. It refuses to brew coffee.";
var plugin_default = {
  id: "teapot-tools",
  setup: async (ctx) => {
    await ctx.tool.transform((tools) => {
      tools.add({
        name: "teapot_status",
        description: "Reports the state of the office teapot. Takes no input.",
        options: { codemode: false },
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: TEAPOT_STATUS };
        }
      });
    });
  }
};
export {
  plugin_default as default
};
