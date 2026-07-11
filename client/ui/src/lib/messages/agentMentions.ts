import type { Agent } from "@opencode-ai/sdk/v2";

interface AgentMentionSource {
  value: string;
  start: number;
  end: number;
}

interface ParsedAgentMention {
  name: string;
  source?: AgentMentionSource;
}

export interface ParsedAgentResult {
  sanitizedText: string;
  mention: ParsedAgentMention | null;
}

const isWordBoundaryChar = (char: string | null): boolean => {
  if (!char) {
    return true;
  }
  return /(\s|\(|\)|\[|\]|\{|\}|"|'|`|,|\.|;|:)/.test(char);
};

export const parseAgentMentions = (rawText: string, agents: Agent[]): ParsedAgentResult => {
  if (typeof rawText !== "string" || rawText.length === 0) {
    return { sanitizedText: rawText, mention: null };
  }

  const nonPrimaryAgents = agents.filter((agent) => agent.mode && agent.mode !== "primary");
  if (nonPrimaryAgents.length === 0 || !rawText.includes("@")) {
    return { sanitizedText: rawText, mention: null };
  }

  let firstMention: ParsedAgentMention | null = null;

  for (const agent of nonPrimaryAgents) {
    const escapedAgentName = agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`@${escapedAgentName}\\b`, "gi");
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(rawText)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      const charBefore = start > 0 ? rawText[start - 1] : null;

      if (!isWordBoundaryChar(charBefore)) {
        continue;
      }

      const mention: ParsedAgentMention = {
        name: agent.name,
        source: {
          value: match[0],
          start,
          end,
        },
      };

      if (!firstMention) {
        firstMention = mention;
      }

    }
  }

  if (!firstMention) {
    return { sanitizedText: rawText, mention: null };
  }

  return {
    sanitizedText: rawText,
    mention: firstMention,
  };
};
