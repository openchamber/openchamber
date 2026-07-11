/**
 * GitHub-style 5×5 mirrored identicon from an agent name seed.
 * Same seed always yields the same matrix — no network / no avatar CDN.
 */

const GRID = 5;
const HALF = Math.ceil(GRID / 2);

/** Stable 32-bit hash for avatar geometry (independent of agent color hashing). */
export function hashAgentSeed(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash << 5) - hash + seed.charCodeAt(i);
    hash |= 0;
  }
  return hash >>> 0;
}

/**
 * Build a 5×5 boolean matrix: left 3 columns from hash bits, right side mirrors left.
 * Empty / missing seed → empty matrix (caller can still render a tinted plate).
 */
export function getAgentIdenticonMatrix(seed: string | undefined): boolean[][] {
  const matrix: boolean[][] = Array.from({ length: GRID }, () => Array.from({ length: GRID }, () => false));
  if (!seed) {
    return matrix;
  }

  let bits = hashAgentSeed(seed);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < HALF; x++) {
      const on = (bits & 1) === 1;
      bits >>>= 1;
      matrix[y][x] = on;
      matrix[y][GRID - 1 - x] = on;
    }
  }
  return matrix;
}
