/**
 * Resolve the behavior system prompt from the two sources that can carry it.
 *
 * The AGENTS.md file is the source of truth OpenCode reads at runtime, so an
 * existing file is authoritative even when it is empty; the persisted
 * `globalBehaviorPrompt` copy is only a fallback for a missing file or a
 * failed read.
 */

export type BehaviorPromptSource =
  | { readonly kind: 'file'; readonly content: string }
  | { readonly kind: 'missing' };

export function resolveBehaviorPrompt(
  source: BehaviorPromptSource,
  persistedPrompt: string | undefined,
): string {
  if (source.kind === 'file') {
    return source.content;
  }
  return persistedPrompt ?? '';
}
