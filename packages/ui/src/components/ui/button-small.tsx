import * as React from "react"
import { Button, type buttonVariants } from "./button"
import { cn } from "@/lib/utils"
import { type VariantProps } from "class-variance-authority"

function ButtonSmall({
  className,
  variant,
  size = "sm",
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return (
    <Button
      variant={variant}
      size={size}
      className={cn(size === "sm" && "h-7 px-2", className)}
      {...props}
    />
  )
}

export { ButtonSmall }
