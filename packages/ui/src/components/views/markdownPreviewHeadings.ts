export type PreviewHeading = {
  element: HTMLElement;
  /** 1 to 6, from the tag. */
  level: number;
  text: string;
};

// One selector list, so the result comes in document order and a nested
// rendered document cannot list a heading twice.
const HEADING_SELECTOR = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']
  .map((tag) => `[data-markdown-content] ${tag}`)
  .join(',');

/**
 * The headings the Markdown preview shows, as rendered. Only rendered
 * document content counts: a heading in the preview's own chrome is not part
 * of the document. A long document mounts only the blocks near the view, so a
 * caller that wants every heading holds the blocks first (`holdMarkdownBlocks`).
 */
export const readPreviewHeadings = (container: Element): PreviewHeading[] => {
  const headings: PreviewHeading[] = [];
  for (const element of container.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (text) headings.push({ element, level: Number(element.tagName.charAt(1)), text });
  }
  return headings;
};
