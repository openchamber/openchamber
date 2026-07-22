import type { Message } from '@opencode-ai/sdk/v2/client';

type OpenChamberCommandSurface = 'main' | 'embedded';

type OpenChamberCommandDefinition = {
  id: string;
  name: 'side' | 'btw';
  source: 'openchamber';
  isOpenChamber: true;
  description?: string;
};

type SideChatCommand = {
  name: 'side' | 'btw';
  prompt: string;
};

const SIDE_CHAT_COMMANDS: OpenChamberCommandDefinition[] = [
  { id: 'openchamber:side', name: 'side', source: 'openchamber', isOpenChamber: true },
  { id: 'openchamber:btw', name: 'btw', source: 'openchamber', isOpenChamber: true },
];

export const getOpenChamberCommands = (options: {
  surface: OpenChamberCommandSurface;
  isMobile: boolean;
  isVSCode: boolean;
  sideChatDescription?: string;
  btwDescription?: string;
}): OpenChamberCommandDefinition[] => (
  options.surface === 'main' && !options.isMobile && !options.isVSCode
    ? SIDE_CHAT_COMMANDS.map((command) => ({
        ...command,
        description: command.name === 'btw' ? options.btwDescription : options.sideChatDescription,
      }))
    : []
);

export const mergeOpenChamberCommands = <T extends { name: string }>(
  openChamberCommands: OpenChamberCommandDefinition[],
  commands: T[],
): Array<OpenChamberCommandDefinition | T> => {
  const reserved = new Set(openChamberCommands.map((command) => command.name.toLowerCase()));
  return [...openChamberCommands, ...commands.filter((command) => !reserved.has(command.name.toLowerCase()))];
};

export const parseSideChatCommand = (value: string): SideChatCommand | null => {
  const match = /^\/(side|btw)(?=$|\s)(?:[ \t]+)?([\s\S]*)$/i.exec(value);
  if (!match) return null;
  return {
    name: match[1].toLowerCase() as SideChatCommand['name'],
    prompt: match[2].replace(/^\n+|\s+$/g, ''),
  };
};

export const getLatestCompletedAssistantMessageId = (messages: readonly Message[]): string | null => {
  let latest: { id: string; completed: number } | null = null;
  for (const message of messages) {
    const completed = message.role === 'assistant' ? message.time?.completed : undefined;
    if (typeof completed !== 'number' || !Number.isFinite(completed) || completed <= 0) continue;
    if (!latest || completed >= latest.completed) latest = { id: message.id, completed };
  }
  return latest?.id ?? null;
};
