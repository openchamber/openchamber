export type PreviewHeading = {
  element: HTMLElement;
  level: number;
  text: string;
};

const HEADING_SELECTOR = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
  .map((tag) => `[data-markdown-content] ${tag}`)
  .join(',');

export const readPreviewHeadings = (container: Element): PreviewHeading[] => {
  const headings: PreviewHeading[] = [];
  for (const element of container.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) headings.push({ element, level: Number(element.tagName.charAt(1)), text });
  }
  return headings;
};
