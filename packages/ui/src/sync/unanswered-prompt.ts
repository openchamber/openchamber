import type { Message, Part, UserMessage } from '@/lib/opencode/model';

const RAN_SINCE_PROMPT: ReadonlySet<Message['role']> = new Set(['shell', 'compaction', 'synthetic', 'skill']);

const answers = (parts: readonly Part[]) =>
  parts.some((part) => part.type === 'tool' || (part.type === 'text' && part.text.trim() !== ''));

export const selectUnansweredPrompt = (
  messages: readonly Message[],
  partsOf: (messageID: string) => readonly Part[],
): UserMessage | null => {
  if (messages.some((message) => message.role === 'user' && message.pending)) return null;
  const index = messages.map((message) => message.role).lastIndexOf('user');
  const prompt = messages[index];
  if (prompt?.role !== 'user') return null;
  const answered = messages.slice(index + 1).some((message) =>
    RAN_SINCE_PROMPT.has(message.role) || (message.role === 'assistant' && answers(partsOf(message.id))));
  return answered ? null : prompt;
};
