export type ParsedMultiRunTitle = {
  groupSlug: string;
  providerID: string;
  modelID: string;
  index?: number;
  fusion: boolean;
};

const GROUP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/;

export const parseMultiRunSessionTitle = (title?: string | null): ParsedMultiRunTitle | null => {
  if (!title) return null;
  const segments = title.split('/');
  if (segments.length !== 3 && segments.length !== 4) return null;

  const [groupSlug, providerID, modelID, suffix] = segments;
  if (!GROUP_SLUG_PATTERN.test(groupSlug)) return null;
  if (!providerID?.trim() || !modelID?.trim()) return null;
  if (providerID !== providerID.trim() || modelID !== modelID.trim()) return null;

  if (segments.length === 3) {
    return { groupSlug, providerID, modelID, fusion: false };
  }

  if (suffix === 'fusion') {
    return { groupSlug, providerID, modelID, fusion: true };
  }

  if (!/^\d+$/.test(suffix)) return null;
  const index = Number.parseInt(suffix, 10);
  if (!Number.isSafeInteger(index) || index <= 0) return null;

  return { groupSlug, providerID, modelID, index, fusion: false };
};

export const isMultiRunSessionTitle = (title?: string | null): boolean => {
  return parseMultiRunSessionTitle(title) !== null;
};

export const getFusionSessionTitle = (groupSlug: string, providerID: string, modelID: string): string => {
  return `${groupSlug}/${providerID}/${modelID}/fusion`;
};
