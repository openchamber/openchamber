import { ModelKeySource } from '@/components/session/spaces/ModelKeySource';
import type { HostLoginOffer, KeySourceChoice, SpaceModelProviderOption } from '@/components/session/spaces/spaceModelKeys';
import { SettingsCheckboxRow, SettingsControlGroup, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { Input } from '@/components/ui/input';
import type { BotDefinition } from '@/lib/bots/config';
import { useI18n } from '@/lib/i18n';
import { SPACE_LOGIN_NAMES, SPACE_MODEL_PROVIDERS } from '@/lib/spaces/model-access';
import type { SpaceCustomProvider, SpaceHostLogin } from '@/lib/spaces/spaces-api';

type Space = NonNullable<BotDefinition['space']>;
type Grant = Space['grants'][number];

/** Explicit provider choices. The shared Spaces source picker excludes typed keys here. */
export function BotSpaceGrantFields({ value, onChange, logins, custom, machine }: {
  readonly value: Space['grants']; readonly onChange: (grants: Space['grants']) => void;
  readonly logins: readonly SpaceHostLogin[] | null; readonly custom: readonly SpaceCustomProvider[] | null;
  readonly machine: string | null;
}) {
  const { t } = useI18n();
  const providers = new Map<string, SpaceModelProviderOption>(SPACE_MODEL_PROVIDERS.map(({ id, upstream, envName }) => [id, { id, name: id, key: { upstream, envName }, custom: null }]));
  for (const login of logins ?? []) {
    const name = SPACE_LOGIN_NAMES.get(login.provider);
    if (name && !providers.has(login.provider)) providers.set(login.provider, { id: login.provider, name, key: null, custom: null });
  }
  for (const provider of custom ?? []) providers.set(provider.id, { id: provider.id, name: provider.name,
    key: providers.get(provider.id)?.key ?? null,
    custom: { hasKey: provider.hasKey, loopback: provider.loopback, blocked: provider.supported ? null : 'unsupported' },
  });
  // A missing inventory entry never discards an already saved reference.
  for (const grant of value) if (!providers.has(grant.provider)) providers.set(grant.provider, { id: grant.provider, name: grant.provider, key: null, custom: null });
  const replace = (provider: string, grant?: Grant) => onChange([...value.filter((entry) => entry.provider !== provider), ...(grant ? [grant] : [])]);

  return <SettingsControlGroup title={t('spaces.create.access.label')} info={t('bots.space.references')} contentClassName="space-y-4">
    <p className="typography-meta text-[var(--status-warning-text)]">{t('bots.space.missingGrant')}</p>
    {[...providers.values()].map((provider) => {
      const grant = value.find((entry) => entry.provider === provider.id);
      const offered = logins?.find((entry) => entry.provider === provider.id && entry.state === 'usable');
      const loginName = SPACE_LOGIN_NAMES.get(provider.id);
      const login: HostLoginOffer | null = offered && loginName ? { name: loginName, state: offered.state, expires: offered.expires } : null;
      const initial: Grant | undefined = provider.custom?.blocked === null ? { kind: 'custom', provider: provider.id }
        : login ? { kind: 'login', provider: provider.id }
          : provider.key ? { kind: 'model', provider: provider.id, upstream: provider.key.upstream, secret: { kind: 'env', name: provider.key.envName } } : undefined;
      let modelGrant: Extract<Grant, { kind: 'model' }> | undefined;
      let customSource = false;
      let accessUnavailable = false;
      let unavailableLoginName: string | undefined;
      const choice: KeySourceChoice = { source: 'env', envName: provider.key?.envName ?? '', value: '' };
      switch (grant?.kind) {
        case undefined: break;
        case 'model': modelGrant = grant; choice.envName = grant.secret.name; break;
        case 'login': choice.source = 'login'; accessUnavailable = !login; unavailableLoginName = login ? undefined : loginName ?? provider.name; break;
        case 'custom': customSource = true; accessUnavailable = !custom?.some((entry) => entry.id === provider.id && entry.supported); break;
        default: grant satisfies never;
      }
      const modelAccess = modelGrant;
      const updateChoice = (change: Partial<KeySourceChoice>) => {
        const next = { ...choice, ...change };
        switch (next.source) {
          case 'login': replace(provider.id, { kind: 'login', provider: provider.id }); return;
          case 'env': replace(provider.id, { kind: 'model', provider: provider.id, upstream: modelAccess?.upstream ?? provider.key?.upstream ?? '', secret: { kind: 'env', name: next.envName } }); return;
          case 'typed': throw new TypeError('Bots accept host secret references only');
          default: next.source satisfies never;
        }
      };
      const displayProvider = customSource ? provider : { ...provider, custom: null,
        key: modelAccess ? { upstream: modelAccess.upstream, envName: modelAccess.secret.name } : provider.key,
      };
      return <div key={provider.id} className="space-y-2">
        <SettingsCheckboxRow label={<span dir="auto" className="break-all">{provider.name}</span>} ariaLabel={provider.name}
          checked={grant !== undefined} disabled={!grant && (!initial || value.length >= 16)}
          onChange={(selected) => replace(provider.id, selected ? initial : undefined)} />
        {grant ? <div className="max-w-[24rem] space-y-3 ps-6">
          {unavailableLoginName ? <p className="typography-meta text-muted-foreground">{t('spaces.create.access.loginOnly', { name: unavailableLoginName })}</p>
            : <ModelKeySource provider={displayProvider} login={login} choice={choice} onChange={updateChoice} machine={machine} allowTyped={false} />}
          {modelAccess ? <SettingsStackedField label={t('bots.space.upstream')} info={t('bots.space.upstreamHint')}>
            <Input dir="ltr" type="url" autoComplete="off" spellCheck={false} aria-label={t('bots.space.upstream')} value={modelAccess.upstream}
              onChange={(event) => replace(provider.id, { ...modelAccess, upstream: event.target.value })} />
          </SettingsStackedField> : null}
          {accessUnavailable ?
            <p role="status" className="typography-meta text-[var(--status-warning-text)]">{t('bots.space.accessUnavailable')}</p> : null}
        </div> : null}
      </div>;
    })}
  </SettingsControlGroup>;
}
