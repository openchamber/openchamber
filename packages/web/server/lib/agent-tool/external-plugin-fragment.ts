import { LEAD_COMPACTION_HOOK } from '../session-lead/agent-tool-plugin.js';
import {
  AGENT_TOOL_DYNAMIC_HELPERS,
  CODE_MODE_CATALOG_LINES,
  OPENCODE_TOOLS_REPLACED_BY_CONTROL,
  buildAgentToolEntries,
} from './runtime.js';

const OPENCODE_TOOLS_REPLACED_BY_SCHEDULE = [
  'opencode_automation_create',
  'opencode_automation_list',
  'opencode_automation_pause',
  'opencode_automation_resume',
  'opencode_automation_delete',
  'automation_create',
  'automation_list',
  'automation_pause',
  'automation_resume',
  'automation_delete',
];

const OPENCODE_TOOL_REPLACED_BY_IMAGE = 'experimental_image_generate';

export const createDynamicAgentToolPluginFragment = () => {
  const namespaceLines = Object.entries(CODE_MODE_CATALOG_LINES).map(([name, description]) => {
    const flag = name === 'openchamber' ? 'control' : name.replace('openchamber_', '');
    return `      if (enabled.${flag}) tools.namespace(${JSON.stringify({ name, description })})`;
  });

  const allEntries = buildAgentToolEntries({
    includeControl: true,
    includeSchedule: true,
    includeWeb: true,
    includeMemory: true,
    includeKnowledge: true,
    includeNotify: true,
    includeRender: true,
    includeShare: false,
    includeImage: true,
    includeSecret: true,
    includeUsage: true,
    includeTerminal: true,
    includeActions: true,
    includeWorkflow: true,
  });

  const renderWithShare = buildAgentToolEntries({
    includeControl: false,
    includeSchedule: false,
    includeWeb: false,
    includeMemory: false,
    includeKnowledge: false,
    includeNotify: false,
    includeRender: true,
    includeShare: true,
    includeImage: false,
    includeSecret: false,
    includeUsage: false,
    includeTerminal: false,
    includeActions: false,
    includeWorkflow: false,
  }).render;

  const blocks = [
    `      for (const existing of tools.list()) {
        const ns = existing.options?.namespace
        if (ns === "browser" || (typeof ns === "string" && ns.startsWith("browser."))) tools.remove(existing.id)
      }`,
    ...namespaceLines,
    `      if (enabled.control) {
        for (const id of ${JSON.stringify(OPENCODE_TOOLS_REPLACED_BY_CONTROL)}) tools.remove(id)
${allEntries.control}      }`,
    `      if (enabled.schedule) {
        for (const id of ${JSON.stringify(OPENCODE_TOOLS_REPLACED_BY_SCHEDULE)}) tools.remove(id)
${allEntries.schedule}      }`,
    `      if (enabled.web) {\n${allEntries.web}      }`,
    `      if (enabled.memory) {\n${allEntries.memory}      }`,
    `      if (enabled.knowledge) {\n${allEntries.knowledge}      }`,
    `      if (enabled.notify) {\n${allEntries.notify}      }`,
    `      if (enabled.render) {
        if (enabled.share) {\n${renderWithShare}        } else {\n${allEntries.render}        }
      }`,
    `      if (enabled.secret) {\n${allEntries.secret}      }`,
    `      if (enabled.image) {
        tools.remove(${JSON.stringify(OPENCODE_TOOL_REPLACED_BY_IMAGE)})
${allEntries.image}      }`,
    `      if (enabled.usage) {\n${allEntries.usage}      }`,
    `      if (enabled.terminal) {\n${allEntries.terminal}      }`,
    `      if (enabled.actions) {\n${allEntries.actions}      }`,
    `      if (enabled.workflow) {\n${allEntries.workflow}      }`,
  ];

  const hooksSetup = `    await ctx.session.hook("context", async (draft) => {
      if (!draft.tools || !Object.hasOwn(draft.tools, "openchamber_workflow_answer")) return
      const session = await ctx.session.get({ sessionID: draft.sessionID }).catch(() => null)
      const permissions = session?.permissions ?? session?.data?.permissions
      const allowed = Array.isArray(permissions)
        && permissions.some((rule) => rule?.action === "openchamber_workflow_answer" && rule?.effect === "allow")
      if (!allowed) delete draft.tools.openchamber_workflow_answer
    })
    await ctx.session.hook("prompt", (event) => {
      if (!resolveConnection()) return
      if (isAgentPrompt(event.metadata)) return
      pendingByUser.set(event.messageID, event.sessionID)
      if (event.delivery !== "queue") endWaits(event.sessionID)
    })
    if (ctx.event?.subscribe) {
      followUserPrompts(ctx.event.subscribe({ types: ["session.inbox.delivery.changed", "session.inbox.delivered", "session.inbox.cancelled", "session.deleted"] }))
        .catch((error) => console.warn("[openchamber] stopped following the user's prompts:", error?.message ?? error))
    }${LEAD_COMPACTION_HOOK}`;

  return {
    helpers: AGENT_TOOL_DYNAMIC_HELPERS,
    transformBody: blocks.join('\n'),
    hooksSetup,
  };
};
