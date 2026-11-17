import type { RepositoryReferenceKind } from '@/lib/api/types';
import { type TrackerReferenceSource } from '@/components/references/referencePickerItems';

/** Which reference picker is open, and for the repository on which tab. */
export type ReferencePickerState = { source: 'repository'; kind?: RepositoryReferenceKind } | { source: TrackerReferenceSource } | null;
