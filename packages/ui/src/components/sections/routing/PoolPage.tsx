import React from 'react';
import { DndContext, KeyboardSensor, MouseSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import {
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SettingsChipGroup,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { CommitInput, CommitList, CommitTextarea } from '@/components/sections/routing/CommitInput';
import { PoolAdvancedFields } from '@/components/sections/routing/PoolAdvancedFields';
import { PoolCategories, type RoutingDraftAccess } from '@/components/sections/routing/PoolCategories';
import { PoolFailoverFields } from '@/components/sections/routing/PoolFailoverFields';
import { PoolMemberRow } from '@/components/sections/routing/PoolMemberRow';
import { RangedNumberField } from '@/components/sections/routing/RangedNumberField';
import { useI18n } from '@/lib/i18n';
import { modelVariantNames } from '@/lib/modelVariants';
import {
  AUTONOMY_LEVELS,
  POOL_DESCRIPTION_MAX_LENGTH,
  POOL_DETAILS_MAX_LENGTH,
  modelRouteSchema,
  type ModelRoute,
  type ModelRouteTarget,
  type PoolTimeoutSummary,
} from '@/lib/routing/modelRoutesApi';
import { pickedAutonomy, routeReference, routeReferenceID, setRouteField, targetLabel } from '@/lib/routing/poolAdvanced';
import { memberEffort, memberKind, unlockMemberWithRemaps } from '@/lib/routing/poolMembers';
import { MODEL_ROUTE_PROVIDER_ID } from '@/lib/sessionErrorRecovery';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';

type LevelsMode = 'auto' | 'hidden' | 'listed';

/**
 * One pool's own page: what it is for and which Auto categories use it, its
 * models with their efforts, the effort levels the picker offers, how long it
 * waits before moving on, and the rarer settings below. Opened from the pool
 * list and left with the back arrow, so the title always names the pool being
 * edited.
 */
export const PoolPage: React.FC<{
  id: string;
  route: ModelRoute;
  /** The server's wait summary for a saved pool; a draft has none yet. */
  timeoutSummary?: PoolTimeoutSummary;
  /** The Routing page's Auto draft for this pool's categories; absent when Auto is unavailable. */
  routing?: RoutingDraftAccess;
  /** The other pools, which can join this one as a member. */
  otherPoolIDs: readonly string[];
  onChange: (route: ModelRoute) => void;
  onRemove: () => void;
  onBack: () => void;
}> = ({ id, route, timeoutSummary, routing, otherPoolIDs, onChange, onRemove, onBack }) => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const hidden = useUIStore((state) => state.hiddenModels.some((entry) => entry.providerID === MODEL_ROUTE_PROVIDER_ID && entry.modelID === id));
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const [providerId, setProviderId] = React.useState('');
  const [modelId, setModelId] = React.useState('');
  const [pattern, setPattern] = React.useState('');
  const [patternUntil, setPatternUntil] = React.useState('');
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [listLevels, setListLevels] = React.useState(false);
  const [jsonText, setJsonText] = React.useState<string | null>(null);
  const [jsonError, setJsonError] = React.useState<string | null>(null);

  const targets = React.useMemo(() => route.targets ?? [], [route.targets]);
  const name = route.name || id;

  const variantsOf = React.useCallback((provider: string, model: string) => modelVariantNames(
    providers.find((entry) => entry.id === provider)?.models.find((entry) => entry.id === model),
  ), [providers]);
  const memberVariants = (target: ModelRouteTarget, poolLevels: readonly string[]) => {
    const kind = memberKind(target);
    if (kind.kind === 'model') return variantsOf(kind.providerID, kind.modelID);
    if (kind.kind === 'pool') return variantsOf(MODEL_ROUTE_PROVIDER_ID, kind.poolID);
    return [...poolLevels];
  };
  // Every level a member can run, in catalog order: what "automatic" can offer.
  const memberLevels = React.useMemo(() => {
    const levels = new Set<string>();
    for (const target of targets) {
      const kind = memberKind(target);
      if (kind.kind === 'model') variantsOf(kind.providerID, kind.modelID).forEach((level) => levels.add(level));
      else if (kind.kind === 'pool') variantsOf(MODEL_ROUTE_PROVIDER_ID, kind.poolID).forEach((level) => levels.add(level));
    }
    return [...levels];
  }, [targets, variantsOf]);
  const poolLevels = route.levels ?? memberLevels;

  // What OpenCode offers for this pool now, read from its catalog: the
  // authoritative answer after its own rules ran, not a guess from here.
  const routeProvider = providers.find((entry) => entry.id === MODEL_ROUTE_PROVIDER_ID);
  const catalogEntry = routeProvider?.models.find((entry) => entry.id === id);
  const offered = catalogEntry ? modelVariantNames(catalogEntry) : null;

  const levelsMode: LevelsMode = route.levels === undefined ? (listLevels ? 'listed' : 'auto') : route.levels.length === 0 ? 'hidden' : 'listed';
  // A member set to one effort (a locked model, or a pool set to one level) keeps it, and makes an
  // automatic pool offer none. Unlocking only exists for models: OpenCode takes no default or
  // remaps on a pool member, so its level is changed on its own row. Listing levels only matters
  // when some member follows the pool's level.
  const lockedCount = targets.filter((target) => memberEffort(target).mode === 'locked').length;
  const lockedModelCount = targets.filter((target) => memberKind(target).kind !== 'pool' && memberEffort(target).mode === 'locked').length;
  const followsPoolLevel = targets.some((target) => memberEffort(target).mode !== 'locked');

  const setTargets = (next: ModelRouteTarget[]) => onChange({ ...route, targets: next });
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = targets.map(targetLabel);
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    setTargets(arrayMove(targets, from, to));
  };

  const addModel = () => {
    if (!providerId || !modelId) return;
    const reference = `${providerId}/${modelId}`;
    if (!ids.includes(reference)) setTargets([...targets, reference]);
    setProviderId('');
    setModelId('');
  };
  const addPattern = () => {
    const model = pattern.trim();
    const until = patternUntil ? new Date(patternUntil).getTime() : Number.NaN;
    if (model && !ids.includes(model)) setTargets([...targets, Number.isFinite(until) ? { model, until } : model]);
    setPattern('');
    setPatternUntil('');
  };
  const memberPoolIDs = new Set(targets.map(routeReferenceID).filter((poolID) => poolID !== null));
  const addablePools = otherPoolIDs.filter((poolID) => !memberPoolIDs.has(poolID));

  const applyJson = () => {
    if (jsonText === null) return;
    try {
      const parsed = modelRouteSchema.safeParse(JSON.parse(jsonText));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'Invalid pool');
      setJsonError(null);
      setJsonText(null);
      onChange(parsed.data);
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div>
      <div className="mb-6 flex min-w-0 items-center gap-2">
        <SettingsBackButton label={t('settings.pools.backToList')} onClick={onBack} />
        <h2 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'min-w-0 truncate')} title={id}>{name}</h2>
        {route.name ? <span className="typography-meta truncate text-muted-foreground">{id}</span> : null}
        <div className="ms-auto flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            aria-pressed={hidden}
            aria-label={hidden ? t('settings.pools.show', { name }) : t('settings.pools.hide', { name })}
            title={hidden ? t('settings.pools.show', { name }) : t('settings.pools.hide', { name })}
            onClick={() => toggleHiddenModel(MODEL_ROUTE_PROVIDER_ID, id)}
          >
            <Icon name={hidden ? 'eye-off' : 'eye'} className="size-3.5" />
          </Button>
          <Button size="sm" variant="ghost" onClick={onRemove}>{t('settings.pools.remove')}</Button>
        </div>
      </div>

      <SettingsSection title={t('settings.pools.section.about')} divider={false}>
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsStackedField label={t('settings.pools.name')} info={t('settings.pools.nameInfo')} controlClassName="max-w-none">
            <CommitInput label={t('settings.pools.name')} value={route.name ?? ''} placeholder={id} onCommit={(next) => onChange(setRouteField(route, 'name', next || undefined))} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.pools.poolDescription')} info={t('settings.pools.poolDescriptionInfo')} controlClassName="max-w-none">
            <CommitInput
              label={t('settings.pools.poolDescription')}
              value={route.description ?? ''}
              placeholder={t('settings.pools.poolDescriptionPlaceholder')}
              maxLength={POOL_DESCRIPTION_MAX_LENGTH}
              onCommit={(next) => onChange(setRouteField(route, 'description', next || undefined))}
            />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.pools.poolDetails')} info={t('settings.pools.poolDetailsInfo')} controlClassName="max-w-none">
            <CommitTextarea
              label={t('settings.pools.poolDetails')}
              value={route.details ?? ''}
              placeholder={t('settings.pools.poolDetailsPlaceholder')}
              maxLength={POOL_DETAILS_MAX_LENGTH}
              onCommit={(next) => onChange(setRouteField(route, 'details', next || undefined))}
            />
          </SettingsStackedField>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.pools.section.models')}>
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              <div className="divide-y divide-border/40">
                {targets.map((target, index) => (
                  <PoolMemberRow
                    key={ids[index]}
                    target={target}
                    levels={poolLevels}
                    variants={memberVariants(target, poolLevels)}
                    onChange={(next) => setTargets(targets.map((entry, position) => (position === index ? next : entry)))}
                    onRemove={() => setTargets(targets.filter((_, position) => position !== index))}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          <div className="flex w-full min-w-0 max-w-[32rem] items-center gap-2">
            <ModelSelector
              providerId={providerId}
              modelId={modelId}
              onChange={(nextProvider, nextModel) => {
                setProviderId(nextProvider);
                setModelId(nextModel);
              }}
              className={cn(SETTINGS_CUSTOM_TRIGGER_CLASS, 'w-full')}
              placeholder={t('settings.pools.addTargetPlaceholder')}
            />
            <Button size="sm" variant="outline" onClick={addModel} disabled={!providerId || !modelId}>{t('settings.pools.addTarget')}</Button>
          </div>
          {addablePools.length > 0 ? (
            <SettingsStackedField label={t('settings.pools.addPoolTarget')} info={t('settings.pools.addPoolTargetInfo')}>
              <Select value="" onValueChange={(poolID) => setTargets([...targets, routeReference(poolID)])}>
                <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.pools.addPoolTarget')}>
                  <SelectValue placeholder={t('settings.pools.addPoolTargetPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {addablePools.map((poolID) => <SelectItem key={poolID} value={poolID}>{poolID}</SelectItem>)}
                </SelectContent>
              </Select>
            </SettingsStackedField>
          ) : null}
          <SettingsStackedField label={t('settings.pools.pattern.label')} info={t('settings.pools.pattern.info')} controlClassName="max-w-[32rem]">
            <div className="flex w-full min-w-0 flex-wrap items-center gap-2">
              <Input
                value={pattern}
                onChange={(event) => setPattern(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') addPattern(); }}
                placeholder={t('settings.pools.pattern.placeholder')}
                aria-label={t('settings.pools.pattern.label')}
                className="h-8 min-w-0 flex-1 rounded-md px-3"
                maxLength={200}
              />
              <Input
                type="datetime-local"
                value={patternUntil}
                onChange={(event) => setPatternUntil(event.target.value)}
                aria-label={t('settings.pools.pattern.until')}
                title={t('settings.pools.pattern.untilInfo')}
                className="h-8 w-auto min-w-0 rounded-md px-2"
              />
              <Button size="sm" variant="outline" onClick={addPattern} disabled={!pattern.trim()}>{t('settings.pools.pattern.add')}</Button>
            </div>
          </SettingsStackedField>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.pools.section.effort')} info={t('settings.pools.effort.info')}>
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsChipGroup<LevelsMode>
            value={levelsMode}
            aria-label={t('settings.pools.section.effort')}
            options={[
              { value: 'auto', label: t('settings.pools.effort.auto') },
              { value: 'hidden', label: t('settings.pools.effort.hidden') },
              { value: 'listed', label: t('settings.pools.effort.listed') },
            ]}
            onChange={(mode) => {
              setListLevels(mode === 'listed');
              if (mode === 'auto') onChange(setRouteField(route, 'levels', undefined));
              else if (mode === 'hidden') onChange(setRouteField(route, 'levels', []));
              else if (memberLevels.length > 0 && !route.levels?.length) onChange(setRouteField(route, 'levels', memberLevels));
            }}
          />
          {levelsMode === 'listed' ? (
            <div className="max-w-[24rem]">
              <CommitList
                label={t('settings.pools.effort.levels')}
                value={route.levels}
                placeholder={t('settings.pools.effort.levelsPlaceholder')}
                onCommit={(levels) => onChange(setRouteField(route, 'levels', levels))}
              />
            </div>
          ) : null}
          {offered === null ? null : (
            <p className={SETTINGS_HELPER_CLASS}>
              {offered.length > 0 ? t('settings.pools.effort.offered', { levels: offered.join(', ') }) : t('settings.pools.effort.offeredNone')}
            </p>
          )}
          {route.levels === undefined && lockedCount > 0 ? (
            <div className="space-y-2 rounded-md bg-[var(--status-warning-background)] p-3">
              <p className="typography-meta text-[var(--status-warning-text)]">{t('settings.pools.effort.lockedWarning')}</p>
              <div className="flex flex-wrap gap-2">
                {lockedModelCount > 0 ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={memberLevels.length === 0}
                    onClick={() => setTargets(targets.map((target) => (memberKind(target).kind === 'pool' ? target : unlockMemberWithRemaps(target, memberLevels))))}
                  >
                    {t('settings.pools.effort.fixUnlock')}
                  </Button>
                ) : null}
                {followsPoolLevel ? (
                  <Button size="sm" variant="outline" disabled={memberLevels.length === 0} onClick={() => onChange(setRouteField(route, 'levels', memberLevels))}>
                    {t('settings.pools.effort.fixList')}
                  </Button>
                ) : null}
                <Button size="sm" variant="outline" onClick={() => onChange(setRouteField(route, 'levels', []))}>
                  {t('settings.pools.effort.fixHide')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.pools.section.categories')} info={t('settings.pools.categories.info')}>
        <PoolCategories poolID={id} poolName={name} poolDescription={route.description} routing={routing} />
      </SettingsSection>

      <SettingsSection title={t('settings.pools.section.failover')}>
        {/* The server also counts pools named in include and match, so its list wins once the pool is saved. */}
        <PoolFailoverFields
          route={route}
          nestsPools={timeoutSummary ? timeoutSummary.nested.length > 0 : memberPoolIDs.size > 0}
          summary={timeoutSummary}
          onChange={onChange}
        />
      </SettingsSection>

      <SettingsSection title={t('settings.pools.section.matching')} info={t('settings.pools.matching.info')}>
        <div className="grid grid-cols-1 gap-3 @xl:grid-cols-2">
          {(['include', 'exclude', 'contains', 'notContains'] as const).map((key) => (
            <label key={key} className="flex min-w-0 flex-col gap-1">
              <span className="typography-meta text-muted-foreground">{t(`settings.pools.matching.${key}`)}</span>
              <CommitList label={t(`settings.pools.matching.${key}`)} value={route[key]} onCommit={(value) => onChange(setRouteField(route, key, value))} />
            </label>
          ))}
          <label className="flex min-w-0 flex-col gap-1 @xl:col-span-2">
            <span className="typography-meta text-muted-foreground">{t('settings.pools.matching.match')}</span>
            <CommitInput
              label={t('settings.pools.matching.match')}
              value={route.match ?? ''}
              placeholder={t('settings.pools.matching.matchPlaceholder')}
              maxLength={2000}
              onCommit={(next) => onChange(setRouteField(route, 'match', next || undefined))}
            />
          </label>
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.pools.section.more')}>
        <div className={SETTINGS_FIELDS_STACK_CLASS}>
          <SettingsStackedField label={t('settings.pools.autonomy')} info={t('settings.pools.autonomyInfo')}>
            <Select value={route.autonomy ?? '__unset__'} onValueChange={(next) => onChange(setRouteField(route, 'autonomy', pickedAutonomy(next)))}>
              <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.pools.autonomy')}>
                {/* The select shows its raw value unless given the label; `__unset__` is internal. */}
                <SelectValue>{route.autonomy ? t(`settings.pools.autonomy.${route.autonomy}`) : t('settings.pools.autonomyDefault')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unset__">{t('settings.pools.autonomyDefault')}</SelectItem>
                {AUTONOMY_LEVELS.map((level) => <SelectItem key={level} value={level}>{t(`settings.pools.autonomy.${level}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </SettingsStackedField>
          <p className={SETTINGS_HELPER_CLASS}>{t(`settings.pools.autonomyHelp.${route.autonomy ?? 'unset'}`)}</p>
          <div className="space-y-2">
            <Button size="sm" variant="ghost" onClick={() => setAdvancedOpen((open) => !open)} aria-expanded={advancedOpen}>
              {advancedOpen ? t('settings.pools.advanced.hide') : t('settings.pools.advanced.show')}
            </Button>
            {advancedOpen ? <PoolAdvancedFields route={route} onChange={onChange} /> : null}
          </div>
          <SettingsStackedField label={t('settings.pools.system')} info={t('settings.pools.systemInfo')} controlClassName="max-w-none">
            <CommitTextarea label={t('settings.pools.system')} value={route.system ?? ''} maxLength={20_000} onCommit={(next) => onChange(setRouteField(route, 'system', next || undefined))} />
          </SettingsStackedField>
          <div className="max-w-[12rem]">
            <RangedNumberField
              label={t('settings.pools.contextLimit')}
              value={route.limit?.context}
              min={1}
              max={100_000_000}
              onCommit={(value) => onChange(setRouteField(route, 'limit', value === undefined ? undefined : { context: value }))}
            />
          </div>
          <SettingsStackedField label={t('settings.pools.expertJson')} info={t('settings.pools.expertJsonInfo')} controlClassName="max-w-none">
            <Textarea
              value={jsonText ?? JSON.stringify(route, null, 2)}
              onChange={(event) => setJsonText(event.target.value)}
              aria-label={t('settings.pools.expertJson')}
              rows={8}
              className="w-full font-mono text-xs"
              spellCheck={false}
            />
          </SettingsStackedField>
          {jsonError ? <p className={SETTINGS_HELPER_CLASS}>{jsonError}</p> : null}
          {jsonText !== null ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={applyJson}>{t('settings.pools.applyJson')}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setJsonText(null); setJsonError(null); }}>{t('settings.pools.discardJson')}</Button>
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </div>
  );
};
