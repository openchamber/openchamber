
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
