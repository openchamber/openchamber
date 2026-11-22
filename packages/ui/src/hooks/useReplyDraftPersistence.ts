import React from 'react';
import type { UiBlockReplyDraft } from '@/components/chat/uiBlocks/answer';

export type ReplyDraftStorage = {
  load: () => UiBlockReplyDraft | undefined;
  save: (draft: UiBlockReplyDraft | null) => void;
};

export function useReplyDraftPersistence(
  draft: ReplyDraftStorage | undefined,
  values: UiBlockReplyDraft['values'],
  chosen: ReadonlyMap<string, string | null>,
  notes: ReadonlyMap<string, string>,
  note: string,
  sent: boolean,
  answered: boolean,
) {
  React.useLayoutEffect(() => {
    if (!draft) return;
    if (answered || (!chosen.size && !notes.size && !note && !Object.keys(values).length)) {
      draft.save(null);
    } else if (!sent) {
      draft.save({ chosen: [...chosen], notes: [...notes], note, values });
    }
  }, [draft, chosen, notes, note, values, sent, answered]);
}
