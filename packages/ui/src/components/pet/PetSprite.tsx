import React from 'react';
import {
  PET_SPRITE_FRAME_COUNTS,
  PET_SPRITE_FRAME_HEIGHT,
  PET_SPRITE_FRAME_WIDTH,
  PET_SPRITE_LOOP_COUNT,
  PET_SPRITE_LOOP_MS,
  PET_SPRITE_ROWS,
  PET_STATE_TO_ROW,
  type PetDragDirection,
  type PetSpriteRow,
  type PetState,
} from '@/lib/pet/petContract';

// Base render scale for the 192x208 cell (~119x129 on screen) when no explicit
// scale is supplied (e.g. small settings thumbnails). The live pet passes its
// own scale derived from the (resizable) window size.
const DEFAULT_SCALE = 0.62;
// Floor for a single frame so a slow row still advances smoothly.
const MIN_FRAME_MS = 90;

export interface PetSpriteHandle {
  // Play `row` for `loops` passes, then settle back into the idle loop. Used for
  // transient interactions (wave on wake, jump on hover) that aren't state-driven.
  play: (row: PetSpriteRow, loops?: number) => void;
}

type SheetGrid = { cols: number; rows: number };
type Burst = { row: PetSpriteRow; loopsLeft: number };

const usePrefersReducedMotion = (): boolean => {
  const [reduced, setReduced] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(query.matches);
    const onChange = () => setReduced(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return reduced;
};

/**
 * Animates a Codex/petdex spritesheet by stepping the background position.
 *
 * Mirrors Codex's animation model:
 *  - `idle` loops forever using columns 0-5.
 *  - A non-idle semantic `state` (or an imperative play()) triggers a burst that
 *    plays the matching row PET_SPRITE_LOOP_COUNT times, then settles to idle.
 *  - `dragDirection` overrides everything with the running-left/right row and
 *    loops until the drag ends.
 *  - Under prefers-reduced-motion we render only the first frame of the row.
 *
 * Frame counts vary per row and the real grid is only known once the image
 * loads, so we drive a single self-rescheduling timeout (cheaper than injecting
 * per-row @keyframes) and read the live machine from refs.
 */
export const PetSprite = React.forwardRef<
  PetSpriteHandle,
  {
    spritesheetDataUrl: string;
    state: PetState;
    dragDirection?: PetDragDirection | null;
    scale?: number;
  }
>(function PetSprite({ spritesheetDataUrl, state, dragDirection = null, scale = DEFAULT_SCALE }, ref) {
  const [sheet, setSheet] = React.useState<SheetGrid | null>(null);
  const [display, setDisplay] = React.useState<{ rowIndex: number; frame: number }>({ rowIndex: 0, frame: 0 });
  const reducedMotion = usePrefersReducedMotion();

  // The animation machine lives in refs so the single ticker reads the latest
  // without re-subscribing on every state/interaction change.
  const burstRef = React.useRef<Burst | null>(null);
  const frameRef = React.useRef(0);

  // Geometry is convention (pet.json declares none): derive the grid from the
  // actual image so non-standard sheets still map rows/cols correctly.
  React.useEffect(() => {
    let active = true;
    const image = new Image();
    image.onload = () => {
      if (!active) return;
      setSheet({
        cols: Math.max(1, Math.floor(image.naturalWidth / PET_SPRITE_FRAME_WIDTH)),
        rows: Math.max(1, Math.floor(image.naturalHeight / PET_SPRITE_FRAME_HEIGHT)),
      });
    };
    image.src = spritesheetDataUrl;
    return () => {
      active = false;
    };
  }, [spritesheetDataUrl]);

  const play = React.useCallback((row: PetSpriteRow, loops = PET_SPRITE_LOOP_COUNT) => {
    burstRef.current = { row, loopsLeft: Math.max(1, loops) };
    frameRef.current = 0;
  }, []);
  React.useImperativeHandle(ref, () => ({ play }), [play]);

  // A non-idle state triggers a burst. We intentionally do NOT clear on idle:
  // an in-flight burst (e.g. the wake wave, or a running burst) is allowed to
  // finish and fall back into idle on its own, which avoids races with the
  // mount-time wave and matches Codex's "play N times, then idle" model.
  React.useEffect(() => {
    if (state === 'idle') return;
    play(PET_STATE_TO_ROW[state]);
  }, [state, play]);

  const frameCountFor = React.useCallback((row: PetSpriteRow, grid: SheetGrid): number => {
    const rowIndex = PET_SPRITE_ROWS.indexOf(row);
    if (rowIndex < 0 || rowIndex > grid.rows - 1) return 1;
    return Math.max(1, Math.min(PET_SPRITE_FRAME_COUNTS[row], grid.cols));
  }, []);

  const rowIndexFor = React.useCallback(
    (row: PetSpriteRow, grid: SheetGrid): number => Math.max(0, Math.min(PET_SPRITE_ROWS.indexOf(row), grid.rows - 1)),
    [],
  );

  // The row to show right now: drag override > active burst > idle.
  const resolveRow = React.useCallback((): PetSpriteRow => {
    if (dragDirection) return dragDirection === 'left' ? 'running-left' : 'running-right';
    if (burstRef.current) return burstRef.current.row;
    return 'idle';
  }, [dragDirection]);

  React.useEffect(() => {
    if (!sheet) return;

    // Reduced motion: hold the first frame of the current row, no ticking.
    if (reducedMotion) {
      frameRef.current = 0;
      setDisplay({ rowIndex: rowIndexFor(resolveRow(), sheet), frame: 0 });
      return;
    }

    let cancelled = false;
    let timer = 0;

    const tick = () => {
      if (cancelled) return;
      const row = resolveRow();
      const frameCount = frameCountFor(row, sheet);
      let frame = frameRef.current + 1;
      if (frame >= frameCount) {
        frame = 0;
        // A full pass completed. Drag + idle loop forever; a burst counts down
        // and clears back to idle once exhausted.
        if (!dragDirection && burstRef.current) {
          burstRef.current.loopsLeft -= 1;
          if (burstRef.current.loopsLeft <= 0) burstRef.current = null;
        }
      }
      // The burst may have just cleared (or a new one started): re-resolve so a
      // row switch restarts at frame 0 rather than indexing past the new row.
      const nextRow = resolveRow();
      if (nextRow !== row) frame = 0;
      frameRef.current = frame;
      setDisplay({ rowIndex: rowIndexFor(nextRow, sheet), frame });
      timer = window.setTimeout(tick, Math.max(MIN_FRAME_MS, Math.round(PET_SPRITE_LOOP_MS / frameCountFor(nextRow, sheet))));
    };

    // Seed the first visible frame immediately, then start ticking. Clamp the
    // carried-over frame to the resolved row's frame count first: a row switch
    // (e.g. the drag-override running rows have 8 frames, idle/running fewer)
    // must not index past the new row's columns — that paints an empty cell and
    // makes the pet blink out for a frame the moment a drag ends.
    const initialRow = resolveRow();
    if (frameRef.current >= frameCountFor(initialRow, sheet)) frameRef.current = 0;
    setDisplay({ rowIndex: rowIndexFor(initialRow, sheet), frame: frameRef.current });
    timer = window.setTimeout(tick, Math.max(MIN_FRAME_MS, Math.round(PET_SPRITE_LOOP_MS / frameCountFor(initialRow, sheet))));

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [sheet, reducedMotion, dragDirection, resolveRow, frameCountFor, rowIndexFor]);

  if (!sheet) return null;

  const frameW = PET_SPRITE_FRAME_WIDTH * scale;
  const frameH = PET_SPRITE_FRAME_HEIGHT * scale;

  return (
    <div
      aria-hidden
      style={{
        width: frameW,
        height: frameH,
        backgroundImage: `url(${spritesheetDataUrl})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${sheet.cols * frameW}px ${sheet.rows * frameH}px`,
        backgroundPositionX: `${-display.frame * frameW}px`,
        backgroundPositionY: `${-display.rowIndex * frameH}px`,
      }}
    />
  );
});
