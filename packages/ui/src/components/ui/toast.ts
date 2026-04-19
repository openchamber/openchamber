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

type ToastMessage = Parameters<typeof sonnerToast.success>[0]
type ToastResult = ReturnType<typeof sonnerToast.success>

const toastMessageToText = (value: ToastMessage): string => {
  if (typeof value === 'function') {
    return reactNodeToText(value())
  }
  return reactNodeToText(value)
}

const resolveToastDescription = (description: ExternalToast["description"]): React.ReactNode => {
  if (typeof description === "function") {
    return description()
  }
  return description
}

const getToastCopyText = (message: ToastMessage, data?: ExternalToast): string => {
  const descriptionText = reactNodeToText(resolveToastDescription(data?.description))
  if (descriptionText.length > 0) {
    return descriptionText
  }
  return toastMessageToText(message)
}

// Wrapper to automatically add OK button to success and info toasts, Copy button to error and warning toasts
export const toast = Object.assign(sonnerToast, {
  success: (message: ToastMessage, data?: ExternalToast): ToastResult => {
    return sonnerToast.success(message, {
      ...data,
      action: data?.action || {
        label: 'OK',
        onClick: () => {},
      },
    })
  },
  info: (message: ToastMessage, data?: ExternalToast): ToastResult => {
    return sonnerToast.info(message, {
      ...data,
      action: data?.action || {
        label: 'OK',
        onClick: () => {},
      },
    })
  },
  error: (message: ToastMessage, data?: ExternalToast): ToastResult => {
    return sonnerToast.error(message, {
      ...data,
      action: data?.action || {
        label: 'Copy',
        onClick: () => copyToClipboard(getToastCopyText(message, data)),
      },
    })
  },
  warning: (message: ToastMessage, data?: ExternalToast): ToastResult => {
    return sonnerToast.warning(message, {
      ...data,
      action: data?.action || {
        label: 'Copy',
        onClick: () => copyToClipboard(getToastCopyText(message, data)),
      },
    })
  },
}) as typeof sonnerToast
