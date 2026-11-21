export const MODEL_CAPABILITIES = ['text', 'image', 'audio', 'video', 'pdf'] as const;

const MODEL_CAPABILITY_SET: ReadonlySet<string> = new Set(MODEL_CAPABILITIES);

const isModelCapability = (value: string) => MODEL_CAPABILITY_SET.has(value);

export const editableCapabilities = (capabilities: { input?: string[]; output?: string[] } | undefined) => ({
  inputCapabilities: capabilities?.input?.filter(isModelCapability) ?? ['text'],
  outputCapabilities: capabilities?.output?.filter(isModelCapability) ?? ['text'],
});

type ReportedCapabilities = { tools?: boolean; input?: string[]; output?: string[] };

export const resolveDiscoveredCapabilities = (provider: ReportedCapabilities | undefined, catalog: ReportedCapabilities | undefined) => ({
  tools: provider?.tools ?? catalog?.tools,
  input: provider?.input ?? catalog?.input,
  output: provider?.output ?? catalog?.output,
});
