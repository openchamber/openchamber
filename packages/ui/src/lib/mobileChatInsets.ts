import { create } from 'zustand';

/**
 * How far the tablet's side panels push the chat column in from the window's
 * edges, so overlays portaled to <body> (every MobileOverlayPanel, the dialog
 * surfaces) center on the chat rather than on the window. Zero on phones and
 * outside the mobile shell.
 *
 * A store, not custom properties on the document root: written there they
 * restyled the whole page on every sidebar toggle, 45 ms per write on an
 * iPad Air, in the frame the panel was about to move.
 */
export const useMobileChatInsets = create<{ left: number; right: number }>(() => ({ left: 0, right: 0 }));
