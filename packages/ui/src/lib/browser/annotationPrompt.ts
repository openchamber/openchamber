/**
 * Renders a browser annotation into the text the agent actually reads.
 *
 * The body is deliberately English regardless of UI locale: it is prompt
 * content, not interface copy. Only the caller-supplied intro is translated,
 * because that line is echoed back to the user in the composer.
 */
import type {
  BrowserAnnotationPayload,
  BrowserAnnotationRegion,
  BrowserAnnotationStroke,
  BrowserElementTarget,
} from './contract';

const round = (value: number): number => Math.round(value);

const describeElement = (target: BrowserElementTarget, index: number): string[] => {
  const text = target.text.trim();
  const attributes = Object.entries(target.attributes)
    .map(([key, value]) => `${key}="${value}"`)
    .join(' ');
  const ancestry = target.ancestry.map((entry) => entry.selectorPart).join(' > ');
  const styles = target.computedStyle;
  const bounds = target.bounds;

  return [
    `Element ${index + 1}: ${target.tag}`,
    text ? `- Text: ${text}` : null,
    `- Selector: ${target.selector}`,
    `- Path: ${target.path}`,
    ancestry ? `- Ancestry: ${ancestry}` : null,
    attributes ? `- Attributes: ${attributes}` : null,
    `- Bounds: x=${round(bounds.x)}, y=${round(bounds.y)}, width=${round(bounds.width)}, height=${round(bounds.height)}`,
    `- Styles: display=${styles.display ?? ''}; position=${styles.position ?? ''}; font=${styles.fontWeight ?? ''} ${styles.fontSize ?? ''} / ${styles.lineHeight ?? ''} ${styles.fontFamily ?? ''}; color=${styles.color ?? ''}; background=${styles.backgroundColor ?? ''}`,
  ].filter((line): line is string => typeof line === 'string');
};

const describeRegion = (region: BrowserAnnotationRegion, index: number): string => {
  const rect = region.rect;
  return `Region ${index + 1}: x=${round(rect.x)}, y=${round(rect.y)}, width=${round(rect.width)}, height=${round(rect.height)}`;
};

const describeStroke = (stroke: BrowserAnnotationStroke, index: number): string => {
  const bounds = stroke.bounds;
  return `Drawing ${index + 1}: ${stroke.points.length} points over x=${round(bounds.x)}, y=${round(bounds.y)}, width=${round(bounds.width)}, height=${round(bounds.height)}`;
};

export const formatBrowserAnnotationPrompt = ({
  payload,
  screenshotAttached,
  intro,
}: {
  payload: BrowserAnnotationPayload;
  screenshotAttached: boolean;
  intro: string;
}): string => {
  const introLabel = intro.replace(/[.:]+$/g, '');
  const comment = payload.comment.trim();
  const lines: Array<string | null> = [
    `${introLabel}:`,
    `Page: ${payload.pageTitle.trim() || payload.pageUrl || 'browser'}`,
    payload.pageTitle.trim() && payload.pageUrl ? `URL: ${payload.pageUrl}` : null,
    `Viewport: ${round(payload.viewport.width)}x${round(payload.viewport.height)}, DPR ${payload.devicePixelRatio}`,
    `Screenshot: ${screenshotAttached ? 'attached' : 'not attached'}`,
    comment ? `Comment: ${comment}` : null,
  ];

  for (const [index, entry] of payload.elements.entries()) {
    lines.push('', ...describeElement(entry.element, index));
  }

  if (payload.regions.length > 0) {
    lines.push('');
    payload.regions.forEach((region, index) => lines.push(describeRegion(region, index)));
  }

  if (payload.strokes.length > 0) {
    lines.push('');
    payload.strokes.forEach((stroke, index) => lines.push(describeStroke(stroke, index)));
  }

  return lines.filter((line): line is string => typeof line === 'string').join('\n');
};
