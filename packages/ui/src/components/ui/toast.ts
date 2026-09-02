"use client"

import { isValidElement, type MouseEvent, type ReactNode } from "react"
import { toast as sonnerToast } from "sonner"
import type { ExternalToast } from "sonner"
import { copyTextToClipboard } from '@/lib/clipboard'
import { formatMessage, useI18nStore } from '@/lib/i18n'
import { flattenNotificationText, sanitizeNotificationText } from '@/sync/notification-record'
import {
  appendNotification,
  markNotificationRead,
  type NotificationAction,
  type NotificationSource,
  type NotificationSeverity,
} from '@/sync/notification-store'

export type OpenChamberToastOptions = ExternalToast & {
  persist?: boolean
  session?: string
  directory?: string
  source?: NotificationSource
  actionRecord?: NotificationAction
  dedupeKey?: string
}

type ToastAction = {
  label: ReactNode
  onClick: (event: MouseEvent<HTMLButtonElement>) => void
}

const copyToClipboard = async (text: string) => {
  const result = await copyTextToClipboard(text)
  if (!result.ok) {
    console.error('Failed to copy to clipboard:', result.error)
  }
}

const resolveToastDescription = (description: ExternalToast["description"]): ReactNode => {
  if (description == null) return undefined
  if (Array.isArray(description) || isValidElement(description)) return description
  const asText = String(description)
  if (description === asText) return asText
  if (description === true || description === false) return description
  const numeric = Number(description)
  if (description === numeric && Number.isFinite(numeric)) return numeric
  return undefined
}

const getToastCopyText = (message: string | ReactNode, data?: ExternalToast): string => {
  const descriptionText = flattenNotificationText(resolveToastDescription(data?.description))
  if (descriptionText.length > 0) {
    return descriptionText
  }
  return flattenNotificationText(message)
}

const toastActionLabel = (key: 'toast.action.ok' | 'toast.action.copy'): string => (
  formatMessage(useI18nStore.getState().dictionary, key)
)

const parseToastAction = (value: ExternalToast["action"]): ToastAction | null => {
  if (value == null || Array.isArray(value)) return null
  if (!Object.prototype.hasOwnProperty.call(value, 'onClick')) return null
  // SAFETY: hasOwnProperty.call above confirmed this toast action owns onClick.
  return value as ToastAction
}

export const closeRecordedToast = (
  notificationId: string | null,
  closedByTimeout: boolean,
): void => {
  if (notificationId && !closedByTimeout) markNotificationRead(notificationId)
}

const wrapToastAction = (action: ToastAction, notificationId: string | null): ToastAction => {
  if (!notificationId) return action
  return {
    ...action,
    onClick: (event) => {
      markNotificationRead(notificationId)
      action.onClick(event)
    },
  }
}

const recordToast = (
  severity: NotificationSeverity,
  message: string | ReactNode,
  data: OpenChamberToastOptions | undefined,
): string | null => {
  if (data?.persist === false) return null
  const title = sanitizeNotificationText(message)
  const body = sanitizeNotificationText(resolveToastDescription(data?.description))
  if (!title && !body) return data?.id != null ? String(data.id) : null
  const recorded = appendNotification({
    id: data?.id != null ? String(data.id) : undefined,
    title: title || body,
    body: title ? body : '',
    severity,
    source: data?.source ?? 'toast',
    session: data?.session,
    directory: data?.directory,
    action: data?.actionRecord,
    dedupeKey: data?.dedupeKey,
  })
  return recorded?.id ?? null
}

const showRecordedToast = (
  severity: NotificationSeverity,
  show: (message: string | ReactNode, data?: ExternalToast) => string | number,
  defaultAction: (message: string | ReactNode, data?: OpenChamberToastOptions) => ToastAction,
  message: string | ReactNode,
  data?: OpenChamberToastOptions,
) => {
  const notificationId = recordToast(severity, message, data)
  let closedByTimeout = false
  const callerAction = parseToastAction(data?.action)
  const action = wrapToastAction(callerAction ?? defaultAction(message, data), notificationId)
  const toastData: ExternalToast = {
    ...data,
    action,
    onAutoClose: (toastItem) => {
      closedByTimeout = true
      data?.onAutoClose?.(toastItem)
    },
    onDismiss: (toastItem) => {
      closeRecordedToast(notificationId, closedByTimeout)
      data?.onDismiss?.(toastItem)
    },
  }
  if (notificationId) toastData.id = notificationId
  return show(message, toastData)
}

export const toast = {
  ...sonnerToast,
  success: (message: string | ReactNode, data?: OpenChamberToastOptions) => showRecordedToast(
    'success',
    sonnerToast.success,
    () => ({ label: toastActionLabel('toast.action.ok'), onClick: () => {} }),
    message,
    data,
  ),
  info: (message: string | ReactNode, data?: OpenChamberToastOptions) => showRecordedToast(
    'info',
    sonnerToast.info,
    () => ({ label: toastActionLabel('toast.action.ok'), onClick: () => {} }),
    message,
    data,
  ),
  error: (message: string | ReactNode, data?: OpenChamberToastOptions) => showRecordedToast(
    'error',
    sonnerToast.error,
    (toastMessage, toastData) => ({
      label: toastActionLabel('toast.action.copy'),
      onClick: () => { void copyToClipboard(getToastCopyText(toastMessage, toastData)) },
    }),
    message,
    data,
  ),
  warning: (message: string | ReactNode, data?: OpenChamberToastOptions) => showRecordedToast(
    'warning',
    sonnerToast.warning,
    (toastMessage, toastData) => ({
      label: toastActionLabel('toast.action.copy'),
      onClick: () => { void copyToClipboard(getToastCopyText(toastMessage, toastData)) },
    }),
    message,
    data,
  ),
  message: (message: string | ReactNode, data?: OpenChamberToastOptions) => showRecordedToast(
    'info',
    sonnerToast.message,
    () => ({ label: toastActionLabel('toast.action.ok'), onClick: () => {} }),
    message,
    data,
  ),
}
