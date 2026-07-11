import * as React from "react";

type AnyProps = Record<string, unknown>;

function mergeRefs<T>(...refs: Array<React.Ref<T> | undefined>) {
  return (value: T) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(value);
      else (ref as React.MutableRefObject<T | null>).current = value;
    }
  };
}

function mergeProps(childProps: AnyProps, slotProps: AnyProps): AnyProps {
  const merged: AnyProps = { ...slotProps };
  for (const key in childProps) {
    const slotValue = slotProps[key];
    const childValue = childProps[key];
    if (/^on[A-Z]/.test(key) && typeof slotValue === "function" && typeof childValue === "function") {
      merged[key] = (...args: unknown[]) => {
        (childValue as (...a: unknown[]) => unknown)(...args);
        (slotValue as (...a: unknown[]) => unknown)(...args);
      };
    } else if (key === "className" && typeof slotValue === "string" && typeof childValue === "string") {
      merged[key] = `${childValue} ${slotValue}`;
    } else if (key === "style" && typeof slotValue === "object" && typeof childValue === "object") {
      merged[key] = { ...(childValue as object), ...(slotValue as object) };
    } else {
      merged[key] = childValue;
    }
  }
  return merged;
}

export interface SlotProps extends React.HTMLAttributes<HTMLElement> {
  children?: React.ReactNode;
}

export const Slot = React.forwardRef<HTMLElement, SlotProps>(function Slot(
  { children, ...slotProps },
  ref,
) {
  if (!React.isValidElement(children)) return null;
  const child = children as React.ReactElement<AnyProps & { ref?: React.Ref<unknown> }>;
  return React.cloneElement(child, {
    ...mergeProps(child.props as AnyProps, slotProps as AnyProps),
    ref: mergeRefs(ref as React.Ref<unknown>, (child as unknown as { ref?: React.Ref<unknown> }).ref),
  } as AnyProps);
});
