export const LEAD_COMPACTION_HOOK = `
    await ctx.session.hook("compaction", async (draft) => {
      if (draft.result) return
      const connection = resolveConnection()
      if (!connection || (connection.tools && !connection.tools.control)) return
      try {
        const response = await fetch(connection.url + "/lead-compaction", {
          method: "POST",
          headers: { authorization: "Bearer " + connection.token, "content-type": "application/json" },
          body: JSON.stringify({ sessionID: draft.sessionID }),
          signal: AbortSignal.timeout(10000),
        })
        const body = await response.json().catch(() => null)
        if (response.ok && typeof body?.summary === "string" && body.summary) draft.result = { summary: body.summary }
      } catch {}
    })`;
