import type { Agent } from '@/lib/opencode/model';
import type { Theme } from '@/types/theme';
import { chromaticDistance, contrastRatio } from './theme/color';

/** `color` is a CSS color: a theme variable, or the hex the agent's config sets. */
export type AgentColor = { color: string };

const BUILD_COLOR: AgentColor = { color: 'var(--status-success)' };
const SYNTAX_COLORS = [
  { key: 'keyword', color: 'var(--syntax-keyword)' },
  { key: 'type', color: 'var(--syntax-type)' },
  { key: 'function', color: 'var(--syntax-function)' },
  { key: 'number', color: 'var(--syntax-number)' },
  { key: 'string', color: 'var(--syntax-string)' },
  { key: 'operator', color: 'var(--syntax-operator)' },
  { key: 'variable', color: 'var(--syntax-variable)' },
] as const;
const MIN_SEPARATION = 0.055;

/** OpenCode v2 stores an agent colour only as six-digit hex. */
const CONFIGURED_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
// OpenCode's v1 migration writes #aaaaaa for theme names it cannot keep
// ("primary", "accent"), so it stands for "no colour chosen", not grey.
const MIGRATED_COLOR_PLACEHOLDER = '#aaaaaa';

export const isAgentHexColor = (value: string): boolean => CONFIGURED_COLOR_PATTERN.test(value);

/** The colour set in the agent's config, when it is one OpenCode v2 accepts. */
export const configuredAgentColor = (color: string | null | undefined): string | null => {
  const value = color?.trim();
  if (!value || !isAgentHexColor(value) || value.toLowerCase() === MIGRATED_COLOR_PLACEHOLDER) return null;
  return value;
};

function hashName(name: string): number {
  let hash = 0;
  for (let index = 0; index < name.length; index++) hash = Math.imul(hash, 31) + name.charCodeAt(index) | 0;
  return hash >>> 0;
}

/** Allocate against the complete visible roster, never a filtered picker list.
 * Build owns success; other agents exhaust distinct syntax colors before reuse.
 * A colour set in an agent's config wins over the allocation, Build included;
 * the others keep the colours they would have had. */
export function createAgentColorResolver(theme: Theme, agents: readonly (Pick<Agent, 'name'> & Partial<Pick<Agent, 'mode' | 'color'>>)[]) {
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
    assigned.set(agent.name, { color: palette[index].color });
    used.add(index);
  }
  const configured = new Map<string, AgentColor>();
  for (const agent of agents) {
    const color = configuredAgentColor(agent.color);
    if (color) configured.set(agent.name, { color });
  }
  return (name: string | undefined): AgentColor => {
    const own = name ? configured.get(name) : undefined;
    if (own) return own;
    if (!name || name === 'build') return BUILD_COLOR;
    return assigned.get(name) ?? { color: palette[hashName(name) % palette.length].color };
  };
}
