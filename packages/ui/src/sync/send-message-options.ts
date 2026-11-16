import type { SkillMentions } from "@/lib/opencode/client"
import type { Metadata } from "@/lib/opencode/model"
import type { QueuedMessageGoal } from "@/stores/messageQueueStore"
import type { InputHistorySubmission } from "@/stores/useInputHistoryStore"
import type { NewSessionDraftState } from "./session-ui-store"

/** The route a send to an existing session took, for callers that act on what reached it (#5391). */
export type SentMessage = { route: 'command' | 'prompt' | 'shell'; sessionId: string }

type CapturedSendTarget = {
  runtimeKey: string
  sessionId: string
  directory: string
}

export type SendProgress = {
  sessionMinted?: (sessionId: string, chatDirectory: string | null) => void
  messageMinted?: (messageId: string) => void
  requestLeaving?: () => void
}

export type SendMessageOptions = {
  /** Explicit composer intent; automated continuations must not restore archives. */
  userInitiated?: boolean
  target?: CapturedSendTarget
  sessionId?: string
  directory?: string
  historySubmissions?: InputHistorySubmission[]
  /** Immutable copy of the new-session draft at submit time; used instead of the live draft. */
  draftSnapshot?: NewSessionDraftState
  delivery?: 'steer'
  /** Skills named inline, attached to the prompt once the session exists. */
  skills?: SkillMentions
  /** Stored on the user message of a prompt to an existing session (a deferred question's answer marker). */
  metadata?: Metadata
  /** Told the route a send to an existing session took, once it went out. */
  onSent?: (sent: SentMessage) => void
  /**
   * A queued message carries its own goal intent. Set (a goal or `null`), it
   * replaces the composer's armed goal, which belongs to the composer text.
   */
  queuedGoal?: QueuedMessageGoal | null
  /**
   * A person sent this from a composer: after a successful prompt, remember
   * the level it actually carried for that model. Background, BTW and queued
   * delivery leave this unset and never overwrite the remembered level.
   */
  recordEffort?: boolean
  /** Revision captured with the composer's selection, before async preparation. */
  effortRevision?: number
  progress?: SendProgress
}
