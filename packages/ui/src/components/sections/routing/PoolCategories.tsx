import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { SETTINGS_HELPER_CLASS, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { RoutingCategory, RoutingConfig } from '@/lib/routing/routingApi';
import { MODEL_ROUTE_PROVIDER_ID } from '@/lib/sessionErrorRecovery';

/**
 * The Routing page's draft of the Auto settings and its debounced writer. A
 * category edit on a pool page goes through the same draft and save queue as
 * the Categories tab, so a pending edit there cannot overwrite one made here.
 */
export type RoutingDraftAccess = {
  config: RoutingConfig;
  update: (mutate: (config: RoutingConfig) => RoutingConfig) => void;
};

const slugify = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64);

const runsOn = (category: RoutingCategory, poolID: string) =>
  category.model?.providerID === MODEL_ROUTE_PROVIDER_ID && category.model.modelID === poolID;

/**
 * The Auto categories that send prompts to this pool. The decision model
 * picks a category from its name and description, and for a category on a
 * pool it also reads the pool's description and details, so the two are
 * edited side by side here.
 */
export const PoolCategories: React.FC<{
  poolID: string;
  poolName: string;
  poolDescription: string | undefined;
  /** Absent when Auto routing is not available on this server. */
  routing: RoutingDraftAccess | undefined;
}> = ({ poolID, poolName, poolDescription, routing }) => {
  const { t } = useI18n();
  const [newName, setNewName] = React.useState('');

  if (!routing) return <p className={SETTINGS_HELPER_CLASS}>{t('settings.routing.unavailable')}</p>;

  const using = routing.config.categories.filter((category) => runsOn(category, poolID));
  const others = routing.config.categories.filter((category) => !runsOn(category, poolID));
  const poolModel = { providerID: MODEL_ROUTE_PROVIDER_ID, modelID: poolID };
  // A category needs a description to be judged by; the pool's own one is the best first draft.
  const description = poolDescription?.trim() || t('settings.pools.categories.defaultDescription', { name: poolName });

  const addCategory = () => {
    const name = newName.trim();
    if (!name) return;
    routing.update((config) => {
      const base = slugify(name) || `category-${Date.now()}`;
      let id = base;
      for (let counter = 2; config.categories.some((category) => category.id === id); counter += 1) id = `${base}-${counter}`;
      return {
        ...config,
        categories: [...config.categories, { id, builtin: false, enabled: true, name, description, model: poolModel, variant: null, agent: null }],
      };
    });
    setNewName('');
  };

  return (
    <div className="space-y-3">
      {using.length === 0 ? (
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.categories.none')}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {using.map((category) => (
            <li key={category.id} className="oc-tile-inset typography-meta rounded-full px-2.5 py-0.5 text-foreground">
              {category.name}
            </li>
          ))}
        </ul>
      )}
      {others.length > 0 ? (
        <Select
          value=""
          onValueChange={(id) => routing.update((config) => ({
            ...config,
            categories: config.categories.map((category) => (category.id === id ? { ...category, model: poolModel, variant: null } : category)),
          }))}
        >
          <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.pools.categories.use')}>
            <SelectValue placeholder={t('settings.pools.categories.use')} />
          </SelectTrigger>
          <SelectContent>
            {others.map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}
          </SelectContent>
        </Select>
      ) : null}
      <div className="flex max-w-[24rem] items-center gap-2">
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') addCategory(); }}
          placeholder={t('settings.pools.categories.newName')}
          aria-label={t('settings.pools.categories.newName')}
          className="h-8 min-w-0 flex-1 rounded-md px-3"
          maxLength={60}
        />
        <Button size="sm" variant="outline" onClick={addCategory} disabled={newName.trim().length === 0}>
          {t('settings.pools.categories.add')}
        </Button>
      </div>
    </div>
  );
};
