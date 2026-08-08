import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./SessionNodeItem.tsx', import.meta.url), 'utf8');

describe('SessionNodeItem recent-activity timestamp', () => {
  test('the recent activity rows render the compact timestamp in the inline metadata slot', () => {
    // The right-slot guard must open for recent rows even when no activity,
    // goal glyph, or branch marker is present.
    const guard = source.indexOf("showActivityDuration || sessionGoalGlyph || showInlineBranchMarker || renderContext === 'recent'");
    expect(guard).toBeGreaterThan(-1);
    // The recent-only block sits inside that slot…
    const guardOpen = source.indexOf("{renderContext === 'recent' ? (", guard);
    expect(guardOpen).toBeGreaterThan(guard);
    // …and the compact label rendered there is the first one after it.
    const label = source.indexOf('{sessionCompactUpdatedLabel}', guardOpen);
    expect(label).toBeGreaterThan(guardOpen);
    // The only later occurrence is the pre-existing row tooltip (which shows
    // the full date), not a second inline render.
    const tooltipLabel = source.indexOf('{sessionCompactUpdatedLabel}', label + 1);
    expect(tooltipLabel).toBeGreaterThan(label);
    expect(source.indexOf('title={sessionUpdatedLabel}', tooltipLabel - 80)).toBeGreaterThan(-1);
  });

  test('the timestamp shares the hover-fade of the other metadata so revealed actions never overlap it', () => {
    const guard = source.indexOf("showActivityDuration || sessionGoalGlyph || showInlineBranchMarker || renderContext === 'recent'");
    // The slot content fades out while the row is hovered (hideOnHoverClass)
    // and while the row menu is open — the same span that now carries the
    // recent timestamp.
    const hideOnHover = source.indexOf('hideOnHoverClass', guard);
    expect(hideOnHover).toBeGreaterThan(guard);
    expect(hideOnHover).toBeLessThan(source.indexOf("{renderContext === 'recent' ? (", guard));
  });

  test('the compact label uses the existing i18n-backed relative time helper', () => {
    // formatSessionCompactDateLabel (already used by touch runtimes and the
    // row tooltip) is the source of the label — no new formatting code.
    expect(source.indexOf('const sessionCompactUpdatedLabel = formatSessionCompactDateLabel(sessionTimestamp);')).toBeGreaterThan(-1);
    expect(source.indexOf('{sessionCompactUpdatedLabel}')).toBeGreaterThan(-1);
  });
});
