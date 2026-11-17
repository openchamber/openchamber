
const PROPERTY = '--oc-titlebar-controls-width';

const readers = new Set<HTMLElement>();
let published: string | null = null;

const apply = (reader: HTMLElement) => {
  if (published === null) reader.style.removeProperty(PROPERTY);
  else if (reader.style.getPropertyValue(PROPERTY) !== published) reader.style.setProperty(PROPERTY, published);
};

export const publishTitlebarControlsWidth = (px: number): void => {
  const value = `${Math.round(px)}px`;
  if (value === published) return;
  published = value;
  readers.forEach(apply);
};

export const titlebarControlsWidthReaderRef = (node: HTMLElement | null): (() => void) | undefined => {
  if (!node) return undefined;
  readers.add(node);
  apply(node);
  return () => {
    readers.delete(node);
  };
};
