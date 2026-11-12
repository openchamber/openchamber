import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { FRONT_DOOR_DISABLED_RUNTIMES, AGENT_DISABLED_FEATURES } from './mode.js';
import { createStartupPipelineRuntime } from '../opencode/startup-pipeline-runtime.js';

const source = fs.readFileSync(new URL('../../index.js', import.meta.url), 'utf8');

describe('front door composition contract', () => {
  it('constructs no owner terminal and passes agent transport to local message sockets', async () => {
    // Given the same startup pipeline the real server runs.
    const createTerminalRuntime = vi.fn();
    const createMessageStreamWsRuntime = vi.fn(() => ({}));
    const fetchImpl = vi.fn();
    const pipeline = createStartupPipelineRuntime({
      createTerminalRuntime, createMessageStreamWsRuntime,
      createDictationRuntime: () => ({}),
      createServerStartupRuntime: () => ({
        resolveBindHost: () => '127.0.0.1',
        startListeningAndMaybeTunnel: async () => ({ activePort: 3000 }),
        attachProcessHandlers() {},
      }),
    });
    // When it starts in front-door mode.
    const result = await pipeline.run({
      frontDoor: true, fetchImpl, setupProxy() {},
      staticRoutesRuntime: { registerApiOnlyFallbackRoutes() {} }, apiOnly: true,
      tunnelRuntimeContext: { setActivePort() {} }, scheduleOpenCodeApiDetection() {}, bootstrapOpenCodeAtStartup() {},
    });
    // Then the local executor is absent, while message sockets use the bounded transport.
    expect(createTerminalRuntime).not.toHaveBeenCalled();
    expect(result.terminalRuntime).toBeNull();
    expect(createMessageStreamWsRuntime).toHaveBeenCalledWith(expect.objectContaining({ frontDoor: true, fetchImpl }));
  });
  it('gates construction, not just request routing, for every session executor', () => {
    // Given the composition that starts session runtimes before main().
    const names = [
      'sessionAssist', 'sessionGoal', 'contextObligatory', 'sessionWarming', 'sessionKnowledge', 'sessionWork',
      'sessionInterruption', 'autoResume', 'permissionAutoAccept', 'autoReview', 'messageQueue', 'prStackRestack',
      'dispatchResults', 'prWatch', 'mergeFollow', 'workflow', 'workflowAgentSessions', 'messageSearch',
      'scheduledTasks', 'suggestedTasks', 'browserControlBroker', 'browserControlRouter', 'agentTool', 'limitFailover', 'routing',
    ];
    // When the inventory is matched against each actual constructor assignment.
    for (const name of names) {
      const variable = ['browserControlBroker', 'browserControlRouter', 'workflowAgentSessions'].includes(name) ? name : `${name}Runtime`;
      // Then removing a construction gate fails this contract, even if forwarding still works.
      expect(source).toMatch(new RegExp(`${variable} = FRONT_DOOR \\? null : create`));
      expect(FRONT_DOOR_DISABLED_RUNTIMES).toContain(name);
    }
    expect(source).toContain('shouldSkipOpenCodeStop: () => FRONT_DOOR ||');
    expect(source).toMatch(/const bootstrapOpenCodeAtStartup[\s\S]*?if \(FRONT_DOOR\) \{[\s\S]*?return;[\s\S]*?openCodeLifecycleRuntime.bootstrapOpenCodeAtStartup/);
    expect(source).toContain('if (!FRONT_DOOR) globalMessageStreamHub.subscribeEvent');
    const afterAuth = source.slice(source.indexOf('afterApiAuth:'));
    expect(afterAuth.indexOf('app.use(spaceArchive.guard)')).toBeLessThan(afterAuth.indexOf('app.use(frontDoorRuntime.middleware)'));
    const watcher = source.slice(source.indexOf('const openCodeWatcherRuntime'), source.indexOf('// A folder is checked once'));
    expect(watcher).toContain('resolveCenterEntriesFor(payload)');
  });
  it('keeps owner-only agent features explicitly disabled', () => {
    // Given the agent-mode feature boundary. When enumerated, then every owner capability has a gate.
    expect(AGENT_DISABLED_FEATURES).toEqual(['pushDelivery', 'relayHost', 'tunnels', 'spaces', 'protectedMcpAdmin', 'updateInstall']);
    expect(source).toContain('const relayService = AGENT_SERVER ? null :');
    expect(source).toContain('AGENT_SERVER ? createAgentTunnelContext() :');
    expect(source).toContain('if (!AGENT_SERVER && startupSettings?.isolatedSpacesEnabled');
    expect(source).toContain('AGENT_SERVER ? Promise.resolve() : pushRuntime.sendPushToAllUiSessions');
  });
});
