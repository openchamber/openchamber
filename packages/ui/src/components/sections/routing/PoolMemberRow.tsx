import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SETTINGS_HELPER_CLASS, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { useI18n } from '@/lib/i18n';
import type { ModelRouteTarget } from '@/lib/routing/modelRoutesApi';
import { fetchWaitEstimate, type WaitEstimate } from '@/lib/routing/routeRulesApi';
import { epochToLocalInput, pruneEmpty, targetEntry, targetLabel, targetReference, targetUntil } from '@/lib/routing/poolAdvanced';
import { memberEffort, memberKind, withMemberEffort, withMemberField } from '@/lib/routing/poolMembers';
import { MODEL_ROUTE_PROVIDER_ID } from '@/lib/sessionErrorRecovery';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

// Select values that stand for "no variant": OpenCode never names a variant with these.
const PROVIDER_DEFAULT = '__provider__';
const SAME_LEVEL = '__same__';
const SKIP_LEVEL = '__skip__';

const levelLabel = (level: string) => level.charAt(0).toUpperCase() + level.slice(1);

/** How long a model stays benched after failing, from the routing history. */
const TargetWait: React.FC<{ providerID: string; modelID: string }> = ({ providerID, modelID }) => {
  const { t } = useI18n();
  const [estimate, setEstimate] = React.useState<WaitEstimate | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    fetchWaitEstimate(providerID, modelID)
      .then((next) => {
        if (!cancelled) setEstimate(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [providerID, modelID]);

  if (!estimate) return null;
  const text = estimate.active
    ? t('settings.pools.wait.cooling', { minutes: Math.ceil(estimate.active.remainingMs / 60_000) })
    : estimate.expectedMs === null
      ? t('settings.pools.wait.none')
      : t('settings.pools.wait.expected', { minutes: Math.ceil(estimate.expectedMs / 60_000) });
  return <span className="typography-meta shrink-0 text-muted-foreground">{text}</span>;
};

/**
 * One model of a pool, with everything that decides how it runs in its own
 * row: its effort, whether that effort is locked, whether the picker shows
 * it, the effort it runs at for each pool level, and its time limit.
 */
export const PoolMemberRow: React.FC<{
  target: ModelRouteTarget;
  /** The levels the pool can be picked at, for the per-level table. */
  levels: readonly string[];
  /** The efforts this member can run at: a model's variants, or a nested pool's levels. */
  variants: readonly string[];
  onChange: (target: ModelRouteTarget) => void;
  onRemove: () => void;
}> = ({ target, levels, variants, onChange, onRemove }) => {
  const { t } = useI18n();
  const id = targetLabel(target);
  const kind = memberKind(target);
  const effort = memberEffort(target);
  const [open, setOpen] = React.useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const name = kind.kind === 'pool' ? kind.poolID : targetReference(target);
  const pickerRef = kind.kind === 'model'
    ? { providerID: kind.providerID, modelID: kind.modelID }
    : kind.kind === 'pool' ? { providerID: MODEL_ROUTE_PROVIDER_ID, modelID: kind.poolID } : null;
  const hidden = useUIStore((state) => pickerRef !== null
    && state.hiddenModels.some((entry) => entry.providerID === pickerRef.providerID && entry.modelID === pickerRef.modelID));
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const modelDefault = useUIStore((state) => (kind.kind === 'model' ? state.modelDefaultVariants[`${kind.providerID}/${kind.modelID}`] : undefined));
  const setModelDefaultVariant = useUIStore((state) => state.setModelDefaultVariant);

  // A stored effort the catalog does not list yet stays selectable, so it is shown as it is.
  const choices = effort.mode !== 'provider' && !variants.includes(effort.variant) ? [...variants, effort.variant] : [...variants];
  const effortValue = effort.mode === 'provider' ? PROVIDER_DEFAULT : effort.variant;
  const pickEffort = (next: string) => {
    if (next === PROVIDER_DEFAULT) onChange(withMemberEffort(target, { mode: 'provider' }));
    // A nested pool is pinned to a level with `#level`; it has no overridable default.
    else if (kind.kind === 'pool' || effort.mode === 'locked') onChange(withMemberEffort(target, { mode: 'locked', variant: next }));
    else onChange(withMemberEffort(target, { mode: 'default', variant: next }));
  };

  const remaps = targetEntry(target).variants ?? {};
  const tableLevels = [...new Set([...levels, ...Object.keys(remaps)])];
  // Only `false` applies to a nested pool or a locked model: the pin wins over a remap.
  const remapChoices = kind.kind === 'pool' || effort.mode === 'locked' ? [] : choices;
  const setRemap = (level: string, value: string) => {
    const next = { ...remaps };
    if (value === SAME_LEVEL) delete next[level];
    else next[level] = value === SKIP_LEVEL ? false : value;
    onChange(withMemberField(target, 'variants', pruneEmpty(next)));
  };
  const until = targetUntil(target);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn('py-1.5', isDragging && 'opacity-60')}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('settings.pools.order.handle', { name })}
          className="flex size-6 shrink-0 cursor-grab touch-none select-none items-center justify-center rounded text-muted-foreground hover:text-foreground"
        >
          <Icon name="draggable" className="size-3.5" />
        </button>
        <ProviderLogo providerId={kind.kind === 'pool' ? MODEL_ROUTE_PROVIDER_ID : kind.providerID} className="size-4 shrink-0" />
        <span className="typography-ui-label min-w-0 flex-1 truncate text-foreground" title={id}>
          {kind.kind === 'pool' ? `${t('settings.pools.targetPool')}: ${name}` : name}
          {until !== undefined ? (
            <span className="typography-meta text-muted-foreground">
              {` · ${t('settings.pools.pattern.untilLabel', { time: new Date(until).toLocaleString() })}`}
            </span>
          ) : null}
        </span>
        {kind.kind === 'model' ? <TargetWait providerID={kind.providerID} modelID={kind.modelID} /> : null}
        <Select value={effortValue} onValueChange={pickEffort}>
          <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.pools.member.effort', { name })}>
            <SelectValue>
              {effortValue === PROVIDER_DEFAULT
                ? (kind.kind === 'pool' ? t('settings.pools.member.anyLevel') : t('settings.pools.member.providerDefault'))
                : levelLabel(effortValue)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={PROVIDER_DEFAULT}>
              {kind.kind === 'pool' ? t('settings.pools.member.anyLevel') : t('settings.pools.member.providerDefault')}
            </SelectItem>
            {choices.map((variant) => <SelectItem key={variant} value={variant}>{levelLabel(variant)}</SelectItem>)}
          </SelectContent>
        </Select>
        {kind.kind === 'pool' ? null : (
          <span className="flex shrink-0 items-center gap-1.5">
            <Checkbox
              checked={effort.mode === 'locked'}
              disabled={effort.mode === 'provider'}
              onChange={(checked) => {
                if (effort.mode === 'provider') return;
                onChange(withMemberEffort(target, { mode: checked ? 'locked' : 'default', variant: effort.variant }));
              }}
              ariaLabel={t('settings.pools.member.lockAria', { name })}
            />
            <span className="typography-meta text-muted-foreground">{t('settings.pools.member.lock')}</span>
            <SettingsInfoHint>{t('settings.pools.member.lockInfo')}</SettingsInfoHint>
          </span>
        )}
        {pickerRef ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-pressed={hidden}
            aria-label={hidden ? t('settings.pools.show', { name }) : t('settings.pools.hide', { name })}
            title={hidden ? t('settings.pools.show', { name }) : t('settings.pools.hide', { name })}
            onClick={() => toggleHiddenModel(pickerRef.providerID, pickerRef.modelID)}
          >
            <Icon name={hidden ? 'eye-off' : 'eye'} className="size-3.5" />
          </Button>
        ) : null}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-expanded={open}
          aria-label={t('settings.pools.member.options', { name })}
          onClick={() => setOpen((value) => !value)}
        >
          <Icon name="more-2" className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label={t('settings.pools.member.remove', { name })}
          title={t('settings.pools.member.remove', { name })}
          onClick={onRemove}
        >
          <Icon name="close" className="size-3.5" />
        </Button>
      </div>
      {open ? (
        <div className="space-y-3 ps-8 pt-2">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <span className="typography-meta font-medium text-foreground">{t('settings.pools.member.byLevel')}</span>
              <SettingsInfoHint>{t('settings.pools.member.byLevelInfo')}</SettingsInfoHint>
            </div>
            {tableLevels.length === 0 ? (
              <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.member.noLevels')}</p>
            ) : tableLevels.map((level) => {
              const stored = remaps[level];
              const value = stored === false ? SKIP_LEVEL : stored ?? SAME_LEVEL;
              const sameLabel = remapChoices.length === 0 ? t('settings.pools.member.runs') : t('settings.pools.member.sameLevel');
              return (
                <div key={level} className="flex items-center gap-2">
                  <span className="typography-meta w-24 shrink-0 truncate text-muted-foreground">{levelLabel(level)}</span>
                  <Select value={value} onValueChange={(next) => setRemap(level, next)}>
                    <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.pools.member.levelAria', { name, level })}>
                      <SelectValue>
                        {value === SAME_LEVEL ? sameLabel : value === SKIP_LEVEL ? t('settings.pools.member.skipLevel') : levelLabel(value)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={SAME_LEVEL}>{sameLabel}</SelectItem>
                      {remapChoices.map((variant) => <SelectItem key={variant} value={variant}>{levelLabel(variant)}</SelectItem>)}
                      <SelectItem value={SKIP_LEVEL}>{t('settings.pools.member.skipLevel')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
          </div>
          {kind.kind === 'pool' ? null : (
            <label className="flex max-w-[24rem] flex-col gap-1">
              <span className="typography-meta text-muted-foreground">{t('settings.pools.target.until')}</span>
              <Input
                type="datetime-local"
                value={epochToLocalInput(until)}
                onChange={(event) => {
                  const next = event.target.value ? new Date(event.target.value).getTime() : undefined;
                  onChange(withMemberField(target, 'until', Number.isFinite(next) ? next : undefined));
                }}
                className="h-8 min-w-0 rounded-md px-2"
              />
            </label>
          )}
          {kind.kind === 'model' ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="typography-meta text-muted-foreground">{t('settings.pools.member.modelDefault')}</span>
              <SettingsInfoHint>{t('settings.pools.member.modelDefaultInfo')}</SettingsInfoHint>
              <Select
                value={modelDefault ?? PROVIDER_DEFAULT}
                onValueChange={(next) => setModelDefaultVariant(kind.providerID, kind.modelID, next === PROVIDER_DEFAULT ? undefined : next)}
              >
                <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.pools.member.modelDefaultAria', { name })}>
                  <SelectValue>{modelDefault ? levelLabel(modelDefault) : t('settings.pools.member.providerDefault')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={PROVIDER_DEFAULT}>{t('settings.pools.member.providerDefault')}</SelectItem>
                  {variants.map((variant) => <SelectItem key={variant} value={variant}>{levelLabel(variant)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
