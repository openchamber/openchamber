import { describe, expect, test } from 'bun:test';

import { resolveWorkStatusPresentation } from './presentation';

const base = {
  mountable: true,
  enabled: true,
  fits: true,
  measured: true,
  pinned: false,
  overlayOpen: false,
};

describe('work-status presentation', () => {
  test('docks the card while the layout gives it a column', () => {
    expect(resolveWorkStatusPresentation(base)).toEqual({ inline: true, overlay: false });
  });

  test('floats the pinned card when a surface takes the slot', () => {
    // The pin exists for this row: no column because a right-zone surface is
    // open, and the card must still be on screen.
    expect(resolveWorkStatusPresentation({ ...base, fits: false, pinned: true }))
      .toEqual({ inline: false, overlay: true });
  });

  test('leaves an unpinned card closed when a surface takes the slot', () => {
    expect(resolveWorkStatusPresentation({ ...base, fits: false }))
      .toEqual({ inline: false, overlay: false });
  });

  test('honours the header overlay toggle when the card is not pinned', () => {
    expect(resolveWorkStatusPresentation({ ...base, fits: false, overlayOpen: true }))
      .toEqual({ inline: false, overlay: true });
  });

  test('keeps the card docked while a column exists, pin or not', () => {
    expect(resolveWorkStatusPresentation({ ...base, pinned: true, overlayOpen: true }))
      .toEqual({ inline: true, overlay: false });
  });

  test('shows nothing on a surface that never hosts the panel', () => {
    expect(resolveWorkStatusPresentation({ ...base, mountable: false, pinned: true }))
      .toEqual({ inline: false, overlay: false });
  });

  test('shows nothing before the chat area has been measured', () => {
    // The first frame after a reload: `fits` is false because there is no width
    // yet, and a pinned card must not flash in its floating form before it docks.
    expect(resolveWorkStatusPresentation({ ...base, fits: false, measured: false, pinned: true }))
      .toEqual({ inline: false, overlay: false });
  });

  test('shows nothing while the user switch is off, pinned or not', () => {
    expect(resolveWorkStatusPresentation({ ...base, enabled: false, pinned: true }))
      .toEqual({ inline: false, overlay: false });
  });
});
