export interface ToolSchemaLike {
  id?: string;
  description?: string;
  parameters?: unknown;
}

export interface ContextSegmentInput {
  inputTokens: number;
  messageTokens: { user: number; assistant: number; tool: number };
  systemPromptText: string;
  tools: readonly ToolSchemaLike[];
  mcpServerNames: readonly string[];
  skillsTexts: readonly string[];
}

export interface ContextSegments {
  systemTools: number;
  mcpTools: number;
  systemPrompt: number;
  skills: number;
  messages: number;
  other: number;
  total: number;
}

export const estimateTokensFromText = (text: string): number =>
  text.length === 0 ? 0 : Math.ceil(text.length / 4);

export function estimateToolTokens(tool: ToolSchemaLike): number {
  const description = typeof tool.description === 'string' ? tool.description : '';
  let parametersText = '';
  if (tool.parameters != null) {
    try {
      parametersText = JSON.stringify(tool.parameters) ?? '';
    } catch {
      parametersText = '';
    }
  }
  if (!description && !parametersText) return 0;
  return estimateTokensFromText(description) + estimateTokensFromText(parametersText);
}

export function isMcpToolId(id: string, mcpServerNames: readonly string[]): boolean {
  return mcpServerNames.some((name) => id.startsWith(`${name}.`) || id.startsWith(`${name}_`));
}

export function computeContextSegments(input: ContextSegmentInput): ContextSegments {
  const messages = Math.max(0, input.messageTokens.user) + Math.max(0, input.messageTokens.assistant) + Math.max(0, input.messageTokens.tool);
  const systemPrompt = estimateTokensFromText(input.systemPromptText);
  const skills = input.skillsTexts.reduce((acc, text) => acc + estimateTokensFromText(text), 0);

  let systemTools = 0;
  let mcpTools = 0;
  for (const tool of input.tools) {
    const tokens = estimateToolTokens(tool);
    const id = typeof tool.id === 'string' ? tool.id : '';
    if (id && isMcpToolId(id, input.mcpServerNames)) {
      mcpTools += tokens;
    } else {
      systemTools += tokens;
    }
  }

  const accounted = systemTools + mcpTools + systemPrompt + skills + messages;
  const other = Math.max(0, input.inputTokens - accounted);
  const total = Math.max(input.inputTokens, accounted);

  return { systemTools, mcpTools, systemPrompt, skills, messages, other, total };
}
