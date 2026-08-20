import React from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useI18n } from '@/lib/i18n';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { FusionPreset } from '@/components/chat/FusionAutocomplete';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SETTINGS_HELPER_CLASS,
  SETTINGS_FIELD_LABEL_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';

const MAX_MODELS = 4;
const MIN_MODELS = 2;

type ModelOption = {
  id: string;
  label: string;
};

type ConfigProvider = {
  id: string;
  name: string;
  models: Array<{ id: string; name?: string }>;
};

const PresetEditorDialog: React.FC<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset: FusionPreset | null;
  onSaved: (preset: FusionPreset) => void;
}> = ({ open, onOpenChange, preset, onSaved }) => {
  const { t } = useI18n();
  const storeProviders = useConfigStore((state) => state.providers);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const effectiveDirectory = useEffectiveDirectory();
  const [name, setName] = React.useState('');
  const [description, setDescription] = React.useState('');
  const [models, setModels] = React.useState<string[]>([]);
  const [searchQuery, setSearchQuery] = React.useState('');
  const [options, setOptions] = React.useState<ModelOption[]>([]);
  const [loadingOptions, setLoadingOptions] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // Models the user hid in the model picker are not offered in presets.
  const hiddenSet = React.useMemo(
    () => new Set(hiddenModels.map((hidden) => `${hidden.providerID}/${hidden.modelID}`)),
    [hiddenModels],
  );

  const buildModelOptions = React.useCallback(async (): Promise<ModelOption[]> => {
    const collect = (providers: ConfigProvider[]): ModelOption[] => {
      const flattened: ModelOption[] = [];
      const seen = new Set<string>();
      for (const provider of providers) {
        const providerLabel = provider?.name || provider?.id || '';
        for (const model of Array.isArray(provider?.models) ? provider.models : []) {
          const id = `${provider?.id}/${model?.id}`;
          if (!model?.id || seen.has(id) || hiddenSet.has(id)) continue;
          seen.add(id);
          flattened.push({ id, label: model?.name ? `${providerLabel} · ${model.name}` : id });
        }
      }
      return flattened;
    };

    // The config store is the same normalized, directory-scoped source the
    // model picker uses. The raw API returns models as a record, so the
    // fallback fetch normalizes both shapes defensively.
    if (Array.isArray(storeProviders) && storeProviders.length > 0) {
      return collect(storeProviders as ConfigProvider[]);
    }
    try {
      const { providers } = await opencodeClient.getProvidersForConfig(effectiveDirectory);
      const normalized: ConfigProvider[] = (Array.isArray(providers) ? providers : []).map((provider) => {
        const raw = provider?.models ?? {};
        const models = Array.isArray(raw)
          ? raw
          : Object.keys(raw).map((id) => raw[id]);
        return { ...provider, models: models.filter((model) => model && model.id) };
      });
      return collect(normalized);
    } catch {
      return [];
    }
  }, [effectiveDirectory, hiddenSet, storeProviders]);

  React.useEffect(() => {
    if (!open) return;
    setName(preset?.name ?? '');
    setDescription(preset?.description ?? '');
    setModels(preset?.models ?? []);
    setSearchQuery('');
    setSaveError(null);
    let cancelled = false;
    setLoadingOptions(true);
    void buildModelOptions().then((loaded) => {
      if (!cancelled) setOptions(loaded);
    }).finally(() => {
      if (!cancelled) setLoadingOptions(false);
    });
    return () => {
      cancelled = true;
    };
  }, [buildModelOptions, open, preset]);

  const toggleModel = (id: string) => {
    setModels((current) => (
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : current.length < MAX_MODELS
          ? [...current, id]
          : current
    ));
  };

  // Case-insensitive substring search over the display label (provider · model)
  // and the provider/model id. Selected models stay pinned on top so the user
  // can always review or uncheck them while a query is active.
  const visibleOptions = React.useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return options;
    const selected = new Set(models);
    const matches = options.filter((option) => (
      !selected.has(option.id)
      && (option.label.toLowerCase().includes(query) || option.id.toLowerCase().includes(query))
    ));
    const pinned = options.filter((option) => selected.has(option.id));
    return [...pinned, ...matches];
  }, [models, options, searchQuery]);

  const save = async () => {
    const trimmedName = name.trim();
    if (!trimmedName || models.length < MIN_MODELS || models.length > MAX_MODELS) {
      setSaveError(t('settings.fusion.required'));
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const response = await runtimeFetch(`/api/openchamber/fusion/presets/${encodeURIComponent(trimmedName)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(description.trim() ? { description: description.trim() } : {}),
          models,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setSaveError(typeof body?.error === 'string' ? body.error : response.statusText);
        return;
      }
      const body: { preset?: FusionPreset } = await response.json();
      if (body?.preset) onSaved(body.preset);
      onOpenChange(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const valid = name.trim().length > 0 && models.length >= MIN_MODELS && models.length <= MAX_MODELS;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {preset ? t('settings.fusion.dialogTitleEdit') : t('settings.fusion.dialogTitleNew')}
          </DialogTitle>
          <DialogDescription>{t('settings.fusion.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <label className="block">
          <span className={cn(SETTINGS_FIELD_LABEL_CLASS, 'mb-1 block')}>{t('settings.fusion.nameLabel')}</span>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="deep-dive"
            disabled={Boolean(preset)}
          />
        </label>
        <label className="block">
          <span className={cn(SETTINGS_FIELD_LABEL_CLASS, 'mb-1 block')}>{t('settings.fusion.descriptionLabel')}</span>
          <Textarea
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            rows={2}
            className="resize-y"
          />
        </label>
        <div>
          <span className={cn(SETTINGS_FIELD_LABEL_CLASS, 'mb-1 block')}>
            {t('settings.fusion.modelsLabel', { count: models.length })}
          </span>
          {loadingOptions ? (
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.fusion.loading')}</p>
          ) : options.length === 0 ? (
            <p className={SETTINGS_HELPER_CLASS}>{t('settings.fusion.noModels')}</p>
          ) : (
            <>
              <Input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('settings.fusion.searchModels')}
                className="mb-1.5"
              />
              <div className={cn('oc-scrollbar max-h-44 overflow-auto', SETTINGS_OPTION_STACK_CLASS)}>
                {visibleOptions.length === 0 ? (
                  <p className={cn(SETTINGS_HELPER_CLASS, 'px-2 py-4 text-center')}>
                    {t('settings.fusion.noModelResults')}
                  </p>
                ) : (
                  visibleOptions.map((option) => {
                    const checked = models.includes(option.id);
                    return (
                      <SettingsCheckboxRow
                        key={option.id}
                        checked={checked}
                        onChange={() => toggleModel(option.id)}
                        label={option.label}
                        ariaLabel={option.label}
                        disabled={!checked && models.length >= MAX_MODELS}
                      />
                    );
                  })
                )}
              </div>
              <p className={cn(SETTINGS_HELPER_CLASS, 'mt-1')}>{t('settings.fusion.modelsHint')}</p>
            </>
          )}
        </div>
        {saveError ? (
          <p className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-error)]')}>{saveError}</p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t('settings.fusion.cancel')}
          </Button>
          <Button size="sm" disabled={saving || !valid} onClick={() => void save()}>
            {t('settings.fusion.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const FusionSettings: React.FC = () => {
  const { t } = useI18n();
  const [presets, setPresets] = React.useState<FusionPreset[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [editorOpen, setEditorOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<FusionPreset | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<FusionPreset | null>(null);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await runtimeFetch('/api/openchamber/fusion/presets');
      if (!response.ok) {
        setLoadError(t('settings.fusion.loadError', { error: response.statusText || String(response.status) }));
        return;
      }
      const body: { presets?: FusionPreset[] } = await response.json();
      setPresets(Array.isArray(body?.presets) ? body.presets : []);
    } catch (error) {
      setLoadError(t('settings.fusion.loadError', { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setLoading(false);
    }
  }, [t]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const removePreset = async () => {
    if (!deleteTarget) return;
    try {
      const response = await runtimeFetch(`/api/openchamber/fusion/presets/${encodeURIComponent(deleteTarget.name)}`, {
        method: 'DELETE',
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setLoadError(typeof body?.error === 'string' ? body.error : response.statusText);
        return;
      }
      setPresets((current) => current.filter((entry) => entry.name !== deleteTarget.name));
      setDeleteTarget(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <SettingsSection
      settingsItem="fusion.presets"
      divider={false}
      contentClassName="space-y-3"
      headerAction={(
        <Button size="sm" onClick={() => {
          setEditing(null);
          setEditorOpen(true);
        }}>
          <Icon name="add" className="mr-1 size-4" />
          {t('settings.fusion.add')}
        </Button>
      )}
    >

      {loadError ? (
        <p className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-error)]')}>{loadError}</p>
      ) : null}

      {loading ? (
        <p className={SETTINGS_HELPER_CLASS}>{t('settings.fusion.loading')}</p>
      ) : presets.length === 0 ? (
        <p className={cn(SETTINGS_HELPER_CLASS, 'py-4 text-center')}>
          {t('settings.fusion.empty')}
        </p>
      ) : (
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          {presets.map((preset) => (
            <SettingsFieldRow
              key={preset.name}
              label={
                <span className="inline-flex items-center gap-2">
                  <span>{preset.name}</span>
                  <span className={cn(SETTINGS_HELPER_CLASS, 'rounded-full bg-[var(--interactive-hover)] px-1.5 py-px font-medium leading-4')}>
                    {preset.models.length}
                  </span>
                </span>
              }
              description={
                <>
                  {preset.description ? <span className="block truncate">{preset.description}</span> : null}
                  <span className="block truncate opacity-80">{preset.models.join(' · ')}</span>
                </>
              }
            >
              <Button variant="ghost" size="sm" onClick={() => {
                setEditing(preset);
                setEditorOpen(true);
              }}>
                {t('settings.fusion.edit')}
              </Button>
              <Button variant="ghost" size="sm" className="text-[var(--status-error)]" onClick={() => setDeleteTarget(preset)}>
                {t('settings.fusion.delete')}
              </Button>
            </SettingsFieldRow>
          ))}
        </div>
      )}

      <PresetEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        preset={editing}
        onSaved={(saved) => {
          setPresets((current) => {
            const existing = current.some((entry) => entry.name === saved.name);
            return existing
              ? current.map((entry) => (entry.name === saved.name ? saved : entry))
              : [...current, saved];
          });
        }}
      />

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.fusion.deleteTitle')}</DialogTitle>
            <DialogDescription>
              {deleteTarget ? t('settings.fusion.deleteConfirm', { name: deleteTarget.name }) : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
              {t('settings.fusion.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void removePreset()}>
              {t('settings.fusion.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
};
