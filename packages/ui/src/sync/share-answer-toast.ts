import { toast } from "@/components/ui"
import { formatMessage, useI18nStore } from "@/lib/i18n"

import { openSessionFromToast } from "./session-navigation"

/** What the server sends when an answer to a shared page reached its session. */
type ShareAnswerNotification = {
  kind?: string
  title?: string
  body?: string
  tag?: string
  sessionId?: string
  directory?: string
}

type ShareAnswerToast = {
  title: string
  id: string | undefined
  description: string | undefined
  /** The session to open from the toast, when the server named one with its folder. */
  session: { sessionId: string; directory: string } | null
}

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * The toast an answer to a shared page shows in every open window, focused or
 * not (the server decides whether a system notification goes out as well), or
 * null for any other notification.
 */
export const shareAnswerToastFor = (notification: ShareAnswerNotification): ShareAnswerToast | null => {
  const title = present(notification.title)
  if (notification.kind !== "share-answer" || !title) return null
  const sessionId = present(notification.sessionId)
  const directory = present(notification.directory)
  return {
    title,
    id: present(notification.tag),
    description: present(notification.body),
    session: sessionId && directory ? { sessionId, directory } : null,
  }
}

/** Shows the toast; the control stream and the main stream may both carry it, and the id keeps one. */
export const showShareAnswerToast = (shown: ShareAnswerToast): void => {
  const { session } = shown
  const action = session
    ? {
      label: formatMessage(useI18nStore.getState().dictionary, "chat.toast.shareAnswer.openSession"),
      onClick: () => openSessionFromToast(session.sessionId, session.directory),
    }
    : undefined
  toast.info(shown.title, { id: shown.id, description: shown.description, action })
}
