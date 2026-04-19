"use client"

import * as React from "react";
import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";
import { cn } from "@/lib/utils";

const Collapsible = BaseCollapsible.Root;

type TriggerProps = React.ComponentProps<typeof BaseCollapsible.Trigger> & { asChild?: boolean };

const CollapsibleTrigger = ({
  className,
  asChild,
  children,
  ...props
}: TriggerProps) => {
  const renderProps: any = asChild && React.isValidElement(children)
    ? { render: children as React.ReactElement }
    : { children };
  return (
    <BaseCollapsible.Trigger
      className={cn(
        "flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary",
        className
      )}
      {...(props as any)}
      {...renderProps}
    />
  );
};

const CollapsibleContent = ({
  className,
  ...props
}: React.ComponentProps<typeof BaseCollapsible.Panel>) => (
  <BaseCollapsible.Panel
    className={cn("overflow-hidden data-[closed]:animate-collapsible-up data-[open]:animate-collapsible-down", className)}
    {...props}
  />
);

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
