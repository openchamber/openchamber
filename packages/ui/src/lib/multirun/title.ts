export type ParsedMultiRunTitle = {
  groupSlug: string;
  runGroup?: string;
  providerID: string;
  modelID: string;
  index?: number;
  fusion: boolean;
};

const GROUP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;
const RUN_GROUP_PATTERN = /^g[1-9]\d*$/;

const parseSuffix = (
  groupSlug: string,
  runGroup: string | undefined,
  providerID: string,
  modelID: string,
  suffix: string | undefined,
): ParsedMultiRunTitle | null => {
  if (!GROUP_SLUG_PATTERN.test(groupSlug)) return null;
  if (runGroup !== undefined && !RUN_GROUP_PATTERN.test(runGroup)) return null;
  if (!providerID?.trim() || !modelID?.trim()) return null;
  if (providerID !== providerID.trim() || modelID !== modelID.trim()) return null;

  if (suffix === undefined) {
    return { groupSlug, runGroup, providerID, modelID, fusion: false };
  }

  if (suffix === 'fusion') {
    return { groupSlug, runGroup, providerID, modelID, fusion: true };
  }

  if (!/^\d+$/.test(suffix)) return null;
  const index = Number.parseInt(suffix, 10);
  if (!Number.isSafeInteger(index) || index <= 0) return null;

  return { groupSlug, runGroup, providerID, modelID, index, fusion: false };
};

export const parseMultiRunSessionTitle = (title?: string | null): ParsedMultiRunTitle | null => {
  if (!title) return null;
  const segments = title.split('/');
  if (segments.length < 3) return null;
  const [groupSlug, second] = segments;
  const grouped = segments.length >= 4 && RUN_GROUP_PATTERN.test(second);
  const emptyGroup = segments.length >= 5 && second === '';
  const providerOffset = grouped || emptyGroup ? 2 : 1;
  const modelParts = segments.slice(providerOffset + 1);
  if (modelParts.some((part) => !part || part !== part.trim())) return null;
  const last = modelParts.at(-1);
  // Old titles cannot distinguish model IDs ending in /2 or /fusion from
  // suffixes. Preserve that interpretation only for these legacy records.
  const suffix = modelParts.length > 1 && (last === 'fusion' || /^\d+$/.test(last ?? ''))
    ? modelParts.pop()
    : undefined;
  return parseSuffix(groupSlug, grouped ? second : undefined, segments[providerOffset], modelParts.join('/'), suffix);
};

export const getMultiRunSessionTitle = (parts: {
  groupSlug: string;
  runGroup?: string;
  providerID: string;
  modelID: string;
  index?: number;
}): string => {
  const segments = [parts.groupSlug];
  if (parts.runGroup) segments.push(parts.runGroup);
  segments.push(parts.providerID, parts.modelID);
  if (parts.index !== undefined) segments.push(String(parts.index));
  return segments.join('/');
};

export const getFusionSessionTitle = (groupSlug: string, providerID: string, modelID: string, runGroup?: string): string => {
  const segments = [groupSlug];
  if (runGroup) segments.push(runGroup);
  segments.push(providerID, modelID, 'fusion');
  return segments.join('/');
};
