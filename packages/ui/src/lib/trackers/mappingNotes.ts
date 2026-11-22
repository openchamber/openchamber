import type { TrackerMappingResult } from './types';

type MappingLike = Pick<Extract<TrackerMappingResult, { connected: true }>, 'containers' | 'containersMore'>;

export function trackerMappingContainersTruncated(mapping: MappingLike | null | undefined): boolean {
  return mapping?.containersMore === true;
}

/** True when the list is empty and complete; a truncated empty list says nothing about whether the account has any. */
export function trackerMappingShowsEmptyContainersNote(mapping: MappingLike | null | undefined): boolean {
  return (mapping?.containers ?? []).length === 0 && !trackerMappingContainersTruncated(mapping);
}
