import React from 'react';
import { FILE_TREE_INDENT_PX } from '@/components/views/files/fileTreeRow';
import type { SessionTreeGuide } from './sessionTreeGeometry';

// The lines take the muted text colour: the border token all but vanishes on
// the sidebar's tone.
// The corner reaches from the line to where the child's slot starts.
const CORNER_WIDTH_PX = FILE_TREE_INDENT_PX - 7;

/**
 * Draws a row's guides over it. `slotStartPx` is where the slot of a level 0
 * row starts; the line of `level` runs under the centre of the slot one level
 * up. The parent wraps the row in a positioned box that contains its margins
 * (`relative flow-root`), so lines of neighbouring rows meet.
 */
export const SessionTreeGuides: React.FC<{ guides: readonly SessionTreeGuide[]; slotStartPx: number }> = ({ guides, slotStartPx }) => (
  <>
    {guides.map(({ level, end }) => {
      const inset = slotStartPx + (level - 1) * FILE_TREE_INDENT_PX + 7;
      return end ? (
        <span
          key={level}
          aria-hidden
          className="pointer-events-none absolute top-0 h-1/2 rounded-es-[3px] border-s border-b border-muted-foreground/25"
          style={{ insetInlineStart: inset, width: CORNER_WIDTH_PX }}
        />
      ) : (
        <span
          key={level}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 w-px bg-muted-foreground/25"
          style={{ insetInlineStart: inset }}
        />
      );
    })}
  </>
);
