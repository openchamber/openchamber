export const LEAD_COMPACTION_HOOK = `
    await ctx.session.hook("compaction", async (draft) => {
      if (draft.result) return
      const endpoint = process.env.OPENCHAMBER_AGENT_TOOL_URL
      const token = process.env.OPENCHAMBER_AGENT_TOOL_TOKEN
      if (!endpoint || !token) return
      try {
        const response = await fetch(endpoint + "/lead-compaction", {
          method: "POST",
          headers: { authorization: "Bearer " + token, "content-type": "application/json" },
          body: JSON.stringify({ sessionID: draft.sessionID }),
          signal: AbortSignal.timeout(10000),
        })
        const body = await response.json().catch(() => null)
        if (response.ok && typeof body?.summary === "string" && body.summary) draft.result = { summary: body.summary }
      } catch {}
    })`;
