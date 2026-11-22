import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import {
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { fetchPoolHealth, savePoolPlanLink, type PoolHealthState, type PoolTargetHealth } from '@/lib/routing/poolHealthApi';
import { fetchPlanState, type PlanRecord } from '@/lib/routing/plansApi';
import { PoolRotationFields } from '@/components/sections/routing/PoolRotationFields';

const NO_PLAN_VALUE = '__none__';

// A rejected request carries an Error; anything else thrown is shown as text.
const errorText = (failure: Error | string) => (failure instanceof Error ? failure.message : failure);

const statusClass = (status: 'ok' | 'warn' | 'over') =>
  status === 'over'
    ? 'text-status-error'
    : status === 'warn'
      ? 'text-[var(--status-warning)]'
      : 'text-muted-foreground';

/** One target's row: active sessions, its plan link, and a projection when one is known. */
const TargetHealthRow: React.FC<{
  target: PoolTargetHealth;
  plans: readonly PlanRecord[];
  onLink: (planID: string | null) => void;
  linkPending: boolean;
  onLowerWeight: () => void;
}> = ({ target, plans, onLink, linkPending, onLowerWeight }) => {
  const { t } = useI18n();
  // Plans for the target's own provider first; others stay pickable, since a
  // custom provider id can front the same account.
  const provider = target.ref.split('/')[0];
  const orderedPlans = React.useMemo(
    () => [...plans].sort((left, right) => Number(right.providerID === provider) - Number(left.providerID === provider)),
    [plans, provider],
  );
  const status = target.plan?.projection?.status;
  return (
    <div className="flex flex-col gap-1 py-1.5 @xl:flex-row @xl:items-center @xl:gap-3">
      <span className="typography-ui-label min-w-0 flex-1 truncate text-foreground">{target.ref}</span>
      <span className="typography-meta text-muted-foreground shrink-0">
        {target.activeSessions === null ? '—' : `${t('settings.pools.health.activeSessions')}: ${target.activeSessions}`}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Select
          value={target.plan?.id ?? target.missingPlanID ?? NO_PLAN_VALUE}
          disabled={linkPending}
          onValueChange={(next) => onLink(next === NO_PLAN_VALUE ? null : next)}
        >
          <SelectTrigger className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'w-44')} aria-label={t('settings.pools.health.plan')}>
            {/* Base UI shows the raw value unless the label is given, and the "no plan" value is a sentinel. */}
            <SelectValue>
              {target.plan?.label
                ?? (target.missingPlanID ? t('settings.pools.health.planMissing', { id: target.missingPlanID }) : t('settings.pools.health.planNone'))}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PLAN_VALUE}>{t('settings.pools.health.planNone')}</SelectItem>
            {target.missingPlanID ? (
              <SelectItem value={target.missingPlanID}>{t('settings.pools.health.planMissing', { id: target.missingPlanID })}</SelectItem>
            ) : null}
            {orderedPlans.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>{plan.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <SettingsInfoHint>{t('settings.pools.health.planInfo')}</SettingsInfoHint>
      </div>
      {status ? (
        <span className={cn('typography-meta shrink-0', statusClass(status))}>
          {t(`settings.pools.health.status.${status}`)}
        </span>
      ) : null}
      {target.suggestion === 'lower-weight' ? (
        <Button size="sm" variant="outline" onClick={onLowerWeight} title={t('settings.pools.health.lowerWeightInfo')}>
          {t('settings.pools.health.lowerWeight')}
        </Button>
      ) : null}
    </div>
  );
};

/**
 * Pool health: how many sessions share each target right now, and, for a
 * target linked to a plan, a rough projection against its quota window.
 * Linking a target to a plan, lowering a suggested weight and the rotation
 * settings are the only writes this section makes.
 */
export const PoolHealthSection: React.FC<{
  onLowerWeight: (poolID: string, targetRef: string) => void;
  /** Changes whenever the pools change, so the panel reads them again. */
  reloadKey?: string;
}> = ({ onLowerWeight, reloadKey }) => {
  const { t } = useI18n();
  const [health, setHealth] = React.useState<PoolHealthState | null>(null);
  const [plans, setPlans] = React.useState<readonly PlanRecord[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [planError, setPlanError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  // Refresh also reads the rotation history, which moves on its own while the panel is open.
  const [refreshCount, setRefreshCount] = React.useState(0);
  // One save per target at a time, so an earlier pick cannot land after a later one.
  const [pendingLinks, setPendingLinks] = React.useState<ReadonlySet<string>>(new Set());
  // Only the newest read may land: a refresh and a link change can overlap.
  const loadSeqRef = React.useRef(0);

  const load = React.useCallback(() => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    Promise.allSettled([fetchPoolHealth(), fetchPlanState()]).then(([healthResult, planResult]) => {
      if (seq !== loadSeqRef.current) return;
      setLoading(false);
      if (healthResult.status === 'fulfilled') {
        setHealth(healthResult.value);
        setError(null);
      } else {
        setError(errorText(healthResult.reason));
      }
      if (planResult.status === 'fulfilled') {
        setPlans(planResult.value.plans);
        setPlanError(null);
      } else {
        setPlanError(t('settings.routing.plans.loadFailed', { error: errorText(planResult.reason) }));
      }
    });
  }, [t]);

  React.useEffect(() => {
    load();
  }, [load, reloadKey]);

  const link = (target: string, planID: string | null) => {
    setPendingLinks((current) => new Set(current).add(target));
    void savePoolPlanLink(target, planID)
      .then(load)
      .catch((failure: Error) => setError(errorText(failure)))
      .finally(() => setPendingLinks((current) => {
        const next = new Set(current);
        next.delete(target);
        return next;
      }));
  };

  if (!health) {
    return <p className={SETTINGS_HELPER_CLASS}>{error ?? t('settings.pools.loading')}</p>;
  }
  const poolEntries = Object.entries(health.pools);
  if (poolEntries.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5">
        <p className="typography-ui-label font-medium text-foreground">{t('settings.pools.health.title')}</p>
        <SettingsInfoHint>{t('settings.pools.health.description')}</SettingsInfoHint>
        <Button size="xs" variant="ghost" className="ms-auto !font-normal" onClick={() => { setRefreshCount((count) => count + 1); load(); }} disabled={loading}>
          {t('settings.pools.health.refresh')}
        </Button>
      </div>
      {error ? <p className={SETTINGS_HELPER_CLASS}>{error}</p> : null}
      {health.planError ? (
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.routing.plans.loadFailed', { error: health.planError })}</p>
      ) : planError ? <p className={SETTINGS_HELPER_CLASS}>{planError}</p> : null}
      {health.linksError ? (
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.health.linksLoadFailed', { error: health.linksError })}</p>
      ) : null}
      {health.statsAvailable === false ? (
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.health.statsUnavailable')}</p>
      ) : null}
      <div className="space-y-3">
        {poolEntries.map(([poolID, pool]) => (
          <div key={poolID} className="space-y-0.5">
            <p className="typography-meta text-muted-foreground">{poolID}</p>
            <div className="divide-y divide-border/40">
              {pool.targets.map((target, index) => (
                <React.Fragment key={`${target.ref}-${index}`}>
                  <TargetHealthRow
                    target={target}
                    plans={plans}
                    onLink={(planID) => link(target.ref, planID)}
                    linkPending={pendingLinks.has(target.ref)}
                    onLowerWeight={() => onLowerWeight(poolID, target.ref)}
                  />
                  {target.blastRadius ? (
                    <p className={cn(SETTINGS_HELPER_CLASS, 'pb-1.5')}>{t('settings.pools.health.blastRadius')}</p>
                  ) : null}
                  {target.plan?.siblingRefs.length ? (
                    <p className={cn(SETTINGS_HELPER_CLASS, 'pb-1.5')}>
                      {t('settings.pools.health.siblings', { refs: target.plan.siblingRefs.join(', ') })}
                    </p>
                  ) : null}
                  {target.plan?.projection ? (
                    <p className={cn(SETTINGS_HELPER_CLASS, 'pb-1.5')}>
                      {t(`settings.pools.health.projection.${target.plan.projection.unit}`, {
                        projected: target.plan.projection.projected,
                        limit: target.plan.projection.limit,
                        hours: target.plan.projection.windowHours,
                      })}
                      {' — '}
                      {t(`settings.pools.health.projectionSource.${target.plan.projection.source}`)}
                    </p>
                  ) : null}
                  {target.plan?.unprojectedQuotas.map((quota) => (
                    <p key={`${quota.quotaName}-${quota.unit}`} className={cn(SETTINGS_HELPER_CLASS, 'pb-1.5')}>
                      {t(`settings.pools.health.noProjection.${quota.reason}`, { name: quota.quotaName })}
                    </p>
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
        ))}
      </div>
      <PoolRotationFields reloadKey={`${reloadKey ?? ''}:${refreshCount}`} />
    </div>
  );
};
