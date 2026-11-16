
export type NavigableItem = {
  id: string;
  disabled?: boolean;
};

export type NavigationKey = 'next' | 'previous' | 'first' | 'last';

type KeyLike = {
  key: string;
  ctrlKey: boolean;
};

export const navigationKey = (event: KeyLike, axis: 'vertical' | 'horizontal' = 'vertical'): NavigationKey | null => {
  const [next, previous] = axis === 'vertical' ? ['ArrowDown', 'ArrowUp'] : ['ArrowRight', 'ArrowLeft'];
  if (event.key === next || (event.ctrlKey && event.key.toLowerCase() === 'n')) return 'next';
  if (event.key === previous || (event.ctrlKey && event.key.toLowerCase() === 'p')) return 'previous';
  if (event.key === 'Home') return 'first';
  if (event.key === 'End') return 'last';
  return null;
};

export const moveListSelection = (
  items: readonly NavigableItem[],
  currentId: string | null,
  key: NavigationKey,
): string | null => {
  const enabled = items.filter((item) => !item.disabled);
  if (enabled.length === 0) {
    return null;
  }
  const first = enabled[0];
  const last = enabled[enabled.length - 1];
  if (key === 'first' || !first || !last) {
    return first?.id ?? null;
  }
  if (key === 'last') {
    return last.id;
  }
  const index = enabled.findIndex((item) => item.id === currentId);
  if (index === -1) {
    return key === 'next' ? first.id : last.id;
  }
  const target = enabled[Math.min(enabled.length - 1, Math.max(0, index + (key === 'next' ? 1 : -1)))];
  return target?.id ?? null;
};
