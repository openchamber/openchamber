const toPositiveFiniteNumber = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return value;
};

const getMessageInfo = (message: unknown): Record<string, unknown> | null => {
  if (!message || typeof message !== 'object') {
    return null;
  }

  const record = message as Record<string, unknown>;
  const info = record.info;
  if (info && typeof info === 'object') {
    return info as Record<string, unknown>;
  }

  return record;
};

export const sumAssistantMessageCosts = (messages: readonly unknown[]): number => {
  return messages.reduce<number>((sum, message) => {
    const info = getMessageInfo(message);
    if (info?.role !== 'assistant') {
      return sum;
    }
    return sum + toPositiveFiniteNumber(info.cost);
  }, 0);
};
