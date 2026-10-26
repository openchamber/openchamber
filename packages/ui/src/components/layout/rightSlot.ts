import { create } from 'zustand';

/**
 * The right slot beside the chat holds the work-status card and the context
 * panel, and animates one width for both: from the card's column to the
 * panel's width and back, so the chat column narrows or widens once, in one
 * direction, while the card and the panel cross-fade inside it.
 *
 * The right zone's `ContextPanel` owns the slot and renders the card's host element;
 * `ChatContainer` portals the inline `WorkStatusPanel` into it. The card tells
 * the slot whether it wants its column while the context panel is closed.
 *
 * The slot clips its overflow and is never a scroll container: the closed
 * panel's content is wider than the card's column, and a `scrollIntoView`
 * inside it would otherwise scroll the slot sideways and drag the
 * right-anchored card out of view.
 */

type RightSlotState = {
  /** Where the inline work-status card renders; null until the slot mounts. */
  workStatusHost: HTMLElement | null;
  /**
   * The card takes its column whenever the context panel is closed: switched
   * on, room for it beside the chat, and something to show. It stays true
   * while the context panel covers the card, so closing the panel goes
   * straight back to the card's column.
   */
  workStatusReserved: boolean;
  /**
   * A full-page surface (Archive, Usage, a guest page, ...) replaces the chat
   * in `MainLayout`. The card belongs to the chat, so it hides and gives its
   * column back, without animating: the chat is not on screen to move.
   */
  chatCovered: boolean;
};

export const useRightSlotStore = create<RightSlotState>(() => ({
  workStatusHost: null,
  workStatusReserved: false,
  chatCovered: false,
}));

export const setWorkStatusHost = (node: HTMLElement | null): void => {
  if (useRightSlotStore.getState().workStatusHost !== node) useRightSlotStore.setState({ workStatusHost: node });
};

export const setChatCovered = (covered: boolean): void => {
  if (useRightSlotStore.getState().chatCovered !== covered) useRightSlotStore.setState({ chatCovered: covered });
};

export const setWorkStatusReserved = (reserved: boolean): void => {
  if (useRightSlotStore.getState().workStatusReserved !== reserved) useRightSlotStore.setState({ workStatusReserved: reserved });
};
