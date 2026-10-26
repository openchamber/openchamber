/** Kills autocorrect/autocomplete on URL/token/password fields — mobile keyboards
    mangle those values otherwise. */
export const mobileInputKeyboardProps = {
  autoComplete: 'off',
  autoCorrect: 'off',
  spellCheck: false,
} as const;

export const mobileConnectionInputClass = 'oc-surface-elevated h-12 w-full oc-raised oc-field rounded-[16px] bg-surface-elevated px-4 text-[16px] text-foreground outline-none placeholder:text-muted-foreground';
