import React from 'react';
import { matchesFileEditorPattern, type FileEditorContribution } from '@openchamber/sdk';

import { isGuestActive } from './capabilities.ts';
import { guestsInScope, useGuestScopeStore } from './folders.ts';
import { useGuestsStore } from './store.ts';
import type { InstalledGuest } from './types.ts';

type GuestFileEditorMatch = {
  guestId: string;
  editor: FileEditorContribution;
};

const fileNameOf = (filePath: string): string => filePath.slice(filePath.replace(/\\/g, '/').lastIndexOf('/') + 1);

export const findGuestFileEditor = (
  guests: readonly InstalledGuest[],
  filePath: string,
): GuestFileEditorMatch | null => {
  const fileName = fileNameOf(filePath);
  if (!fileName) return null;
  for (const guest of guests) {
    if (!guest.fileEditors?.length || !isGuestActive(guest)) continue;
    for (const editor of guest.fileEditors) {
      if (editor.match.some((pattern) => matchesFileEditorPattern(fileName, pattern))) {
        return { guestId: guest.id, editor };
      }
    }
  }
  return null;
};

export const findOpenGuestFileEditor = (filePath: string): GuestFileEditorMatch | null => (
  findGuestFileEditor(guestsInScope(useGuestsStore.getState().guests, useGuestScopeStore.getState().paths), filePath)
);

const findScopedGuestFileEditor = (
  guests: InstalledGuest[],
  paths: readonly string[],
  filePath: string,
  held: string | null,
): GuestFileEditorMatch | null => {
  const inScope = guestsInScope(guests, paths);
  const heldGuest = held ? guests.find((guest) => guest.id === held && !inScope.includes(guest)) : undefined;
  return findGuestFileEditor(heldGuest ? [heldGuest, ...inScope] : inScope, filePath);
};

export const useGuestFileEditor = (filePath: string | null | undefined, dirty = false): GuestFileEditorMatch | null => {
  const guests = useGuestsStore((state) => state.guests);
  const paths = useGuestScopeStore((state) => state.paths);
  const [shown, setShown] = React.useState<{ filePath: string; guestId: string; held: boolean } | null>(null);
  const held = shown && shown.filePath === filePath && (dirty || shown.held) ? shown.guestId : null;
  const match = React.useMemo(
    () => (filePath ? findScopedGuestFileEditor(guests, paths, filePath, held) : null),
    [filePath, guests, held, paths],
  );
  const next = filePath && match ? { filePath, guestId: match.guestId, held: held !== null && match.guestId === held } : null;
  if (next?.filePath !== shown?.filePath || next?.guestId !== shown?.guestId || next?.held !== shown?.held) setShown(next);
  return match;
};
