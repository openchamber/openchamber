import React from 'react';

/**
 * Starfield Twinkle — a 4×4 grid of tiny dots that flicker
 * like stars in a night sky. Each dot has its own random phase
 * and duration so the pattern never looks mechanical.
 *
 * Corners are hidden (same as original) to soften the grid shape.
 */

const COLS = 4;
const ROWS = 4;
const SPACING = 3.2; // viewBox units between centers
const OFFSET = 2.7; // center the grid in 15×15
const DOT_R = 0.7; // small dot radius — star-like

const cornerIndices = new Set([0, 3, 12, 15]);

const stars = Array.from({ length: COLS * ROWS }, (_, i) => ({
  id: i,
  cx: (i % COLS) * SPACING + OFFSET,
  cy: Math.floor(i / COLS) * SPACING + OFFSET,
  isCorner: cornerIndices.has(i),
  // Each star gets its own rhythm — varying duration + delay
  duration: 2.4 + Math.random() * 2.4,
  delay: Math.random() * 3.5,
}));

export function GenericStatusSpinner({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 15 15"
      data-component="opencode-spinner"
      className={className}
      fill="var(--foreground)"
      aria-hidden="true"
    >
      {stars.map((star) => (
        <circle
          key={star.id}
          cx={star.cx}
          cy={star.cy}
          r={DOT_R}
          style={
            star.isCorner
              ? { opacity: 0 }
              : {
                  animation: `star-twinkle ${star.duration}s ease-in-out infinite`,
                  animationDelay: `${star.delay}s`,
                }
          }
        />
      ))}
    </svg>
  );
}
