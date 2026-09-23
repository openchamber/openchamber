/**
 * The tabs a strip's "close others / to the left / to the right" act on.
 *
 * Positions are counted among closable tabs only. A zone's strip can lead with
 * the conversation, which is never closable; counting it would shift every
 * range by one, so "close tabs to the left" would also close the tab that was
 * clicked.
 */
export const closableTabRanges = (
  allIds: readonly string[],
  clickedId: string,
  unclosableId: string,
) => {
  const closableIds = allIds.filter((id) => id !== unclosableId);
  const position = closableIds.indexOf(clickedId);
  if (position === -1) {
    // The unclosable tab itself: everything closable sits to its right.
    return { closableIds, toLeft: [], toRight: closableIds };
  }
  return {
    closableIds,
    toLeft: closableIds.slice(0, position),
    toRight: closableIds.slice(position + 1),
  };
};
