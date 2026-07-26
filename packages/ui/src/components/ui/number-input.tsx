import * as React from "react"

import { useDeviceInfo } from "@/lib/device"
import { useI18n } from "@/lib/i18n"
import { cn } from "@/lib/utils"
import { Icon } from "@/components/icon/Icon";

interface NumberInputProps
  extends Omit<React.ComponentProps<"input">, "value" | "onChange" | "type"> {
  value?: number
  onValueChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  containerClassName?: string
  fallbackValue?: number
  onClear?: () => void
  emptyLabel?: string
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function getStepDecimals(step: number) {
  if (!Number.isFinite(step)) return 0
  const stepString = String(step)
  if (stepString.includes("e-")) {
    const [, exp] = stepString.split("e-")
    return Number(exp) || 0
  }
  const parts = stepString.split(".")
  return parts.length === 2 ? parts[1]!.length : 0
}

function normalizeToStep(value: number, step: number) {
  const decimals = getStepDecimals(step)
  if (decimals <= 0) return value
  return Number(value.toFixed(decimals))
}

const NumberInput = React.forwardRef<HTMLInputElement, NumberInputProps>(
  (
    {
      value,
      onValueChange,
      min = -Infinity,
      max = Infinity,
      step = 1,
      className,
      containerClassName,
      onBlur,
      disabled,
      fallbackValue,
      onClear,
      emptyLabel = '—',
      ...props
    },
    ref
  ) => {
    const { t } = useI18n()
    const [draft, setDraft] = React.useState(() => (value == null ? '' : String(value)))
    const { isMobile } = useDeviceInfo()
    const ignoreNextClickRef = React.useRef(false)
    const swallowNextClickCleanupRef = React.useRef<(() => void) | null>(null)

    const swallowNextClick = React.useCallback(() => {
      if (typeof document === 'undefined' || typeof window === 'undefined') {
        return
      }

      swallowNextClickCleanupRef.current?.()

      const handleCaptureClick = (event: MouseEvent) => {
        event.preventDefault()
        event.stopPropagation()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ;(event as any).stopImmediatePropagation?.()
        swallowNextClickCleanupRef.current?.()
      }

      const timeoutId = window.setTimeout(() => {
        swallowNextClickCleanupRef.current?.()
      }, 700)

      const cleanup = () => {
        window.clearTimeout(timeoutId)
        document.removeEventListener('click', handleCaptureClick, true)
        swallowNextClickCleanupRef.current = null
      }

      swallowNextClickCleanupRef.current = cleanup
      document.addEventListener('click', handleCaptureClick, true)
    }, [])

    React.useEffect(() => {
      return () => {
        swallowNextClickCleanupRef.current?.()
      }
    }, [])

    React.useEffect(() => {
      setDraft(value == null ? '' : String(value))
    }, [value])

    const baseValue = React.useMemo(() => {
      if (value !== undefined) return value
      if (fallbackValue !== undefined) return fallbackValue
      if (Number.isFinite(min)) return min
      return 0
    }, [fallbackValue, min, value])

    // Tracks the most recent user-committed snapshot so back-to-back clicks
    // within the same render cycle operate on the latest value, not the stale
    // `value` prop (which only updates after the parent re-renders in response
    // to onValueChange). See packages/ui/src/components/ui/number-input.test.tsx.
    const committedValueRef = React.useRef<number>(baseValue)

    // Assumes a well-behaved controlled parent: when the parent updates the
    // `value` prop, the effect syncs the ref. If a parent ever rejects or
    // debounces `onValueChange`, the ref can briefly lead the prop. Today no
    // production caller rejects; revisit if a debounced caller is added.
    React.useEffect(() => {
      committedValueRef.current = baseValue
    }, [baseValue])

    const commitValue = React.useCallback(
      (rawValue: number) => {
        const clamped = clamp(rawValue, min, max)
        const normalized = normalizeToStep(clamped, step)
        committedValueRef.current = normalized
        onValueChange(normalized)
      },
      [max, min, onValueChange, step]
    )

    const handleChange = React.useCallback(
      (event: React.ChangeEvent<HTMLInputElement>) => {
        const nextDraft = event.target.value
        setDraft(nextDraft)

        if (nextDraft.trim() === '') {
          onClear?.()
          return
        }

        const parsed = Number(nextDraft)
        if (!Number.isFinite(parsed)) {
          return
        }

        commitValue(parsed)
      },
      [commitValue, onClear]
    )

    const handleBlur = React.useCallback(
      (event: React.FocusEvent<HTMLInputElement>) => {
        if (draft.trim() === '') {
          if (!onClear) {
            setDraft(value == null ? '' : String(value))
          }
          onBlur?.(event)
          return
        }

        const parsed = Number(draft)
        if (!Number.isFinite(parsed)) {
          setDraft(value == null ? '' : String(value))
        } else {
          const clamped = clamp(parsed, min, max)
          const normalized = normalizeToStep(clamped, step)
          if (normalized !== value) {
            // Route through commitValue so committedValueRef stays in sync with
            // the typed value. Without this, a typed-then-stepper sequence
            // would read a stale ref and drift. See number-input.test.tsx.
            commitValue(parsed)
          } else {
            // No effective change, but keep the ref aligned with the prop in
            // case it diverged via the baseValue useEffect.
            committedValueRef.current = normalized
          }
          setDraft(String(normalized))
        }

        onBlur?.(event)
      },
      [commitValue, draft, max, min, onBlur, onClear, step, value]
    )

    const incrementDisabled = Boolean(disabled || baseValue >= max)
    const decrementDisabled = Boolean(disabled || baseValue <= min)

    const handleMobileDecrement = () => {
      if (!decrementDisabled) {
        commitValue(committedValueRef.current - step)
      }
    }

    const handleMobileIncrement = () => {
      if (!incrementDisabled) {
        commitValue(committedValueRef.current + step)
      }
    }

    const handleMobileTouchActivate = (handler: () => void) => (event: React.TouchEvent) => {
      event.preventDefault()
      event.stopPropagation()
      // Touch on iOS often triggers a follow-up click; ignore it.
      ignoreNextClickRef.current = true
      // Also swallow the synthetic click anywhere (prevents layout-shift clicks).
      swallowNextClick()
      handler()
    }

    const handleMobileClickActivate = (handler: () => void) => (event: React.MouseEvent) => {
      if (ignoreNextClickRef.current) {
        ignoreNextClickRef.current = false
        event.preventDefault()
        event.stopPropagation()
        return
      }
      handler()
    }

    if (isMobile) {
      return (
        <div
          className={cn(
            // NOTE: mobile.css enforces min-height:36px on buttons; match it to avoid clipping.
            "flex h-8 shrink-0 items-stretch overflow-x-hidden overflow-y-hidden rounded-lg border border-border bg-transparent select-none overscroll-contain",
            "[-webkit-user-select:none] [-webkit-touch-callout:none]",
            "disabled:pointer-events-none disabled:opacity-50",
            containerClassName
          )}
        >
          <button
            type="button"
            aria-label={t('numberInput.actions.decreaseAria')}
            disabled={decrementDisabled}
            onTouchStart={handleMobileTouchActivate(handleMobileDecrement)}
            onClick={handleMobileClickActivate(handleMobileDecrement)}
            className={cn(
              "grid h-full min-h-0 w-9 shrink-0 place-items-center overflow-x-hidden overflow-y-hidden border-r border-border p-0 leading-none touch-none",
              "text-muted-foreground",
              "disabled:pointer-events-none disabled:opacity-50",
              !decrementDisabled && "active:bg-interactive-hover"
            )}
          >
            <Icon name="subtract" className="block h-4 w-4" />
          </button>

          <div
            className={cn(
              "flex h-full min-w-0 flex-1 items-center justify-center bg-transparent px-1.5",
              "text-center text-[16px] leading-none text-foreground [font-variant-numeric:tabular-nums]",
              className
            )}
            aria-live="polite"
          >
            {value == null ? emptyLabel : draft}
          </div>

          <button
            type="button"
            aria-label={t('numberInput.actions.increaseAria')}
            disabled={incrementDisabled}
            onTouchStart={handleMobileTouchActivate(handleMobileIncrement)}
            onClick={handleMobileClickActivate(handleMobileIncrement)}
            className={cn(
              "grid h-full min-h-0 w-9 shrink-0 place-items-center overflow-x-hidden overflow-y-hidden border-l border-border p-0 leading-none touch-none",
              "text-muted-foreground",
              "disabled:pointer-events-none disabled:opacity-50",
              !incrementDisabled && "active:bg-interactive-hover"
            )}
          >
            <Icon name="add" className="block h-4 w-4" />
          </button>
        </div>
      )
    }

    return (
      <div
        className={cn(
          "flex h-8 shrink-0 items-stretch overflow-x-hidden overflow-y-hidden rounded-md border border-border bg-transparent",
          "disabled:pointer-events-none disabled:opacity-50",
          "transition-[background-color,border-color,box-shadow] duration-150 ease-in-out",
          containerClassName
        )}
      >
        <button
          type="button"
          aria-label={t('numberInput.actions.decreaseAria')}
          disabled={decrementDisabled}
          onClick={() => commitValue(committedValueRef.current - step)}
          className={cn(
            "flex h-full w-7 shrink-0 items-center justify-center overflow-x-hidden overflow-y-hidden border-r border-border p-0 leading-none touch-manipulation",
            "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-50",
            "transition-colors duration-150 ease-in-out"
          )}
        >
          <Icon name="subtract" className="block h-3.5 w-3.5" />
        </button>
        <input
          {...props}
          ref={ref}
          type="text"
          inputMode={props.inputMode ?? 'numeric'}
          value={draft}
          onChange={handleChange}
          onBlur={handleBlur}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          className={cn(
            "h-full min-w-0 w-10 flex-1 bg-transparent px-1.5 text-center typography-ui-label leading-none text-foreground [font-variant-numeric:tabular-nums]",
            "placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground",
            "appearance-none outline-none [appearance:textfield] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
            "disabled:pointer-events-none disabled:cursor-not-allowed",
            className
          )}
        />
        <button
          type="button"
          aria-label={t('numberInput.actions.increaseAria')}
          disabled={incrementDisabled}
          onClick={() => commitValue(committedValueRef.current + step)}
          className={cn(
            "flex h-full w-7 shrink-0 items-center justify-center overflow-x-hidden overflow-y-hidden border-l border-border p-0 leading-none touch-manipulation",
            "text-muted-foreground hover:bg-interactive-hover hover:text-foreground",
            "disabled:pointer-events-none disabled:opacity-50",
            "transition-colors duration-150 ease-in-out"
          )}
        >
          <Icon name="add" className="block h-3.5 w-3.5" />
        </button>
      </div>
    )
  }
)
NumberInput.displayName = "NumberInput"

export { NumberInput }
