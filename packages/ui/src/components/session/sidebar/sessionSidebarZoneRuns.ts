export const gatherRunMembers = <Entry>(entries: readonly Entry[], runKeyOf: (entry: Entry) => string | undefined): readonly Entry[] => {
  const membersByRun = new Map<string, Entry[]>();
  for (const entry of entries) {
    const runKey = runKeyOf(entry);
    if (runKey) membersByRun.set(runKey, [...(membersByRun.get(runKey) ?? []), entry]);
  }
  if (membersByRun.size === 0) return entries;
  const placed = new Set<string>();
  return entries.flatMap((entry) => {
    const runKey = runKeyOf(entry);
    if (!runKey) return [entry];
    if (placed.has(runKey)) return [];
    placed.add(runKey);
    return membersByRun.get(runKey) ?? [entry];
  });
};
