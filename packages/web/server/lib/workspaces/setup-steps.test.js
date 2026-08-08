import { describe, expect, it } from 'vitest';
import { workspaceSetupSteps, WORKSPACE_SETUP_STEP_STATUS } from './setup-steps.js';

const statuses = (steps) => Object.fromEntries(steps.map((step) => [step.id, step.status]));

describe('workspace setup steps', () => {
  it('marks everything before the blocking check as done and everything after as still to come', () => {
    const steps = workspaceSetupSteps('kubernetes', { available: false, code: 'WORKSPACE_PROVIDER_NAMESPACE_MISSING' });

    expect(statuses(steps)).toEqual({
      cli: WORKSPACE_SETUP_STEP_STATUS.SATISFIED,
      cluster: WORKSPACE_SETUP_STEP_STATUS.SATISFIED,
      namespace: WORKSPACE_SETUP_STEP_STATUS.BLOCKED,
      permissions: WORKSPACE_SETUP_STEP_STATUS.PENDING,
      isolation: WORKSPACE_SETUP_STEP_STATUS.PENDING,
    });
  });

  it('keeps the steps in dependency order so the path can be shown up front', () => {
    expect(workspaceSetupSteps('kubernetes', { available: true }).map((step) => step.id))
      .toEqual(['cli', 'cluster', 'namespace', 'permissions', 'isolation']);
    expect(workspaceSetupSteps('docker', { available: true }).map((step) => step.id)).toEqual(['cli', 'daemon']);
  });

  it('blocks the first step for an unrecognized failure rather than implying progress', () => {
    const steps = workspaceSetupSteps('kubernetes', { available: false, code: 'SOMETHING_NEW' });

    expect(steps[0].status).toBe(WORKSPACE_SETUP_STEP_STATUS.BLOCKED);
    expect(steps.slice(1).every((step) => step.status === WORKSPACE_SETUP_STEP_STATUS.PENDING)).toBe(true);
  });

  it('does not call isolation verified just because the provider reports itself available', () => {
    const steps = workspaceSetupSteps('kubernetes', { available: true });

    expect(statuses(steps).isolation).toBe(WORKSPACE_SETUP_STEP_STATUS.UNKNOWN);
    expect(statuses(steps).permissions).toBe(WORKSPACE_SETUP_STEP_STATUS.SATISFIED);
  });

  it('reflects each isolation probe verdict on the isolation step', () => {
    const verdict = (value) => statuses(workspaceSetupSteps('kubernetes', { available: true }, { verdict: value })).isolation;

    expect(verdict('enforced')).toBe(WORKSPACE_SETUP_STEP_STATUS.SATISFIED);
    expect(verdict('not-enforced')).toBe(WORKSPACE_SETUP_STEP_STATUS.BLOCKED);
    expect(verdict('inconclusive')).toBe(WORKSPACE_SETUP_STEP_STATUS.UNKNOWN);
  });

  it('offers an action only for the steps the app can complete itself', () => {
    const steps = workspaceSetupSteps('kubernetes', { available: false, code: 'WORKSPACE_PROVIDER_NAMESPACE_MISSING' });
    const actions = Object.fromEntries(steps.map((step) => [step.id, step.action ?? null]));

    expect(actions).toEqual({ cli: null, cluster: null, namespace: 'create-namespace', permissions: null, isolation: 'check-isolation' });
  });

  it('carries the failure code on the blocking step so the surface can explain the cause', () => {
    const steps = workspaceSetupSteps('docker', { available: false, code: 'WORKSPACE_PROVIDER_DAEMON_UNAVAILABLE' });

    expect(steps.find((step) => step.id === 'daemon')).toMatchObject({ status: WORKSPACE_SETUP_STEP_STATUS.BLOCKED, code: 'WORKSPACE_PROVIDER_DAEMON_UNAVAILABLE' });
    expect(steps.find((step) => step.id === 'cli')).not.toHaveProperty('code');
  });

  it('returns no steps for a provider it does not know', () => {
    expect(workspaceSetupSteps('podman', { available: false })).toEqual([]);
  });
});
