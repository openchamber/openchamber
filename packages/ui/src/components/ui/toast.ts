"use client"

import { isValidElement } from "react"
import { toast as sonnerToast } from "sonner"
import type { ExternalToast } from "sonner"
import { copyTextToClipboard } from '@/lib/clipboard'

const copyToClipboard = async (text: string) => {
  const result = await copyTextToClipboard(text)
  if (!result.ok) {
    console.error('Failed to copy to clipboard:', result.error)
  }
}

const reactNodeToText = (value: React.ReactNode): string => {
  if (value == null || typeof value === "boolean") {
    return ""
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value)
  }
  if (Array.isArray(value)) {
    return value.map(reactNodeToText).join(" ").trim()
  }
  if (isValidElement(value)) {
    const element = value as React.ReactElement<{ children?: React.ReactNode }>
    return reactNodeToText(element.props?.children)
  }
  return ""
}

const resolveToastDescription = (description: ExternalToast["description"]): React.ReactNode => {
  if (typeof description === "function") {
    return description()
  }
  return description
}

const getToastCopyText = (message: string | React.ReactNode, data?: ExternalToast): string => {
  const descriptionText = reactNodeToText(resolveToastDescription(data?.description))
  if (descriptionText.length > 0) {
    return descriptionText
  }
  return reactNodeToText(message)
}

const DEFAULT_TOAST_DURATION_MS = 4000

const withCountdown = (data?: ExternalToast): ExternalToast => {
  const duration = data?.duration ?? DEFAULT_TOAST_DURATION_MS
  if (!Number.isFinite(duration)) return { ...data }
  return {
    ...data,
    className: [data?.className, "oc-toast-timed"].filter(Boolean).join(" "),
    style: Object.assign({}, data?.style, { "--oc-toast-duration": `${duration}ms` }),
  }
}

type ToastWithAction = (message: string | React.ReactNode, data?: ExternalToast) => string | number

type AppToast = Omit<typeof sonnerToast, 'success' | 'info' | 'error' | 'warning'> & {
  success: ToastWithAction
  info: ToastWithAction
  error: ToastWithAction
  warning: ToastWithAction
}

export const toast: AppToast = {
  ...sonnerToast,
  success: (message: string | React.ReactNode, data?: ExternalToast) => {
    return sonnerToast.success(message, withCountdown(data))
  },
  info: (message: string | React.ReactNode, data?: ExternalToast) => {
    return sonnerToast.info(message, withCountdown(data))
  },
  error: (message: string | React.ReactNode, data?: ExternalToast) => {
    return sonnerToast.error(message, {
      ...withCountdown(data),
      action: data?.action || {
        label: 'Copy',
        onClick: () => copyToClipboard(getToastCopyText(message, data)),
      },
    })
  },
  warning: (message: string | React.ReactNode, data?: ExternalToast) => {
    return sonnerToast.warning(message, {
      ...withCountdown(data),
      action: data?.action || {
        label: 'Copy',
        onClick: () => copyToClipboard(getToastCopyText(message, data)),
      },
    })
  },
}
