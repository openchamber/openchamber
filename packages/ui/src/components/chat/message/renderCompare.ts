import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { TurnActivityGroup, TurnActivityRecord, TurnDiffStats, TurnGroupingContext } from '../lib/turns/types';

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

const areTurnDiffStatsEqual = (left?: TurnDiffStats, right?: TurnDiffStats): boolean => {
  if (!left || !right) {
    return left === right;
  }

  return left.additions === right.additions
    && left.deletions === right.deletions
    && left.files === right.files;
};

const areTurnActivityRecordsEqual = (left: TurnActivityRecord, right: TurnActivityRecord): boolean => {
  return left.id === right.id
    && left.messageId === right.messageId
    && left.kind === right.kind
    && left.partIndex === right.partIndex
    && left.endedAt === right.endedAt
    && areRenderRelevantPartsEqual([left.part], [right.part]);
};

const areRelevantActivityPartsEqual = (
  left: TurnActivityRecord[] | undefined,
  right: TurnActivityRecord[] | undefined,
  messageId: string,
): boolean => {
  let leftIndex = 0;
  let rightIndex = 0;

  while (true) {
    while (leftIndex < (left?.length ?? 0) && left?.[leftIndex]?.messageId !== messageId) {
      leftIndex += 1;
    }
    while (rightIndex < (right?.length ?? 0) && right?.[rightIndex]?.messageId !== messageId) {
      rightIndex += 1;
    }

    const leftRecord = left?.[leftIndex];
    const rightRecord = right?.[rightIndex];

    if (!leftRecord || !rightRecord) {
      return leftRecord === rightRecord;
    }

    if (!areTurnActivityRecordsEqual(leftRecord, rightRecord)) {
      return false;
    }

    leftIndex += 1;
    rightIndex += 1;
  }
};

const areTurnActivityGroupsEqual = (left: TurnActivityGroup, right: TurnActivityGroup): boolean => {
  if (left.id !== right.id || left.anchorMessageId !== right.anchorMessageId || left.afterToolPartId !== right.afterToolPartId) {
    return false;
  }

  if (left.parts.length !== right.parts.length) {
    return false;
  }

  for (let index = 0; index < left.parts.length; index += 1) {
    if (!areTurnActivityRecordsEqual(left.parts[index], right.parts[index])) {
      return false;
    }
  }

  return true;
};

const hasRelevantActivitySegments = (segments: TurnActivityGroup[] | undefined, messageId: string): boolean => {
  return Boolean(segments?.some((segment) => segment.anchorMessageId === messageId));
};

const areRelevantActivitySegmentsEqual = (
  left: TurnActivityGroup[] | undefined,
  right: TurnActivityGroup[] | undefined,
  messageId: string,
): boolean => {
  let leftIndex = 0;
  let rightIndex = 0;

  while (true) {
    while (leftIndex < (left?.length ?? 0) && left?.[leftIndex]?.anchorMessageId !== messageId) {
      leftIndex += 1;
    }
    while (rightIndex < (right?.length ?? 0) && right?.[rightIndex]?.anchorMessageId !== messageId) {
      rightIndex += 1;
    }

    const leftSegment = left?.[leftIndex];
    const rightSegment = right?.[rightIndex];

    if (!leftSegment || !rightSegment) {
      return leftSegment === rightSegment;
    }

    if (!areTurnActivityGroupsEqual(leftSegment, rightSegment)) {
      return false;
    }

    leftIndex += 1;
    rightIndex += 1;
  }
};

export const areRelevantTurnGroupingContextsEqual = (
  left: TurnGroupingContext | undefined,
  right: TurnGroupingContext | undefined,
  messageId: string,
  isUserMessage: boolean,
): boolean => {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return left === right;
  }

  if (isUserMessage) {
    return true;
  }

  if (left.turnId !== right.turnId) return false;
  if (left.isFirstAssistantInTurn !== right.isFirstAssistantInTurn) return false;
  if (left.isLastAssistantInTurn !== right.isLastAssistantInTurn) return false;
  if (left.isWorking !== right.isWorking) return false;
  if (left.hasTools !== right.hasTools) return false;
  if (left.hasReasoning !== right.hasReasoning) return false;
  if (left.userMessageCreatedAt !== right.userMessageCreatedAt) return false;
  if (left.userMessageVariant !== right.userMessageVariant) return false;

  const headerRelevant = left.headerMessageId === messageId || right.headerMessageId === messageId;
  if (headerRelevant && left.headerMessageId !== right.headerMessageId) {
    return false;
  }

  const ownerRelevant = left.activityOwnerMessageId === messageId || right.activityOwnerMessageId === messageId;
  if (ownerRelevant && left.activityOwnerMessageId !== right.activityOwnerMessageId) {
    return false;
  }

  if (!areRelevantActivityPartsEqual(left.activityParts, right.activityParts, messageId)) {
    return false;
  }

  if (!areRelevantActivitySegmentsEqual(left.activityGroupSegments, right.activityGroupSegments, messageId)) {
    return false;
  }

  const segmentsRelevant = hasRelevantActivitySegments(left.activityGroupSegments, messageId)
    || hasRelevantActivitySegments(right.activityGroupSegments, messageId);

  if ((ownerRelevant || segmentsRelevant) && left.isGroupExpanded !== right.isGroupExpanded) {
    return false;
  }

  if ((ownerRelevant || segmentsRelevant) && left.toggleGroup !== right.toggleGroup) {
    return false;
  }

  if ((ownerRelevant || segmentsRelevant) && !areTurnDiffStatsEqual(left.diffStats, right.diffStats)) {
    return false;
  }

  return true;
};
