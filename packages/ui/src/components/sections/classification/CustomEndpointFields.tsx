import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  SettingsFieldRow,
  SettingsSection,
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import type { CustomEndpointInput } from '@/lib/routing/routingApi';
import { useRoutingStore } from '@/stores/useRoutingStore';

// Same footprint as the TypeSafe key row above.
const ROW_CLASS = 'flex w-full min-w-0 items-center gap-2';
const INPUT_CLASS = 'h-8 rounded-md px-3 min-w-0 flex-1';

/**
 * The custom System One endpoint: URL, model and an optional key. Saving
 * picks it on the server, the way saving a TypeSafe key does. The key never
 * comes back from the server, so its field only replaces it. Its own section,
 * below the Jev pick, so the fields read as one block.
 */
export const CustomEndpointFields: React.FC = () => {
  const { t } = useI18n();
  const saved = useRoutingStore((state) => state.customEndpoint);
  const setCustomEndpoint = useRoutingStore((state) => state.setCustomEndpoint);
  const clearCustomEndpoint = useRoutingStore((state) => state.clearCustomEndpoint);

  const [url, setUrl] = React.useState(saved?.url ?? '');
  const [model, setModel] = React.useState(saved?.model ?? '');
  const [key, setKey] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  // The server normalizes the URL, and another client may change it: show what is saved.
  React.useEffect(() => {
    setUrl(saved?.url ?? '');
    setModel(saved?.model ?? '');
  }, [saved?.url, saved?.model]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      setKey('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  const canSave = url.trim().length > 0 && model.trim().length > 0;
  const handleSave = () => {
    if (!canSave) return;
    const endpoint: CustomEndpointInput = { url: url.trim(), model: model.trim() };
    // An empty key field keeps the saved key.
    const typedKey = key.trim();
    if (typedKey) endpoint.key = typedKey;
    void run(() => setCustomEndpoint(endpoint));
  };
  const saveOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') handleSave();
  };

  // Pinned by the server environment: shown, never edited (the server refuses).
  if (saved?.pinned) {
    return (
      <SettingsSection
        title={t('settings.classification.custom.title')}
        info={t('settings.classification.custom.info')}
      >
        <p className={SETTINGS_DESCRIPTION_CLASS}>
          {t('settings.classification.custom.pinned', { url: saved.url, model: saved.model })}
        </p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection
      title={t('settings.classification.custom.title')}
      info={t('settings.classification.custom.info')}
    >
      <div className={SETTINGS_FIELDS_STACK_CLASS}>
        <SettingsFieldRow label={t('settings.classification.custom.url.label')} info={t('settings.classification.custom.url.info')}>
          <div className={ROW_CLASS}>
            <Input
              type="url"
              autoComplete="off"
              spellCheck={false}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              onKeyDown={saveOnEnter}
              placeholder="https://example.com/v1"
              aria-label={t('settings.classification.custom.url.label')}
              className={INPUT_CLASS}
              disabled={busy}
            />
          </div>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.classification.custom.model.label')}>
          <div className={ROW_CLASS}>
            <Input
              autoComplete="off"
              spellCheck={false}
              value={model}
              onChange={(event) => setModel(event.target.value)}
              onKeyDown={saveOnEnter}
              placeholder="jev-latest"
              aria-label={t('settings.classification.custom.model.label')}
              className={INPUT_CLASS}
              disabled={busy}
            />
          </div>
        </SettingsFieldRow>
        <SettingsFieldRow label={t('settings.classification.custom.key.label')} info={t('settings.classification.custom.key.info')}>
          <div className={ROW_CLASS}>
            <Input
              type="password"
              autoComplete="off"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              onKeyDown={saveOnEnter}
              placeholder={saved?.keyPresent
                ? t('settings.classification.custom.key.replacePlaceholder')
                : t('settings.classification.custom.key.placeholder')}
              aria-label={t('settings.classification.custom.key.label')}
              className={INPUT_CLASS}
              disabled={busy}
            />
          </div>
        </SettingsFieldRow>
        {/* Save commits all three fields, so it sits under them in the control column, not in one field's row. */}
        <SettingsFieldRow label={null}>
          <Button size="sm" variant="outline" onClick={handleSave} disabled={busy || !canSave}>
            {t('settings.classification.custom.save')}
          </Button>
          {saved ? (
            <Button size="sm" variant="ghost" onClick={() => void run(clearCustomEndpoint)} disabled={busy}>
              {t('settings.classification.custom.remove')}
            </Button>
          ) : null}
        </SettingsFieldRow>
        {error ? <p className={SETTINGS_DESCRIPTION_CLASS}>{error}</p> : null}
      </div>
    </SettingsSection>
  );
};
