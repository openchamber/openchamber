import * as React from "react"
import { Dialog as BaseDialog } from "@base-ui/react/dialog"
import { RiCloseLine } from '@remixicon/react';

import { cn } from "@/lib/utils"

let openDialogCount = 0;

type AsChildProps = { asChild?: boolean };

function renderFromAsChild(asChild: boolean | undefined, children: React.ReactNode) {
  if (asChild && React.isValidElement(children)) return { render: children as React.ReactElement };
  return { children };
}

function Dialog({
  ...props
}: React.ComponentProps<typeof BaseDialog.Root>) {
  return <BaseDialog.Root {...props} />
}

function DialogTrigger({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof BaseDialog.Trigger> & AsChildProps) {
  const r = renderFromAsChild(asChild, children);
  return <BaseDialog.Trigger data-slot="dialog-trigger" {...(props as any)} {...(r as any)} />
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof BaseDialog.Portal>) {
  return <BaseDialog.Portal {...props} />
}

function DialogClose({
  asChild,
  children,
  ...props
}: React.ComponentProps<typeof BaseDialog.Close> & AsChildProps) {
  const r = renderFromAsChild(asChild, children);
  return <BaseDialog.Close data-slot="dialog-close" {...(props as any)} {...(r as any)} />
}

const DialogOverlay = React.forwardRef<
  HTMLDivElement,
  React.ComponentPropsWithoutRef<typeof BaseDialog.Backdrop>
>(({ className, ...props }, ref) => {
  React.useEffect(() => {
    openDialogCount += 1;
    document.documentElement.classList.add('oc-dialog-open');
    return () => {
      openDialogCount = Math.max(0, openDialogCount - 1);
      if (openDialogCount === 0) {
        document.documentElement.classList.remove('oc-dialog-open');
      }
    };
  }, []);

  return (
    <BaseDialog.Backdrop
      ref={ref as React.Ref<HTMLDivElement>}
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 dark:bg-black/75",
        className
      )}
      {...props}
    />
  )
});
DialogOverlay.displayName = "DialogOverlay";

type DialogContentProps = Omit<React.ComponentProps<typeof BaseDialog.Popup>, "children"> & {
  showCloseButton?: boolean
  keyboardAvoid?: boolean
  children?: React.ReactNode
  onOpenAutoFocus?: (event: Event) => void
  onCloseAutoFocus?: (event: Event) => void
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  keyboardAvoid = false,
  onOpenAutoFocus: _onOpenAutoFocus,
  onCloseAutoFocus: _onCloseAutoFocus,
  ...props
}: DialogContentProps) {
  return (
    <DialogPortal>
      <DialogOverlay className="rounded-none" />
      <BaseDialog.Popup
        data-slot="dialog-content"
        data-state-slot="dialog"
        data-keyboard-avoid={keyboardAvoid ? "true" : undefined}
        className={cn(
          "bg-background text-foreground fixed top-[50%] left-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 rounded-xl border p-6 shadow-none overflow-hidden pwa-dialog-content",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <BaseDialog.Close
            data-slot="dialog-close"
            className="ring-offset-background focus:ring-ring data-[open]:bg-interactive-active data-[open]:text-foreground absolute top-2 right-2 rounded-lg opacity-70 transition-opacity hover:opacity-100 focus:ring-2 focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none text-muted-foreground hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <RiCloseLine/>
            <span className="sr-only">Close</span>
          </BaseDialog.Close>
        )}
      </BaseDialog.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  )
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-2 bottom-safe-area sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    />
  )
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Title>) {
  return (
    <BaseDialog.Title
      data-slot="dialog-title"
      className={cn("typography-markdown leading-none font-semibold text-foreground", className)}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof BaseDialog.Description>) {
  return (
    <BaseDialog.Description
      data-slot="dialog-description"
      className={cn("text-muted-foreground typography-ui-label", className)}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
