import type { Agent } from '@/lib/opencode/model';
import type { Theme } from '@/types/theme';
import { chromaticDistance, contrastRatio } from './theme/color';

const BUILD_COLOR = { var: '--status-success', class: 'agent-success' } as const;
const SYNTAX_COLORS = [
  { key: 'keyword', var: '--syntax-keyword', class: 'agent-keyword' },
  { key: 'type', var: '--syntax-type', class: 'agent-type' },
  { key: 'function', var: '--syntax-function', class: 'agent-function' },
  { key: 'number', var: '--syntax-number', class: 'agent-number' },
  { key: 'string', var: '--syntax-string', class: 'agent-string' },
  { key: 'operator', var: '--syntax-operator', class: 'agent-operator' },
  { key: 'variable', var: '--syntax-variable', class: 'agent-variable' },
] as const;
const MIN_SEPARATION = 0.055;
type AgentColor = typeof BUILD_COLOR | (typeof SYNTAX_COLORS)[number];

function hashName(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index++) hash = Math.imul(hash, 31) + name.charCodeAt(index) | 0;
  return hash >>> 0;
}

/** Allocate against the complete visible roster, never a filtered picker list.
 * Build owns success; other agents exhaust distinct syntax colors before reuse. */
export function createAgentColorResolver(theme: Theme, agents: readonly (Pick<Agent, 'name'> & Partial<Pick<Agent, 'mode'>>)[]) {
  const { surface, syntax, status } = theme.colors;
  const backgrounds = [surface.background, surface.muted, surface.elevated];
  const distance = (a: string, b: string) => Math.min(...backgrounds.map((background) =>
    chromaticDistance(a, b, background, surface.background) ?? (a === b ? 0 : 1)));
  const candidates = SYNTAX_COLORS.map((color) => ({ ...color, value: syntax.base[color.key] }));
  const visible = candidates.filter((color) => backgrounds.every((background) =>
    (contrastRatio(color.value, background, surface.background) ?? 1.5) >= 1.5));
  const remaining = [...(visible.length ? visible : candidates)];
  const palette: typeof candidates = [];
  const chosen = [status.success];
  while (remaining.length) {
    let bestIndex = 0;
    let bestDistance = -1;
    for (let index = 0; index < remaining.length; index++) {
      const separation = Math.min(...chosen.map((value) => distance(remaining[index].value, value)));
      if (separation > bestDistance) { bestIndex = index; bestDistance = separation; }
    }
    if (bestDistance < MIN_SEPARATION) break;
    const [color] = remaining.splice(bestIndex, 1);
    palette.push(color);
    chosen.push(color.value);
  }
  // Monochrome or very sparse themes may have no alternative to success.
  // Reuse a syntax role rather than inventing an unrelated decorative color.
  if (!palette.length) palette.push(visible[0] ?? candidates[0]);

  const ordered = [...agents].sort((a, b) => Number(a.mode === 'subagent') - Number(b.mode === 'subagent')
    || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const assigned = new Map<string, AgentColor>();
  const used = new Set<number>();
  for (const agent of ordered) {
    if (agent.name === 'build' || assigned.has(agent.name)) continue;
    if (used.size === palette.length) used.clear();
    const available = palette.map((_, index) => index).filter((index) => !used.has(index));
    // Prefer colored syntax accents to the neutral code foreground while possible.
    const colorful = available.filter((index) => distance(palette[index].value, '#808080') >= 0.035);
    const choices = colorful.length ? colorful : available;
    const index = choices[hashName(agent.name) % choices.length];
    assigned.set(agent.name, palette[index]);
    used.add(index);
  }
  return (name: string | undefined) => {
    if (!name || name === 'build') return BUILD_COLOR;
    return assigned.get(name) ?? palette[hashName(name) % palette.length];
  };
}
