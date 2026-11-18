import { opencodeClient } from "@/lib/opencode/client"
import { type SessionPageLister } from "@/stores/globalSessions"

export const listSessionPage: SessionPageLister = (options) => opencodeClient.listSessionsPage(options)
