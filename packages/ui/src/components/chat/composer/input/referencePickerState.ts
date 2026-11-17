import type { RepositoryReferenceKind } from '@/lib/api/types';
import { type TrackerReferenceSource } from '@/components/references/referencePickerItems';

export type ReferencePickerState = { source: 'repository'; kind?: RepositoryReferenceKind } | { source: TrackerReferenceSource } | null;
