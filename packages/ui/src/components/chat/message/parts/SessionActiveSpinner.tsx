import React from 'react';

/**
 * 5x5 grid letter patterns (indices 0-24).
 * Grid layout:
 *   0  1  2  3  4
 *   5  6  7  8  9
 *  10 11 12 13 14
 *  15 16 17 18 19
 *  20 21 22 23 24
 *
 * Each letter is represented as an array of "on" cell indices.
 */
const LETTER_PATTERNS: Record<string, readonly number[]> = {
  //       0  1  2  3  4
  //       5  6  7  8  9
  //      10 11 12 13 14
  //      15 16 17 18 19
  //      20 21 22 23 24
  A: [1, 2, 3, 5, 9, 10, 11, 12, 13, 14, 15, 19, 20, 24],
  B: [0, 1, 2, 3, 5, 9, 10, 11, 12, 13, 15, 19, 20, 21, 22, 23],
  C: [1, 2, 3, 5, 10, 15, 21, 22, 23],
  D: [0, 1, 2, 3, 5, 9, 10, 14, 15, 19, 20, 21, 22, 23],
  E: [0, 1, 2, 3, 5, 10, 11, 12, 15, 20, 21, 22, 23],
  F: [0, 1, 2, 3, 5, 10, 11, 12, 15, 20],
  G: [1, 2, 3, 5, 10, 12, 13, 15, 18, 19, 21, 22, 23],
  H: [0, 4, 5, 9, 10, 11, 12, 13, 14, 15, 19, 20, 24],
  I: [1, 2, 3, 7, 12, 17, 21, 22, 23],
  J: [1, 2, 3, 8, 13, 15, 18, 21, 22],
  K: [0, 3, 5, 7, 10, 11, 15, 17, 20, 23],
  L: [0, 5, 10, 15, 20, 21, 22, 23],
  M: [0, 4, 5, 6, 8, 9, 10, 12, 14, 15, 19, 20, 24],
  N: [0, 4, 5, 6, 9, 10, 12, 14, 15, 18, 19, 20, 24],
  O: [1, 2, 3, 5, 9, 10, 14, 15, 19, 21, 22, 23],
  P: [0, 1, 2, 3, 5, 8, 9, 10, 11, 12, 13, 15, 20],
  Q: [1, 2, 3, 5, 9, 10, 14, 15, 18, 19, 21, 22, 24],
  R: [0, 1, 2, 3, 5, 8, 9, 10, 11, 12, 13, 15, 17, 20, 23],
  S: [1, 2, 3, 5, 11, 12, 13, 19, 21, 22, 23],
  T: [0, 1, 2, 3, 4, 7, 12, 17, 22],
  U: [0, 4, 5, 9, 10, 14, 15, 19, 21, 22, 23],
  V: [0, 4, 5, 9, 10, 14, 16, 18, 22],
  W: [0, 4, 5, 9, 10, 12, 14, 15, 16, 18, 19, 21, 23],
  X: [0, 4, 6, 8, 12, 16, 18, 20, 24],
  Y: [0, 4, 6, 8, 12, 17, 22],
  Z: [0, 1, 2, 3, 4, 8, 12, 16, 20, 21, 22, 23, 24],
  '0': [1, 2, 3, 5, 9, 10, 14, 15, 19, 21, 22, 23],
  '1': [2, 6, 7, 12, 17, 20, 21, 22, 23, 24],
  '2': [1, 2, 3, 9, 11, 12, 13, 16, 20, 21, 22, 23, 24],
  '3': [0, 1, 2, 3, 9, 11, 12, 13, 19, 20, 21, 22, 23],
  '4': [0, 4, 5, 9, 10, 11, 12, 13, 14, 19, 24],
  '5': [0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 19, 20, 21, 22, 23],
  '6': [1, 2, 3, 5, 10, 11, 12, 13, 15, 19, 21, 22, 23],
  '7': [0, 1, 2, 3, 4, 9, 13, 17, 22],
  '8': [1, 2, 3, 5, 9, 11, 12, 13, 15, 19, 21, 22, 23],
  '9': [1, 2, 3, 5, 9, 11, 12, 13, 19, 21, 22, 23],
  ' ': [],
};

// Build Set versions for O(1) lookups
const LETTER_SETS: Record<string, Set<number>> = {};
for (const [key, indices] of Object.entries(LETTER_PATTERNS)) {
  LETTER_SETS[key] = new Set(indices);
}

/** Duration each letter is displayed (ms) */
const LETTER_DURATION_MS = 800;
/** Crossfade transition duration (ms) */
const TRANSITION_MS = 500;
/** Pause between full cycles (ms) */
const CYCLE_PAUSE_MS = 1000;

/** Spacing between dot centers in SVG units */
const DOT_SPACING = 4;
/** Dot radius */
const DOT_RADIUS = 1.2;

/**
 * Octagonal grid layout (7 rows):
 *
 *     • • •           row 0: 3 dots (cols 2-4)
 *   • • • • •         row 1: 5 dots (cols 1-5) → letter row 0
 * • • • • • • •       row 2: 7 dots (cols 0-6) → letter row 1
 * • • • • • • •       row 3: 7 dots (cols 0-6) → letter row 2
 * • • • • • • •       row 4: 7 dots (cols 0-6) → letter row 3
 *   • • • • •         row 5: 5 dots (cols 1-5) → letter row 4
 *     • • •           row 6: 3 dots (cols 2-4)
 *
 * Letter indices (0-24) map to the inner 5x5 zone:
 *   rows 1-5, cols 1-5
 */
const OCTAGON_ROWS: { row: number; cols: number[] }[] = [
  { row: 0, cols: [2, 3, 4] },
  { row: 1, cols: [1, 2, 3, 4, 5] },
  { row: 2, cols: [0, 1, 2, 3, 4, 5, 6] },
  { row: 3, cols: [0, 1, 2, 3, 4, 5, 6] },
  { row: 4, cols: [0, 1, 2, 3, 4, 5, 6] },
  { row: 5, cols: [1, 2, 3, 4, 5] },
  { row: 6, cols: [2, 3, 4] },
];

interface OctCell {
  id: number;
  cx: number;
  cy: number;
  /** Index into the 5x5 letter grid (0-24), or -1 for border-only dots */
  letterIndex: number;
  // Stable random timing
  shimmerDuration: number;
  shimmerDelay: number;
  idleDuration: number;
  idleDelay: number;
}

const CELLS: OctCell[] = [];
let cellId = 0;
for (const { row, cols } of OCTAGON_ROWS) {
  for (const col of cols) {
    const cx = col * DOT_SPACING;
    const cy = row * DOT_SPACING;

    // Letter zone: rows 1-5 (octagon), cols 1-5 (octagon)
    // maps to 5x5 letter index
    let letterIndex = -1;
    const letterRow = row - 1;
    const letterCol = col - 1;
    if (letterRow >= 0 && letterRow < 5 && letterCol >= 0 && letterCol < 5) {
      letterIndex = letterRow * 5 + letterCol;
    }

    CELLS.push({
      id: cellId++,
      cx,
      cy,
      letterIndex,
  shimmerDuration: 3 + Math.random() * 3,
  shimmerDelay: Math.random() * 3,
      idleDuration: 1 + Math.random(),
      idleDelay: Math.random() * 1.5,
    });
  }
}

const VIEW_SIZE = 6 * DOT_SPACING + DOT_RADIUS * 2;
const VIEW_OFFSET = -DOT_RADIUS;

interface SessionActiveSpinnerProps {
  className?: string;
  /** Text to spell out letter by letter. Falls back to idle pulse when empty/undefined. */
  text?: string;
}

/**
 * Idle mode: random pulsing octagonal dot grid.
 * Text mode: cycles through characters of `text`, morphing between letter shapes.
 */
export function SessionActiveSpinner({ className, text }: SessionActiveSpinnerProps) {
  const normalizedText = text?.toUpperCase().replace(/[^A-Z0-9 ]/g, '') || '';
  const hasText = normalizedText.length > 0;

  const [charIndex, setCharIndex] = React.useState(0);
  const [phase, setPhase] = React.useState<'hold' | 'morph'>('hold');

  // Intro fade: foreground starts invisible and fades in
  const [introReady, setIntroReady] = React.useState(false);
  React.useEffect(() => {
    const id = requestAnimationFrame(() => setIntroReady(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Reset on text change
  React.useEffect(() => {
    setCharIndex(0);
    setPhase('hold');
  }, [normalizedText]);

  // Letter cycling timer
  React.useEffect(() => {
    if (!hasText) return;

    const total = normalizedText.length;

    if (phase === 'hold') {
      const isLastChar = charIndex === total - 1;
      const delay = LETTER_DURATION_MS + (isLastChar ? CYCLE_PAUSE_MS : 0);
      const timer = setTimeout(() => setPhase('morph'), delay);
      return () => clearTimeout(timer);
    }

    const timer = setTimeout(() => {
      setCharIndex((prev) => (prev + 1) % total);
      setPhase('hold');
    }, TRANSITION_MS);
    return () => clearTimeout(timer);
  }, [hasText, charIndex, normalizedText, phase]);

  // Compute current and next letter sets for morphing
  const total = normalizedText.length;
  const currentSet = hasText
    ? (LETTER_SETS[normalizedText[charIndex]] ?? LETTER_SETS[' '])
    : null;
  const nextIndex = hasText ? (charIndex + 1) % total : 0;
  const nextSet = hasText
    ? (LETTER_SETS[normalizedText[nextIndex]] ?? LETTER_SETS[' '])
    : null;

  return (
    <svg
      viewBox={`${VIEW_OFFSET} ${VIEW_OFFSET} ${VIEW_SIZE} ${VIEW_SIZE}`}
      data-component="session-active-spinner"
      className={className}
      fill="var(--foreground)"
      aria-hidden="true"
    >
      {/* Background layer: all dots with shimmer animation */}
      {CELLS.map((cell) => (
        <circle
          key={cell.id}
          cx={cell.cx}
          cy={cell.cy}
          r={DOT_RADIUS}
          style={{
            animation: `${currentSet ? 'pulse-opacity-dim' : 'pulse-opacity'} ${currentSet ? cell.shimmerDuration : cell.idleDuration}s ease-in-out infinite`,
            animationDelay: `${currentSet ? cell.shimmerDelay : cell.idleDelay}s`,
            animationFillMode: 'both',
          }}
        />
      ))}

      {/* Foreground layer: morphing letter dots (only on letter-zone cells) */}
      <g fill="var(--primary)">
      {currentSet && nextSet && CELLS.map((cell) => {
        if (cell.letterIndex < 0) return null;

        const inCurrent = currentSet.has(cell.letterIndex);
        const inNext = nextSet.has(cell.letterIndex);

        if (!inCurrent && !inNext) return null;

        let opacity: number;
        if (!introReady) {
          opacity = 0;
        } else if (phase === 'hold') {
          opacity = inCurrent ? 1 : 0;
        } else {
          if (inCurrent && inNext) {
            opacity = 1;
          } else if (inCurrent) {
            opacity = 0;
          } else {
            opacity = 1;
          }
        }

        return (
          <circle
            key={`fg-${cell.id}`}
            cx={cell.cx}
            cy={cell.cy}
            r={DOT_RADIUS}
            style={{
              opacity,
              transition: `opacity ${TRANSITION_MS}ms ease-in-out`,
            }}
          />
        );
      })}
      </g>
    </svg>
  );
}
