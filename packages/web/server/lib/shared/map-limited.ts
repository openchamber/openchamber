export async function mapLimited<Item, Result>(
  items: readonly Item[],
  limit: number,
  task: (item: Item | undefined) => Result | PromiseLike<Result>,
) {
  const results = new Array<Result>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
