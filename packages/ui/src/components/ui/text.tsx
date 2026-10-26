import * as React from "react";
import { motion, type MotionProps } from "motion/react";
import { cn } from "@/lib/utils";

type Variant = {
  variant: string;
  component: React.FC<React.ComponentProps<"span"> & Partial<MotionProps>>;
};

const variants = [
  {
    variant: "static",
    component: ({ children, className, ...props }) => (
      <span {...props} className={className}>
        {children}
      </span>
    ),
  },
  {
    variant: "generate-effect",
    // One CSS sweep over the whole text (`.oc-text-generate` in index.css),
    // not a span and a JS animation per character: streaming tool rows
    // mount these constantly, and the per-character version cost a quarter
    // of the main thread's work in an agent run. The sweep plays once on mount;
    // text that changes afterwards (a title resolving on completion)
    // updates in place without replaying it.
    component: ({ children, className, ...props }) => {
      if (children === null || children === undefined || children === "") return null;

      return (
        <span {...props} className={cn("oc-text-generate inline-block align-baseline", className)}>
          {children}
        </span>
      );
    },
  },
  {
    variant: "glitch",
    component: ({ children, className, ...props }) => (
      <div className="group relative overflow-hidden font-medium">
        <span {...props} className={cn("invisible", className)}>
          {children}
        </span>
        <span
          {...props}
          className={cn(
            "absolute top-0 inset-s-0 text-primary-muted transition-transform duration-500 ease-in-out",
            "group-hover:-translate-y-full hover:duration-300",
            className
          )}
        >
          {children}
        </span>
        <span
          {...props}
          className={cn(
            "absolute top-0 inset-s-0 translate-y-full text-primary-muted transition-transform duration-500",
            "ease-in-out hover:duration-300 group-hover:translate-y-0",
            className
          )}
        >
          {children}
        </span>
      </div>
    ),
  },
  {
    variant: "hover-enter",
    component: ({ children, className, ...props }) => {
      if (typeof children !== "string") return null;

      const DURATION = 0.25;
      const STAGGER = 0.025;

      const letters = children
        .split("")
        .map((letter) => (letter === " " ? "\u00A0" : letter));

      return (
        <motion.span
          {...props}
          className={cn(
            "relative block select-none overflow-hidden whitespace-nowrap text-primary-muted",
            className
          )}
          initial="initial"
          whileHover="hovered"
          style={{ lineHeight: 0.9 }}
        >
          <div>
            {letters.map((letter, i) => (
              <motion.span
                key={String(i)}
                className="inline-block"
                variants={{
                  initial: { y: 0 },
                  hovered: { y: "-100%" },
                }}
                transition={{
                  duration: DURATION,
                  ease: "easeInOut",
                  delay: STAGGER * i,
                }}
              >
                {letter}
              </motion.span>
            ))}
          </div>
          <div className={cn("absolute inset-0")}>
            {letters.map((letter, i) => (
              <motion.span
                key={String(i)}
                className="inline-block"
                variants={{
                  initial: { y: "100%" },
                  hovered: { y: 0 },
                }}
                transition={{
                  duration: DURATION,
                  ease: "easeInOut",
                  delay: STAGGER * i,
                }}
              >
                {letter}
              </motion.span>
            ))}
          </div>
        </motion.span>
      );
    },
  },
  {
    variant: "shake",
    component: ({ children, className, ...props }) => (
      <span
        {...props}
        className={cn("text-primary-muted hover:animate-text-shake", className)}
      >
        {children}
      </span>
    ),
  },
  {
    variant: "hover-decoration",
    component: ({ children, className, ...props }) => (
      <div
        className={cn(
          "relative after:absolute after:bottom-0 after:inset-s-0 after:h-px after:w-full after:origin-bottom-right",
          "after:scale-x-0 after:bg-primary-muted after:transition-transform after:duration-300 after:ease-in-out hover:after:origin-bottom-left hover:after:scale-x-100"
        )}
      >
        <span {...props} className={cn("text-primary-muted", className)}>
          {children}
        </span>
      </div>
    ),
  },
] as const satisfies readonly Variant[];

export type TextProps = {
  variant?: (typeof variants)[number]["variant"];
} & React.ComponentProps<"span"> &
  Partial<MotionProps>;

export function Text({ variant = "static", className, ...props }: TextProps) {
  const variantComponent = variants.find((v) => v.variant === variant)?.component;

  const Component = variantComponent || variants[0].component;

  return <Component {...props} className={className} />;
}
