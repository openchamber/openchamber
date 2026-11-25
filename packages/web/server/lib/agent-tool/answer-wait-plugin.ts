export const TOOL_SCHEMA_VERSION = 1;

export const answerWaitSetup = (waitsWhen: string) => String.raw`        const chatController = new AbortController()
        const waiting = ${waitsWhen}
        if (waiting) {
          const set = pagesWaitingForChat.get(context.sessionID) ?? new Set()
          set.add(chatController)
          pagesWaitingForChat.set(context.sessionID, set)
        }
        const releaseWait = () => {
          const set = pagesWaitingForChat.get(context.sessionID)
          if (!set) return
          set.delete(chatController)
          if (set.size === 0) pagesWaitingForChat.delete(context.sessionID)
        }
        const waitSignal = AbortSignal.any([context.signal, chatController.signal].filter(Boolean))
`;

export const answerConnectionLost = (note: string) => String.raw`
          if (waiting) {
            return failure({ schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: false, action: args.action, error: { message: ${JSON.stringify(note)}, kind: "runtime" } })
          }`;

export const ANSWER_FETCH_TIMEOUT = String.raw`
            ...(waiting ? { timeout: false } : {}),`;

export const ANSWER_METADATA = String.raw`, ...(result.ok === true && result.data && typeof result.data.answer === "object" && result.data.answer !== null ? { answer: result.data.answer } : {})`;

export const ANSWER_WAIT_RELEASE = String.raw` finally {
          releaseWait()
        }`;

export const answerClosedInChat = (note: string) => String.raw`
          if (chatController.signal.aborted && !context.signal?.aborted) {
            const answer = { answered: false, reason: "chat" }
            const payload = { schemaVersion: ${TOOL_SCHEMA_VERSION}, ok: true, action: args.action, data: { answer, note: ${JSON.stringify(note)} } }
            await progress({ ok: true })
            return { content: JSON.stringify(payload), metadata: { openchamber: { schemaVersion: ${TOOL_SCHEMA_VERSION}, action: args.action, description: title, ok: true, answer } } }
          }`;
