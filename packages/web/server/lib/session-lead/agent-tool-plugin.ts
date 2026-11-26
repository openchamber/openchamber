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

export const refusalThrownInScript = `        const refusedInScript = (payload) => {
          if (context.codemode !== true || payload.ok !== false || !["lead.brief", "lead.digest", "brief", "digest"].includes(payload.action)) return null
          throw Object.assign(new Error(payload.action + " was refused: " + (payload.error?.message ?? "unknown error")), { refusedInScript: true })
        }
`;

export const undeclaredOnlyForLead = (declared: string[]) => `        const declaredNames = new Set(${JSON.stringify(declared)})
        const refusesUndeclared = ["lead.brief", "lead.digest", "brief", "digest"].includes(args.action)
        for (const [key, value] of Object.entries(parameters ?? {})) {
          if (key === "action" || declaredNames.has(key)) continue
          const empty = value === null || value === "" || (typeof value === "object" && Object.keys(value).length === 0)
          if (refusesUndeclared && !empty) continue
          if (Object.hasOwn(flattened, key)) args[key] = flattened[key]
          else delete args[key]
        }
`;
