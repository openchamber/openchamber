import type { Message, Part } from '@opencode-ai/sdk/v2';

type MessageRecord = {
  info: Message;
  parts: Part[];
};

const readPartId = (part: Part | undefined): string | null => {
  if (!part) return null;
  const candidate = (part as { id?: unknown }).id;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
};

const readToolStatus = (part: Part | undefined): string | null => {
  const status = (part as { state?: { status?: unknown } } | undefined)?.state?.status;
  return typeof status === 'string' ? status : null;
};

const readPartTime = (part: Part | undefined) => {
  const time = (part as { time?: { start?: unknown; end?: unknown } } | undefined)?.time;
  return {
    start: typeof time?.start === 'number' ? time.start : null,
    end: typeof time?.end === 'number' ? time.end : null,
  };
};

const readPartText = (part: Part | undefined): string => {
  const candidate = part as { text?: unknown; content?: unknown; value?: unknown } | undefined;
  if (!candidate) return '';
  const text = typeof candidate.text === 'string' ? candidate.text : '';
  const content = typeof candidate.content === 'string' ? candidate.content : '';
  const value = typeof candidate.value === 'string' ? candidate.value : '';
  return [text, content, value].reduce((best, next) => (next.length > best.length ? next : best), '');
};

export const areRenderRelevantPartsEqual = (left: Part[], right: Part[]): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];

    if (leftPart.type !== rightPart.type) {
      return false;
    }

    const leftId = readPartId(leftPart);
    const rightId = readPartId(rightPart);
    if (leftId !== rightId) {
      return false;
    }

    if (leftPart.type === 'tool') {
      if (readToolStatus(leftPart) !== readToolStatus(rightPart)) {
        return false;
      }
      const leftTime = readPartTime(leftPart);
      const rightTime = readPartTime(rightPart);
      if (leftTime.start !== rightTime.start || leftTime.end !== rightTime.end) {
        return false;
      }
      const leftTool = (leftPart as { tool?: unknown }).tool;
      const rightTool = (rightPart as { tool?: unknown }).tool;
      if (leftTool !== rightTool) {
        return false;
      }
      continue;
    }

    const leftTime = readPartTime(leftPart);
    const rightTime = readPartTime(rightPart);
    if (leftTime.start !== rightTime.start || leftTime.end !== rightTime.end) {
      return false;
    }

    if (leftPart.type === 'text' || leftPart.type === 'reasoning') {
      if (readPartText(leftPart) !== readPartText(rightPart)) {
        return false;
      }
    }
  }

  return true;
};

export const areRenderRelevantMessageInfoEqual = (left: Message, right: Message): boolean => {
  if (left === right) return true;

  return left.id === right.id
    && left.role === right.role
    && left.sessionID === right.sessionID
    && (left as { finish?: unknown }).finish === (right as { finish?: unknown }).finish
    && (left as { status?: unknown }).status === (right as { status?: unknown }).status
    && (left as { mode?: unknown }).mode === (right as { mode?: unknown }).mode
    && (left as { agent?: unknown }).agent === (right as { agent?: unknown }).agent
    && (left as { providerID?: unknown }).providerID === (right as { providerID?: unknown }).providerID
    && (left as { modelID?: unknown }).modelID === (right as { modelID?: unknown }).modelID
    && (left as { variant?: unknown }).variant === (right as { variant?: unknown }).variant
    && (left as { clientRole?: unknown }).clientRole === (right as { clientRole?: unknown }).clientRole
    && (left as { userMessageMarker?: unknown }).userMessageMarker === (right as { userMessageMarker?: unknown }).userMessageMarker
    && ((left as { time?: { created?: unknown; completed?: unknown } }).time?.created ?? null) === ((right as { time?: { created?: unknown; completed?: unknown } }).time?.created ?? null)
    && ((left as { time?: { created?: unknown; completed?: unknown } }).time?.completed ?? null) === ((right as { time?: { created?: unknown; completed?: unknown } }).time?.completed ?? null);
};

export const areRenderRelevantMessagesEqual = (left: MessageRecord, right: MessageRecord): boolean => {
  return areRenderRelevantMessageInfoEqual(left.info, right.info) && areRenderRelevantPartsEqual(left.parts, right.parts);
};

export const areOptionalRenderRelevantMessagesEqual = (left?: MessageRecord, right?: MessageRecord): boolean => {
  if (!left || !right) {
    return left === right;
  }
  return areRenderRelevantMessagesEqual(left, right);
};
