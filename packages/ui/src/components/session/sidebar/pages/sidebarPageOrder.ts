const placeMissingAfterTheirPredecessor = (base: readonly string[], reference: readonly string[]): string[] => {
  const result = [...base];
  const placed = new Set(base);
  reference.forEach((id, index) => {
    if (placed.has(id)) return;
    const previous = reference.slice(0, index).reverse().find((candidate) => placed.has(candidate));
    result.splice(previous === undefined ? 0 : result.indexOf(previous) + 1, 0, id);
    placed.add(id);
  });
  return result;
};

export const orderSidebarPages = <T extends { id: string }>(pages: readonly T[], storedOrder: readonly string[]): T[] => {
  const byId = new Map(pages.map((page) => [page.id, page]));
  const known = storedOrder.filter((id) => byId.has(id));
  return placeMissingAfterTheirPredecessor(known, pages.map((page) => page.id)).flatMap((id) => byId.get(id) ?? []);
};

export const nextSidebarPageOrder = (arranged: readonly string[], storedOrder: readonly string[]): string[] => (
  placeMissingAfterTheirPredecessor(arranged, storedOrder)
);
