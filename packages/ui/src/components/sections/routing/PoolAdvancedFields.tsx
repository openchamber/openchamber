import React from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import {
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { RangedNumberField } from '@/components/sections/routing/RangedNumberField';
import { RouteScheduleFields } from '@/components/sections/routing/RouteScheduleFields';
import { useI18n } from '@/lib/i18n';
import type { ModelRoute } from '@/lib/routing/modelRoutesApi';
import {
  isConcreteTarget,
  pickedValue,
  pruneEmpty,
  routeReferenceID,
  setRouteField,
  setTargetEntry,
  targetReference,
  withOptional,
} from '@/lib/routing/poolAdvanced';
import { cn } from '@/lib/utils';

type Health = NonNullable<ModelRoute['health']>;
type Budget = NonNullable<NonNullable<ModelRoute['budgets']>[string]>;

const SECONDS = 1000;

const seconds = (ms: number | undefined) => (ms === undefined ? undefined : ms / SECONDS);
const toMs = (value: number | undefined) => (value === undefined ? undefined : Math.round(value * SECONDS));
const percent = (fraction: number | undefined) => (fraction === undefined ? undefined : Math.round(fraction * 1000) / 10);
const fromPercent = (value: number | undefined) => (value === undefined ? undefined : Math.round(value * 10) / 1000);

/** Expert-level pool settings, grouped by what they change: selection, failover, health, budgets and schedules. */
export const PoolAdvancedFields: React.FC<{ route: ModelRoute; onChange: (route: ModelRoute) => void }> = ({ route, onChange }) => {
  const { t } = useI18n();
  const health: Health = route.health ?? {};
  const budgets = route.budgets ?? {};
  const concrete = (route.targets ?? []).filter(isConcreteTarget);
  const references = [...new Set(concrete.map(targetReference))];
  const modelReferences = [...new Set(concrete.filter((target) => routeReferenceID(target) === null).map(targetReference))];

  const setHealth = (key: keyof Health, value: unknown) =>
    onChange(setRouteField(route, 'health', pruneEmpty(withOptional(route.health, key, value))));

  const setBudget = (reference: string, key: keyof Budget, value: number | undefined) => {
    const entry = withOptional(budgets[reference], key, value) as Budget;
    onChange(setRouteField(route, 'budgets', setTargetEntry(route.budgets, reference, entry)));
  };

  const setWeight = (reference: string, value: number | undefined) => {
    const weights: Record<string, number> = { ...(route.weights ?? {}) };
    if (value === undefined) delete weights[reference];
    else weights[reference] = value;
    onChange(setRouteField(route, 'weights', pruneEmpty(weights)));
  };

  const heading = 'typography-ui-label font-medium text-foreground';

  return (
    <div className="space-y-4">
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.advanced.help')}</p>

      <SettingsFieldRow label={t('settings.pools.advanced.selection')} description={t('settings.pools.advanced.selectionInfo')} settingsItem="routing.pools-advanced">
        <Select
          value={route.selection ?? '__unset__'}
          onValueChange={(next) => onChange(setRouteField(route, 'selection', pickedValue(next)))}
        >
          <SelectTrigger className={cn(SETTINGS_SELECT_ROW_TRIGGER_CLASS, 'w-56')} aria-label={t('settings.pools.advanced.selection')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__unset__">{t('settings.pools.advanced.selectionDefault')}</SelectItem>
            <SelectItem value="ordered">{t('settings.pools.advanced.selection.ordered')}</SelectItem>
            <SelectItem value="round-robin">{t('settings.pools.advanced.selection.roundRobin')}</SelectItem>
            <SelectItem value="weighted">{t('settings.pools.advanced.selection.weighted')}</SelectItem>
          </SelectContent>
        </Select>
      </SettingsFieldRow>

      {route.selection === 'weighted' || route.selection === 'round-robin' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {references.map((reference) => (
            <RangedNumberField
              key={reference}
              label={`${t('settings.pools.advanced.weight')}: ${reference}`}
              value={route.weights?.[reference]}
              min={0.01}
              max={1000}
              step="any"
              placeholder="1"
              onCommit={(value) => setWeight(reference, value)}
            />
          ))}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <RangedNumberField
          label={t('settings.pools.advanced.attempts')}
          value={route.attempts}
          min={1}
          max={50}
          placeholder="2"
          onCommit={(value) => onChange(setRouteField(route, 'attempts', value))}
        />
        <RangedNumberField
          label={t('settings.pools.advanced.hedge')}
          value={seconds(route.hedgeAfterMs)}
          min={1}
          max={3600}
          placeholder={t('settings.pools.advanced.off')}
          onCommit={(value) => onChange(setRouteField(route, 'hedgeAfterMs', toMs(value)))}
        />
      </div>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.advanced.hedgeInfo')}</p>

      <div className="space-y-2">
        <p className={heading}>{t('settings.pools.advanced.health')}</p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-1">
            <span className="typography-meta text-muted-foreground">{t('settings.pools.advanced.firstToken')}</span>
            <div className="flex h-8 items-center gap-3">
              <Switch
                checked={health.firstTokenTimeoutMs === false}
                onCheckedChange={(checked) => setHealth('firstTokenTimeoutMs', checked ? false : undefined)}
                aria-label={t('settings.pools.advanced.firstTokenOff')}
              />
              <span className="typography-meta text-muted-foreground">{t('settings.pools.advanced.firstTokenOff')}</span>
            </div>
          </div>
          <RangedNumberField
            label={t('settings.pools.advanced.firstToken')}
            value={typeof health.firstTokenTimeoutMs === 'number' ? seconds(health.firstTokenTimeoutMs) : undefined}
            min={1}
            max={3600}
            placeholder="10"
            disabled={health.firstTokenTimeoutMs === false}
            onCommit={(value) => setHealth('firstTokenTimeoutMs', toMs(value))}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.maxResponse')}
            value={seconds(health.maxResponseTimeMs)}
            min={1}
            max={3600}
            placeholder={t('settings.pools.advanced.off')}
            onCommit={(value) => setHealth('maxResponseTimeMs', toMs(value))}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.minRate')}
            value={health.minOutputTokensPerSecond}
            min={0.1}
            max={100000}
            step="any"
            placeholder={t('settings.pools.advanced.off')}
            onCommit={(value) => setHealth('minOutputTokensPerSecond', value)}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.cooldown')}
            value={seconds(health.cooldownMs)}
            min={1}
            max={3600}
            placeholder="60"
            onCommit={(value) => setHealth('cooldownMs', toMs(value))}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.quotaCooldown')}
            value={seconds(health.quotaCooldownMs)}
            min={1}
            max={3600}
            placeholder="900"
            onCommit={(value) => setHealth('quotaCooldownMs', toMs(value))}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.sampleWindow')}
            value={health.sampleWindow}
            min={1}
            max={50}
            placeholder="5"
            onCommit={(value) => setHealth('sampleWindow', value)}
          />
          <RangedNumberField
            label={t('settings.pools.advanced.slowThreshold')}
            value={health.slowThreshold}
            min={1}
            max={50}
            placeholder="3"
            onCommit={(value) => setHealth('slowThreshold', value)}
          />
        </div>
      </div>

      {modelReferences.length > 0 ? (
        <div className="space-y-2">
          <p className={heading}>{t('settings.pools.advanced.budgets')}</p>
          <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.advanced.budgetsInfo')}</p>
          {modelReferences.map((reference) => {
            const budget: Budget = budgets[reference] ?? {};
            return (
              <div key={reference} className="space-y-2 rounded-md border border-border/40 p-3">
                <p className="typography-meta truncate text-foreground">{reference}</p>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                  <RangedNumberField label={t('settings.pools.advanced.requestsPerMinute')} value={budget.requestsPerMinute} min={1} max={1e9} onCommit={(value) => setBudget(reference, 'requestsPerMinute', value)} />
                  <RangedNumberField label={t('settings.pools.advanced.requestsPerDay')} value={budget.requestsPerDay} min={1} max={1e9} onCommit={(value) => setBudget(reference, 'requestsPerDay', value)} />
                  <RangedNumberField label={t('settings.pools.advanced.tokensPerMinute')} value={budget.tokensPerMinute} min={1} max={1e12} onCommit={(value) => setBudget(reference, 'tokensPerMinute', value)} />
                  <RangedNumberField label={t('settings.pools.advanced.tokensPerDay')} value={budget.tokensPerDay} min={1} max={1e12} onCommit={(value) => setBudget(reference, 'tokensPerDay', value)} />
                  <RangedNumberField
                    label={t('settings.pools.advanced.softLimit')}
                    value={percent(budget.softLimit)}
                    min={12.5}
                    max={100}
                    step="any"
                    placeholder="90"
                    onCommit={(value) => setBudget(reference, 'softLimit', fromPercent(value))}
                  />
                </div>
              </div>
            );
          })}
        </div>
      ) : null}

      <RouteScheduleFields
        scope="pool"
        schedules={route.schedules}
        onChange={(next) => onChange(setRouteField(route, 'schedules', next.length > 0 ? next : undefined))}
      />
    </div>
  );
};
