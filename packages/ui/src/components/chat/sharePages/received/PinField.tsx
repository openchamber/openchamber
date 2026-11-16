import React from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const LENGTH = 6;

/**
 * The six-digit PIN of a shared page, the way the relay's viewer asks for it:
 * one box per digit, the phone's one-time-code fill on the first, a paste
 * spread over the boxes, Backspace stepping back, and the PIN sent as soon as
 * the sixth digit lands. Digits read left to right in every language.
 */
export function PinField({ onComplete, disabled, invalid, resetKey }: {
  onComplete: (pin: string) => void;
  disabled?: boolean;
  /** The last PIN was wrong: the boxes are drawn as refused until the next digit. */
  invalid?: boolean;
  /** Changing it empties the boxes and focuses the first one (after a refused PIN). */
  resetKey?: number;
}) {
  const { t } = useI18n();
  const [digits, setDigits] = React.useState<string[]>(() => Array(LENGTH).fill(''));
  const [edited, setEdited] = React.useState(false);
  const inputs = React.useRef<Array<HTMLInputElement | null>>([]);

  React.useEffect(() => {
    if (resetKey === undefined) return;
    setDigits(Array(LENGTH).fill(''));
    setEdited(false);
    inputs.current[0]?.focus();
  }, [resetKey]);

  const fill = (incoming: string, from: number) => {
    const next = [...digits];
    const typed = incoming.replace(/\D/g, '').split('');
    typed.forEach((digit, offset) => {
      if (from + offset < LENGTH) next[from + offset] = digit;
    });
    setDigits(next);
    setEdited(true);
    inputs.current[Math.min(from + typed.length, LENGTH - 1)]?.focus();
    if (next.every(Boolean)) onComplete(next.join(''));
  };

  return (
    <div dir="ltr" className="flex items-center gap-1" role="group" aria-label={t('chat.sharedPage.pin.label')}>
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(node) => { inputs.current[index] = node; }}
          value={digit}
          disabled={disabled}
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          maxLength={LENGTH}
          aria-label={t('chat.sharedPage.pin.digit', { n: index + 1 })}
          aria-invalid={invalid && !edited ? true : undefined}
          className={cn(
            'oc-raised oc-field h-7 w-6 rounded-md bg-[var(--surface-elevated)] p-0 text-center font-mono text-sm text-foreground outline-none',
            'pointer-coarse:h-9 pointer-coarse:w-8 disabled:opacity-50',
          )}
          onChange={(event) => {
            const typed = event.target.value.replace(/\D/g, '');
            if (typed) fill(typed.slice(digit && typed.length > 1 ? 1 : 0), index);
            else {
              const next = [...digits];
              next[index] = '';
              setDigits(next);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && !digit && index > 0) {
              event.preventDefault();
              const next = [...digits];
              next[index - 1] = '';
              setDigits(next);
              inputs.current[index - 1]?.focus();
            }
            // Enter belongs to the PIN here, not to the composer's send.
            if (event.key === 'Enter') {
              event.preventDefault();
              event.stopPropagation();
              if (digits.every(Boolean)) onComplete(digits.join(''));
            }
          }}
          onPaste={(event) => {
            const pasted = event.clipboardData.getData('text').replace(/\D/g, '');
            if (!pasted) return;
            event.preventDefault();
            event.stopPropagation();
            fill(pasted, index);
          }}
          onFocus={(event) => event.currentTarget.select()}
        />
      ))}
    </div>
  );
}
