type TextNodeLike = { data: string };

type TextBoundaryAffinity = 'left' | 'right';

export const findTextPosition = <T extends TextNodeLike>(
  textNodes: T[],
  targetOffset: number,
  affinity: TextBoundaryAffinity,
): { node: T; offset: number } | null => {
  let currentOffset = 0;

  for (const node of textNodes) {
    const nextOffset = currentOffset + node.data.length;
    if (targetOffset < nextOffset || (targetOffset === nextOffset && affinity === 'left')) {
      return { node, offset: Math.max(0, targetOffset - currentOffset) };
    }
    currentOffset = nextOffset;
  }

  const lastNode = textNodes.at(-1);
  return lastNode ? { node: lastNode, offset: lastNode.data.length } : null;
};
