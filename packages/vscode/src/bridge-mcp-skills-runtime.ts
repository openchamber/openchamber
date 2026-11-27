import { z } from 'zod';
import { AGENT_SCOPE, getJsonWriteTarget, readConfigLayers, writeConfig } from './opencodeConfig';
import { writeMcpSkillsEnabled } from './opencode-config-v2';
import { createSkillClientFactory } from '../../web/server/lib/opencode/skill-body.js';
import { applyMcpSkillsFlag } from '../../web/server/lib/opencode/mcp-skills-apply.js';
import type { BridgeContext, BridgeRequest, BridgeResponse } from './bridge';

export const handleMcpSkillsBridgeMessage = async ({ id, type, payload }: BridgeRequest, ctx: BridgeContext | undefined): Promise<BridgeResponse | null> => {
  if (type !== 'api:config/skill-mcp') return null;
  const parsed = z.object({ enabled: z.boolean() }).safeParse(payload);
  if (!parsed.success) return { id, type, success: false, error: 'enabled must be a boolean' };
  const { enabled } = parsed.data;
  const target = getJsonWriteTarget(readConfigLayers(), AGENT_SCOPE.USER);
  const changed = writeMcpSkillsEnabled(target.config, enabled);
  const apiUrl = ctx?.manager?.getApiUrl();
  if (changed) writeConfig(target.config, target.path);
  if (changed && apiUrl) {
    const clientFor = createSkillClientFactory(() => ctx?.manager?.getOpenCodeAuthHeaders() || {}, (route) => `${apiUrl.replace(/\/+$/, '')}${route}`);
    await applyMcpSkillsFlag(clientFor, target.path, enabled).catch(() => undefined);
  }
  return { id, type, success: true, data: { success: true, changed } };
};
