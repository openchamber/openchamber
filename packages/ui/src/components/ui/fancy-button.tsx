import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Slot } from "@/components/ui/slot";

// Flat tinted fancy-button: pale tinted fill + saturated tinted border +
// saturated tinted text. Matches the Button primitive design language.
const TINT_PRIMARY = [
  "bg-[color-mix(in_srgb,var(--primary-base)_10%,var(--background))]",
  "text-[var(--primary-base)]",
  "border border-[color-mix(in_srgb,var(--primary-base)_12%,transparent)]",
  "hover:bg-[color-mix(in_srgb,var(--primary-base)_16%,var(--background))]",
  "active:bg-[color-mix(in_srgb,var(--primary-base)_22%,var(--background))]",
  "dark:bg-[color-mix(in_srgb,var(--primary-base)_16%,transparent)]",
  "dark:border-[color-mix(in_srgb,var(--primary-base)_20%,transparent)]",
  "dark:hover:bg-[color-mix(in_srgb,var(--primary-base)_22%,transparent)]",
  "dark:active:bg-[color-mix(in_srgb,var(--primary-base)_30%,transparent)]",
].join(" ");

const TINT_DESTRUCTIVE = [
  "bg-[color-mix(in_srgb,var(--status-error)_7%,var(--background))]",
  "text-[var(--status-error)]",
  "border border-[color-mix(in_srgb,var(--status-error)_9%,transparent)]",
  "hover:bg-[color-mix(in_srgb,var(--status-error)_11%,var(--background))]",
  "active:bg-[color-mix(in_srgb,var(--status-error)_16%,var(--background))]",
  "dark:bg-[color-mix(in_srgb,var(--status-error)_9%,transparent)]",
  "dark:border-[color-mix(in_srgb,var(--status-error)_14%,transparent)]",
  "dark:hover:bg-[color-mix(in_srgb,var(--status-error)_14%,transparent)]",
  "dark:active:bg-[color-mix(in_srgb,var(--status-error)_20%,transparent)]",
].join(" ");

const fancyButtonRoot = cva(
  [
    "group relative inline-flex items-center justify-center whitespace-nowrap [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] typography-ui-label outline-none",
    "transition-[background-color,border-color,color,opacity] duration-150 ease-out",
    "focus:outline-none",
    "disabled:pointer-events-none disabled:text-muted-foreground/60",
    "disabled:bg-interactive-hover",
  ],
  {
    variants: {
      variant: {
        neutral:
          "bg-interactive-hover text-foreground border border-border/60 hover:bg-interactive-active",
        primary: TINT_PRIMARY,
        destructive: TINT_DESTRUCTIVE,
        basic:
          "bg-background text-foreground border border-border/60 hover:bg-interactive-hover hover:text-foreground",
      },
      size: {
        medium: "h-10 gap-3 rounded-[var(--radius-xl)] px-3.5",
        small: "h-9 gap-3 rounded-[var(--radius-lg)] px-3",
        xsmall: "h-8 gap-2 rounded-[var(--radius-lg)] px-2.5",
      },
    },
    defaultVariants: {
      variant: "neutral",
      size: "medium",
    },
  },
);

const fancyButtonIcon = cva("relative z-10 size-5 shrink-0", {
  variants: {
    size: {
      medium: "-mx-1",
      small: "-mx-1",
      xsmall: "-mx-1",
    },
  },
  defaultVariants: {
    size: "medium",
  },
});

type FancyButtonVariants = VariantProps<typeof fancyButtonRoot>;

type FancyButtonContextValue = Pick<FancyButtonVariants, "variant" | "size">;

const FancyButtonContext = React.createContext<FancyButtonContextValue>({});

type RootProps = FancyButtonVariants &
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    asChild?: boolean;
  };

const FancyButtonRoot = React.forwardRef<HTMLButtonElement, RootProps>(
  ({ asChild, children, variant, size, className, ...rest }, ref) => {
    const Component = (asChild ? Slot : "button") as React.ElementType;
    const ctx = React.useMemo<FancyButtonContextValue>(
      () => ({ variant, size }),
      [variant, size],
    );

    return (
      <FancyButtonContext.Provider value={ctx}>
        <Component
          ref={ref}
          className={cn(fancyButtonRoot({ variant, size }), className)}
          {...rest}
        >
          {children}
        </Component>
      </FancyButtonContext.Provider>
    );
  },
);
FancyButtonRoot.displayName = "FancyButton.Root";

type IconProps<T extends React.ElementType = "div"> = {
  as?: T;
  className?: string;
} & Omit<React.ComponentPropsWithoutRef<T>, "as" | "className">;

function FancyButtonIcon<T extends React.ElementType = "div">({
  as,
  className,
  ...rest
}: IconProps<T>) {
  const { size } = React.useContext(FancyButtonContext);
  const Component = (as ?? "div") as React.ElementType;
  return (
    <Component
      className={cn(fancyButtonIcon({ size }), className)}
      {...rest}
    />
  );
}
FancyButtonIcon.displayName = "FancyButton.Icon";

export { FancyButtonRoot as Root, FancyButtonIcon as Icon };
// eslint-disable-next-line react-refresh/only-export-components
export { fancyButtonRoot as fancyButtonVariants };
