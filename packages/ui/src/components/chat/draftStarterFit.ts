/**
 * How many starter chips fit one row before the "+" button, or null when all
 * of them do.
 *
 * Widths are the chips' rendered widths as fractions of a pixel
 * (`getBoundingClientRect`), summed as they come: rounding each one first
 * drifted by up to half a pixel per chip, enough to drop the last chip that
 * really fit. `room` is the row's content width, which must not depend on
 * which chips are shown, or hiding a chip shrinks the room and hides the next.
 * A chip may overshoot by a hundredth of a pixel, the noise of subpixel layout.
 */
export function countFittingStarters(
  chipWidths: readonly number[],
  room: number,
  gap: number,
  addWidth: number,
): number | null {
  const available = room - addWidth - gap;
  let used = 0;
  for (let index = 0; index < chipWidths.length; index += 1) {
    const next = used + (index > 0 ? gap : 0) + chipWidths[index];
    if (next > available + 0.01) return index;
    used = next;
  }
  return null;
}

/**
 * The chip a starter moves ahead of to come back into the row: the first of
 * the user's own starters in its group. Shared project starters keep their
 * place in front and do not move; null when there is nothing to move ahead of.
 */
export function moveToFrontTarget(
  starter: { id: string; shared: boolean },
  group: readonly { id: string; shared: boolean }[],
): string | null {
  if (starter.shared) return null;
  const first = group.find((item) => !item.shared);
  return first && first.id !== starter.id ? first.id : null;
}
