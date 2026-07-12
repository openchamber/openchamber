interface SseDataParser {
  push(chunk: string): void;
  end(): void;
}

interface SseDataParserLimits {
  /** Maximum JavaScript UTF-16 code units retained for an unterminated SSE line. */
  maxUnterminatedLineCodeUnits: number;
  /** Maximum JavaScript UTF-16 code units retained across data lines for one pending SSE event, including joining newlines. */
  maxPendingEventDataCodeUnits: number;
}

const DEFAULT_SSE_DATA_PARSER_LIMITS: Readonly<SseDataParserLimits> = {
  maxUnterminatedLineCodeUnits: 64 * 1024,
  maxPendingEventDataCodeUnits: 1024 * 1024,
};

export const createSseDataParser = (
  onData: (data: string) => void,
  limits: SseDataParserLimits = DEFAULT_SSE_DATA_PARSER_LIMITS,
): SseDataParser => {
  const configuredLimits = [limits.maxUnterminatedLineCodeUnits, limits.maxPendingEventDataCodeUnits];
  if (configuredLimits.some((limit) => !Number.isFinite(limit) || !Number.isInteger(limit) || limit < 0)) {
    throw new Error('SSE parser limits must be finite non-negative integers');
  }
  let buffer = '';
  let dataLines: string[] = [];
  let pendingEventDataCodeUnits = 0;

  const processLine = (line: string): void => {
    if (line.length === 0) {
      if (dataLines.length > 0) {
        onData(dataLines.join('\n'));
        dataLines = [];
        pendingEventDataCodeUnits = 0;
      }
      return;
    }

    if (line.startsWith(':')) return;
    const colonIndex = line.indexOf(':');
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex);
    if (field !== 'data') return;

    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    const nextCodeUnits = pendingEventDataCodeUnits + value.length + (dataLines.length > 0 ? 1 : 0);
    if (nextCodeUnits > limits.maxPendingEventDataCodeUnits) {
      throw new Error('SSE pending event data exceeded the configured code-unit limit');
    }
    dataLines.push(value);
    pendingEventDataCodeUnits = nextCodeUnits;
  };

  const drain = (): void => {
    let lineStart = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      const character = buffer[index];
      if (character !== '\n' && character !== '\r') continue;
      if (character === '\r' && index === buffer.length - 1) break;

      processLine(buffer.slice(lineStart, index));
      if (character === '\r' && buffer[index + 1] === '\n') index += 1;
      lineStart = index + 1;
    }
    buffer = buffer.slice(lineStart);
  };

  return {
    push(chunk) {
      if (chunk.length === 0) return;
      buffer += chunk;
      drain();
      if (buffer.length > limits.maxUnterminatedLineCodeUnits) {
        throw new Error('SSE unterminated line exceeded the configured code-unit limit');
      }
    },
    end() {
      buffer = '';
      dataLines = [];
      pendingEventDataCodeUnits = 0;
    },
  };
};
