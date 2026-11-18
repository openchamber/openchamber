import React from 'react';
import { SettingsChipGroup, SettingsFieldRow, SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { BotDefinition } from '@/lib/bots/config';
import { getBotsRuntime } from '@/lib/botsRuntime';
import { useI18n } from '@/lib/i18n';
import { isDomainName } from '@/lib/spaces/space-access';
import { listSpacePlaces, readSpaceCustomProviders, readSpaceHostLogins, readSpacesSwitch } from '@/lib/spaces/spaces-api';
import { spaceFailureText } from '@/components/session/spaces/spaceFailureText';
import { BotSelectField } from './BotFields';
import { BotSpaceGrantFields } from './BotSpaceGrantFields';
import { useBotResource } from './useBotRequest';

const catalogValue = <T,>(result: PromiseSettledResult<T>): T | null => {
  switch (result.status) {
    case 'fulfilled': return result.value;
    case 'rejected': return null;
    default: result satisfies never; throw new TypeError('Unknown inventory result');
  }
};

/** Mounted only for isolated execution. Off means no place, login or provider probes. */
export function BotSpaceFields({ bot, directory, onChange }: {
  readonly bot: BotDefinition; readonly directory: string; readonly onChange: (patch: Partial<BotDefinition>) => void;
}) {
  const { t, locale } = useI18n();
  const space: NonNullable<BotDefinition['space']> = bot.space ?? { network: { mode: 'allowlist', domains: [] }, grants: [] };
  const [domainText, setDomainText] = React.useState(space.network.domains.join('\n'));
  const load = React.useCallback(async () => {
    const signal = getBotsRuntime().signal;
    const enabled = await readSpacesSwitch(signal);
    if (!enabled.enabled) return { kind: 'off' } as const;
    const [places, logins, custom] = await Promise.allSettled([listSpacePlaces(signal), readSpaceHostLogins(signal), readSpaceCustomProviders(directory, signal)]);
    return { kind: 'ready', places: catalogValue(places), logins: catalogValue(logins), custom: catalogValue(custom) } as const;
  }, [directory]);
  const read = useBotResource(load);
  const update = (patch: Partial<NonNullable<BotDefinition['space']>>) => onChange({ space: { ...space, ...patch } });
  const state = read.data;
  let content: React.ReactNode;
  let inventoryFailed = false;
  switch (state?.kind) {
    case undefined: content = read.error ? null : <p role="status" className="typography-meta text-muted-foreground">{t('spaces.create.place.checking')}</p>; break;
    case 'off': content = <p role="status" className="typography-meta text-[var(--status-warning-text)]">{t('bots.space.off')}</p>; break;
    case 'ready': {
      const places = state.places;
      const place = places?.find((entry) => entry.id === space.placeId) ?? (space.placeId ? undefined : places?.[0]);
      const canRestrict = place?.available ? place.hostIsolation : null;
      inventoryFailed = places === null || state.logins === null || state.custom === null;
      content = <>
        <BotSelectField label={t('spaces.create.place.label')} value={space.placeId ?? ''} disabled={places === null}
          onChange={(placeId) => update({ placeId: placeId || undefined })} options={[
            { value: '', label: t('bots.space.defaultPlace') },
            ...(places ?? []).map((entry) => ({ value: entry.id, label: entry.machine ?? t('spaces.create.place.localDocker') })),
            ...(space.placeId && !places?.some((entry) => entry.id === space.placeId) ? [{ value: space.placeId, label: space.placeId }] : []),
          ]} />
        {places !== null && !place ? <p role="status" className="typography-meta text-[var(--status-warning-text)]">{t('bots.space.placeUnavailable')}</p> : null}
        {place && !place.available ? <p role="status" className="typography-meta text-[var(--status-warning-text)]">{spaceFailureText(t, place)}</p> : null}
        {place?.machine ? <p className="typography-meta text-[var(--status-warning-text)]">{t('spaces.create.place.keysOnMachine', { machine: place.machine })}</p> : null}
        <SettingsFieldRow label={t('spaces.create.network.label')} info={t('spaces.create.network.info')}>
          <SettingsChipGroup<NonNullable<BotDefinition['space']>['network']['mode']> value={space.network.mode}
            onChange={(mode) => update({ network: { ...space.network, mode } })} options={[
              { value: 'allowlist', label: t('spaces.create.network.allowlist'), disabled: canRestrict === false },
              { value: 'open', label: t('spaces.create.network.open') },
            ]} />
        </SettingsFieldRow>
        <p role="status" className="min-h-5 typography-meta text-[var(--status-warning-text)]">
          {space.network.mode === 'open' ? t('spaces.create.network.openWarning') : canRestrict === false ? t('spaces.create.network.cannotRestrict') : null}
        </p>
        <SettingsStackedField label={t('bots.space.domains')} description={t('bots.space.domainsHint')}>
          <Textarea dir="ltr" rows={3} spellCheck={false} aria-label={t('bots.space.domains')} disabled={space.network.mode !== 'allowlist'}
            value={domainText} aria-invalid={space.network.domains.some((domain) => !isDomainName(domain)) || undefined}
            onChange={(event) => { setDomainText(event.target.value); update({ network: { ...space.network, domains: event.target.value.split(/\r?\n/).map((domain) => domain.trim().toLowerCase()).filter(Boolean) } }); }} />
        </SettingsStackedField>
        <BotSpaceGrantFields value={space.grants} onChange={(grants) => update({ grants })} logins={state.logins} custom={state.custom} machine={place?.machine ?? null} />
      </>;
      break;
    }
    default: state satisfies never; throw new TypeError('Unknown space configuration state');
  }
  const error = read.error || inventoryFailed ? t('bots.space.inventoryFailed') : '';
  return <SettingsSection title={t('bots.space.title')} info={t('bots.space.references')} contentClassName="space-y-4" className={locale === 'ko' ? 'break-keep' : undefined}
    headerAction={<Button type="button" variant="ghost" size="sm" disabled={read.busy} onClick={read.refresh}>{t('bots.refresh')}</Button>}>
    <div role="alert" className="flex h-5 min-w-0 items-center gap-1.5">
      <p className="truncate typography-meta text-[var(--status-error-text)]" title={error || undefined}>{error}</p>
      {error ? <SettingsInfoHint>{error}</SettingsInfoHint> : null}
    </div>
    {content}
  </SettingsSection>;
}
