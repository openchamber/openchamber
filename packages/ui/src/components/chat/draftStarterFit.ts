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

export function moveToFrontTarget(
  starter: { id: string; shared: boolean },
  group: readonly { id: string; shared: boolean }[],
): string | null {
  if (starter.shared) return null;
  const first = group.find((item) => !item.shared);
  return first && first.id !== starter.id ? first.id : null;
}
