import React from 'react';
import { Switch } from '@/components/ui/switch';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { RangedNumberField } from '@/components/sections/routing/RangedNumberField';
import { useI18n } from '@/lib/i18n';
import { fetchRotation, saveRotation, type RotationState } from '@/lib/routing/poolHealthApi';

// A rejected request carries an Error; anything else thrown is shown as text.
const errorText = (failure: Error | string) => (failure instanceof Error ? failure.message : failure);

/**
 * Staggered rotation: one switch, the pace, and the recent moves. The
 * description stays visible because turning it on moves sessions out of
 * their pool.
 */
export const PoolRotationFields: React.FC<{ reloadKey?: string }> = ({ reloadKey }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<RotationState | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  // Bumped by every save: a read that started before a save must not replace what the save answered.
  const revisionRef = React.useRef(0);

  React.useEffect(() => {
    let cancelled = false;
    const revision = revisionRef.current;
    fetchRotation()
      .then((next) => {
        if (cancelled || revision !== revisionRef.current) return;
        setState(next);
        setError(null);
      })
      .catch((failure: Error) => {
        if (!cancelled) setError(t('settings.pools.rotation.loadFailed', { error: errorText(failure) }));
      });
    return () => {
      cancelled = true;
    };
  }, [t, reloadKey]);

  const save = (patch: Partial<RotationState['settings']>) => {
    revisionRef.current += 1;
    setSaving(true);
    saveRotation(patch)
      .then((next) => {
        setState(next);
        setError(null);
      })
      .catch((failure: Error) => setError(errorText(failure)))
      .finally(() => setSaving(false));
  };

  if (!state) return error ? <p className={SETTINGS_HELPER_CLASS}>{error}</p> : null;

  return (
    <div className="space-y-2" data-settings-item="routing.pools-rotation">
      <label className="flex items-center gap-3">
        <Switch
          checked={state.settings.enabled}
          disabled={saving}
          onCheckedChange={(enabled) => save({ enabled })}
          aria-label={t('settings.pools.rotation.enable')}
        />
        <span className="typography-ui-label text-foreground">{t('settings.pools.rotation.enable')}</span>
      </label>
      <p className={SETTINGS_HELPER_CLASS}>{t('settings.pools.rotation.description')}</p>
      {error ? <p className={SETTINGS_HELPER_CLASS}>{error}</p> : null}
      {state.settings.enabled ? (
        <div className="max-w-[16rem]">
          <RangedNumberField
            label={t('settings.pools.rotation.interval')}
            value={state.settings.intervalMinutes}
            min={1}
            max={60}
            placeholder="5"
            onCommit={(intervalMinutes) => {
              if (intervalMinutes !== undefined) save({ intervalMinutes });
            }}
          />
        </div>
      ) : null}
      {state.moves.length > 0 ? (
        <div className="space-y-1">
          <p className="typography-meta text-muted-foreground">{t('settings.pools.rotation.recent')}</p>
          {state.moves.map((move) => (
            <p key={`${move.sessionID}-${move.at}`} className="typography-meta text-muted-foreground truncate">
              {new Date(move.at).toLocaleTimeString()}{' · '}
              {move.subagent
                ? t('settings.pools.rotation.moveSubagent', { session: move.sessionID, from: move.from, to: move.to })
                : t('settings.pools.rotation.move', { session: move.sessionID, from: move.from, to: move.to })}
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
};
