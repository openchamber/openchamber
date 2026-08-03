/** Kills autocorrect/autocomplete on URL/token/password fields — mobile keyboards
    mangle those values otherwise. */
export const mobileInputKeyboardProps = {
  autoComplete: 'off',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

export const mobileConnectionInputClass = 'h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20';
