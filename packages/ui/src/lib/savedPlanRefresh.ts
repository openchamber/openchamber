/** The confirmed raw stays unchanged while a draft is dirty, so its next
 * conditional save still detects a peer edit. Deletion stops pending saves. */
export interface SavedPlanBuffer {
  content: string;
  confirmedRaw: string;
  editRevision: number;
  savedRevision: number;
  deleted: boolean;
}

export const applySavedPlanRefresh = (buffer: SavedPlanBuffer, raw: string | null): 'deleted' | 'dirty' | 'updated' => {
  if (raw === null) {
    buffer.deleted = true;
    if (buffer.editRevision === buffer.savedRevision) buffer.content = '';
    return 'deleted';
  }
  if (buffer.deleted || buffer.editRevision > buffer.savedRevision) return 'dirty';
  buffer.content = raw;
  buffer.confirmedRaw = raw;
  return 'updated';
};
