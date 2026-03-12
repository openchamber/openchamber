import * as React from "react";
import { motion, type MotionProps } from "motion/react";
import * as Slot from "@radix-ui/react-slot";

import { cn } from "@/lib/utils";

type Variant = {
  variant: string;
  component: React.FC<React.ComponentProps<"span"> & Partial<MotionProps>>;
};

const variants = [
  {
    variant: "shine",
    component: ({ children, className, ...props }) => (
        <motion.span
          {...props}
          className={cn(
            "bg-[linear-gradient(110deg,color-mix(in_srgb,var(--surface-muted-foreground)_45%,transparent),35%,var(--surface-foreground),50%,color-mix(in_srgb,var(--surface-muted-foreground)_45%,transparent),75%,color-mix(in_srgb,var(--surface-muted-foreground)_45%,transparent))]",
            "bg-[length:200%_100%] bg-clip-text text-transparent",
            className
          )}
        initial={{ backgroundPosition: "200% 0" }}
        animate={{ backgroundPosition: "-200% 0" }}
        transition={{
          repeat: Number.POSITIVE_INFINITY,
          duration: 2,
          ease: "linear",
        }}
      >
        {children}
      </motion.span>
    ),
  },
  {
    variant: "generate-effect",
    component: ({ children, className, ...props }) => {
      if (children === null || typeof children === "undefined") return null;

      const textContent =
        typeof children === "string"
          ? children
          : typeof children === "number"
            ? String(children)
            : Array.isArray(children)
              ? children
                  .map((item) =>
                    typeof item === "string" || typeof item === "number"
                      ? String(item)
                      : ""
                  )
                  .join("")
              : "";

      if (!textContent) return null;

      return (
        <span className={cn("inline-block align-baseline", className)}>
          {textContent.split("").map((char, index) => (
            <motion.span
              {...props}
              key={char + String(index)}
              className={cn(
                "inline-block whitespace-pre align-baseline"
              )}
              initial={{ opacity: 0, filter: "blur(3px)" }}
              animate={{
                opacity: 1,
                filter: "blur(0px)",
              }}
              transition={{
                ease: "easeOut",
                duration: 0.14,
                delay: Math.min(index * 0.0045, 0.14),
              }}
            >
              {char}
            </motion.span>
          ))}
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
            "absolute top-0 left-0 text-primary-muted transition-transform duration-500 ease-in-out",
            "group-hover:-translate-y-full hover:duration-300",
            className
          )}
        >
          {children}
        </span>
        <span
          {...props}
          className={cn(
            "absolute top-0 left-0 translate-y-full text-primary-muted transition-transform duration-500",
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
          "relative after:absolute after:bottom-0 after:left-0 after:h-px after:w-full after:origin-bottom-right",
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

export function Text({ variant = "shine", className, ...props }: TextProps) {
  const FALLBACK_INDEX = 0;

  const variantComponent = variants.find((v) => v.variant === variant)?.component;

  const Component = variantComponent || variants[FALLBACK_INDEX].component;

  return (
    <Slot.Root>
      <Component {...props} className={className} />
    </Slot.Root>
  );
}
