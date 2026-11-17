import React from 'react';
import { Switch } from '@/components/ui/switch';
import { SETTINGS_HELPER_CLASS } from '@/components/sections/shared/SettingsSection';
import { RangedNumberField } from '@/components/sections/routing/RangedNumberField';
import { useI18n } from '@/lib/i18n';
import { fetchRotation, saveRotation, type RotationState } from '@/lib/routing/poolHealthApi';

// A rejected request carries an Error; anything else thrown is shown as text.
const errorText = (failure: Error | string) => (failure instanceof Error ? failure.message : failure);

const SLOT = '\u2063';

/**
 * A translated sentence with session ids and model refs inside it: the
 * sentence keeps the UI's direction, and each value reads left to right in its
 * own isolated span, so an Arabic or Hebrew line does not reorder them.
 */
const IsolatedSentence: React.FC<{ text: (slots: Record<string, string>) => string; values: Record<string, string> }> = ({ text, values }) => {
  const slots = Object.fromEntries(Object.keys(values).map((name) => [name, `${SLOT}${name}${SLOT}`]));
  return (
    <>
      {text(slots).split(SLOT).map((part, index) => (
        index % 2 === 1 && part in values
          ? <span key={index} dir="ltr" className="[unicode-bidi:isolate]">{values[part]}</span>
          : <React.Fragment key={index}>{part}</React.Fragment>
      ))}
    </>
  );
};

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
  // Bumped when a save starts and when it ends: a read that overlapped a save,
  // whenever it answers, must not replace what the save answered.
  const revisionRef = React.useRef(0);
  // Only the newest save's answer lands; an older one finishing late is dropped.
  const saveSeqRef = React.useRef(0);

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
        if (cancelled || revision !== revisionRef.current) return;
        setError(t('settings.pools.rotation.loadFailed', { error: errorText(failure) }));
      });
    return () => {
      cancelled = true;
    };
  }, [t, reloadKey]);

  const save = (patch: Partial<RotationState['settings']>) => {
    revisionRef.current += 1;
    const seq = ++saveSeqRef.current;
    setSaving(true);
    saveRotation(patch)
      .then((next) => {
        if (seq !== saveSeqRef.current) return;
        setState(next);
        setError(null);
      })
      .catch((failure: Error) => {
        if (seq === saveSeqRef.current) setError(errorText(failure));
      })
      .finally(() => {
        revisionRef.current += 1;
        if (seq === saveSeqRef.current) setSaving(false);
      });
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
            disabled={saving}
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
              <IsolatedSentence
                text={(slots) => t(move.subagent ? 'settings.pools.rotation.moveSubagent' : 'settings.pools.rotation.move', slots)}
                values={{ session: move.sessionID, from: move.from, to: move.to }}
              />
            </p>
          ))}
        </div>
      ) : null}
    </div>
  );
};
