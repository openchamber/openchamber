import { type OpenchamberNotification } from "@/lib/opencode/events"
import { toast } from "@/components/ui"
import { openSessionFromToast } from "./session-navigation"
import { getRuntimeKey } from "@/lib/runtime-switch"
import { getRegisteredRuntimeAPIs } from "@/contexts/runtimeAPIRegistry"
import { formatMessage, useI18nStore } from "@/lib/i18n"
import { trimmedOrUndefined, showPluginNotificationToast } from "./sync-request-notifications"

export const isUiFocused = (): boolean => (
  typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus()
)

export const isUiAway = (): boolean => "document" in globalThis && !isUiFocused()

export const handleUiNotificationEvent = (notification: OpenchamberNotification, fallbackDirectory: string): void => {
  const kind = trimmedOrUndefined(notification.kind)
  const sessionId = trimmedOrUndefined(notification.sessionId)
  const directory = trimmedOrUndefined(notification.directory)
    ?? (fallbackDirectory !== "global" ? fallbackDirectory : "")
  const title = trimmedOrUndefined(notification.title)
  const body = trimmedOrUndefined(notification.body)
  const tag = trimmedOrUndefined(notification.tag)

  if (kind === "share-answer" && notification.toastOnly === true) return

  if (kind === "opencode-restart-interrupted" || kind === "opencode-restart-resuming") {
    const dictionary = useI18nStore.getState().dictionary
    const title = formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.title")
    const options = {
      id: "opencode-restart-interrupted",
      description: formatMessage(dictionary, kind === "opencode-restart-resuming"
        ? "chat.toast.opencodeRestartInterrupted.autoResumeDescription"
        : "chat.toast.opencodeRestartInterrupted.description"),
      duration: Infinity,
    }
    if (sessionId && directory) {
      toast.info(title, {
        ...options,
        action: {
          label: formatMessage(dictionary, "chat.toast.opencodeRestartInterrupted.openSession"),
          onClick: () => openSessionFromToast(sessionId, directory),
        },
      })
    } else {
      toast.info(title, options)
    }
  } else if (notification.showWhenFocused === true && isUiFocused()) {
    showPluginNotificationToast(kind, title, body, tag)
  }

  if (
    (notification.desktopNotificationDelivered === true || notification.desktopStdoutActive === true)
    && getRuntimeKey() === "local"
  ) return

  const notifications = getRegisteredRuntimeAPIs()?.notifications
  if (!notifications?.notifyAgentCompletion) return

  void notifications.notifyAgentCompletion({
    title,
    body,
    tag,
    kind,
    sessionId,
    directory: directory || undefined,
    runtimeKey: getRuntimeKey(),
    requireHidden: notification.kind === "plugin" ? true : notification.requireHidden === true,
  }).catch((error) => {
    console.warn("[notifications] failed to dispatch UI notification", error)
  })
}
