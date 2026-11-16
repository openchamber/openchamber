import type { ProjectPlanLink } from '@/lib/projectContextApi';
import type { PlanTier } from '@/lib/routing/plansApi';
import { useInputStore } from '@/sync/input-store';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** The settings page's key: one send-mode preference for every plan action. */
const PLAN_ACTION_SEND_MODE_STORAGE_KEY = 'openchamber.routing.plans.actionSendMode';

type PlanActionSendMode = 'prefill' | 'autosend';

/** The stored send mode, defaulting to prefill when unset or unreadable. */
export const readPlanActionSendMode = (): PlanActionSendMode => {
  try {
    return localStorage.getItem(PLAN_ACTION_SEND_MODE_STORAGE_KEY) === 'autosend' ? 'autosend' : 'prefill';
  } catch {
    return 'prefill';
  }
};

/**
 * The dispatch prompt for one tier. The `/route <tier>` prefix is the routing
 * command the session runs first, so the tier picks the model pool before the
 * plan work starts; the plan is named by title and file so the agent reads the
 * stored plan rather than a copy pasted into the prompt.
 */
export const buildPlanTierPrompt = (plan: Pick<ProjectPlanLink, 'title' | 'file'>, tier: PlanTier): string => (
  `/route ${tier} Implement the plan "${plan.title}" (plan file: ${plan.file})`
);

type PlanTierDispatchOutcome =
  | { ok: true; sessionId: string; mode: PlanActionSendMode }
  | { ok: false; reason: 'create-failed' | 'send-failed' };

/**
 * Starts the tier's implementation session in the project, following the
 * settings page's command pattern: `prefill` leaves the prompt in the
 * composer for inspection, `autosend` sends it immediately. The caller links
 * the plan to the returned session (the project-context store owns that).
 */
export const startPlanTierDispatch = async (input: {
  plan: ProjectPlanLink;
  tier: PlanTier;
  projectPath: string;
  mode: PlanActionSendMode;
}): Promise<PlanTierDispatchOutcome> => {
  const prompt = buildPlanTierPrompt(input.plan, input.tier);
  const store = useSessionUIStore.getState();
  const session = await store.createSession(input.plan.title, input.projectPath);
  if (!session?.id) return { ok: false, reason: 'create-failed' };
  store.setCurrentSession(session.id, session.directory ?? input.projectPath);
  if (input.mode === 'autosend') {
    try {
      await store.sendMessage(prompt, '', '');
    } catch {
      return { ok: false, reason: 'send-failed' };
    }
  } else {
    useInputStore.getState().setPendingInputText(prompt, 'replace');
  }
  return { ok: true, sessionId: session.id, mode: input.mode };
};
