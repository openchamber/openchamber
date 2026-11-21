export const MODEL_CAPABILITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const;

const MODEL_CAPABILITY_SET: ReadonlySet<string> = new Set(MODEL_CAPABILITIES);

const isModelCapability = (value: string) => MODEL_CAPABILITY_SET.has(value);

export const editableCapabilities = (capabilities: { input: string[]; output: string[] } | undefined) => ({
  inputCapabilities: capabilities ? capabilities.input.filter(isModelCapability) : ['text'],
  outputCapabilities: capabilities ? capabilities.output.filter(isModelCapability) : ['text'],
});
