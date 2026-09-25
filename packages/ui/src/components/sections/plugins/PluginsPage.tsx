import React from 'react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import {
  useAutosave,
  AUTOSAVE_SAVED,
  AUTOSAVE_UNCHANGED,
  autosaveFailed,
  type AutosaveResult,
} from '@/components/sections/shared/SettingsAutosave';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { RegistryBanner } from './RegistryBanner';
import { PluginStatusBanner } from './PluginStatusBanner';
import { configEntryRuntimeTarget, pluginFileRuntimeTarget } from './pluginLoadState';
import {
  usePluginsStore,
  getPluginsConfigDirectory,
  type PluginDraft,
  type PluginEntry,
  type PluginFile,
  type PluginScope,
} from '@/stores/usePluginsStore';

interface OptionsParseResult {
  ok: boolean;
  value?: Record<string, unknown>;
}

function parseOptionsJson(raw: string): OptionsParseResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: true, value: undefined };
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

function stringifyOptions(options: Record<string, unknown> | undefined): string {
  if (!options || Object.keys(options).length === 0) {
    return '';
  }
  return JSON.stringify(options, null, 2);
}

function optionsEqual(left: string, right: string): boolean {
  if (left.trim() === right.trim()) return true;
  const parsedLeft = parseOptionsJson(left);
  const parsedRight = parseOptionsJson(right);
  return parsedLeft.ok && parsedRight.ok
    && stringifyOptions(parsedLeft.value) === stringifyOptions(parsedRight.value);
}

function buildEntryDraft(entry: PluginEntry): PluginDraft {
  return {
    mode: 'entry',
    scope: entry.scope,
    spec: entry.spec,
    optionsJson: stringifyOptions(entry.options),
    fileName: '',
    content: '',
  };
}

function buildFileDraft(file: PluginFile, content: string): PluginDraft {
  return {
    mode: 'file',
    scope: file.scope,
    spec: '',
    optionsJson: '',
    fileName: file.fileName,
    content,
  };
}

const ScopeBadge: React.FC<{ scope: PluginScope; label: string }> = ({ scope, label }) => {
  return (
    <span
      className={cn(
        'typography-micro font-medium rounded-full px-2 py-0.5',
        'bg-[var(--surface-elevated)] text-muted-foreground',
        'border border-[var(--interactive-border)]',
      )}
      data-scope={scope}
    >
      {label}
    </span>
  );
};

export const PluginsPage: React.FC = () => {
  const { t } = useI18n();

  const projectDirectory = useProjectsStore((state) => state.getActiveProject()?.path);
  const configDirectory = projectDirectory?.trim() || getPluginsConfigDirectory();
  const loadedDirectory = usePluginsStore((state) => state.loadedDirectory);
  const loadedRuntimeKey = usePluginsStore((state) => state.loadedRuntimeKey);
  const catalogIsCurrent = loadedDirectory === configDirectory && loadedRuntimeKey === getRuntimeKey();
  const selectedId = usePluginsStore((s) => s.selectedId);
  const entries = usePluginsStore((s) => s.entries);
  const files = usePluginsStore((s) => s.files);
  const draft = usePluginsStore((s) => s.draft);
  const setDraft = usePluginsStore((s) => s.setDraft);
  const updateEntry = usePluginsStore((s) => s.updateEntry);
  const updateFile = usePluginsStore((s) => s.updateFile);
  const readFile = usePluginsStore((s) => s.readFile);

  const selectedEntry = React.useMemo(
    () => (selectedId ? entries.find((e) => e.id === selectedId) ?? null : null),
    [entries, selectedId],
  );
  const selectedFile = React.useMemo(
    () => (selectedId ? files.find((f) => f.id === selectedId) ?? null : null),
    [files, selectedId],
  );

  const selectedEntryTarget = React.useMemo(
    () => (selectedEntry ? configEntryRuntimeTarget(selectedEntry.spec, selectedEntry.sourcePath) : null),
    [selectedEntry],
  );
  const selectedFileTarget = React.useMemo(
    () => (selectedFile ? pluginFileRuntimeTarget(selectedFile.absolutePath) : null),
    [selectedFile],
  );

  const [isLoadingFile, setIsLoadingFile] = React.useState(false);
  const originalFileContentById = React.useRef(new Map<string, string>());
  const hydratedDraft = React.useRef<{ id: string; directory: string | null; value: PluginDraft } | null>(null);
  const fileKey = JSON.stringify([configDirectory, selectedId]);

  React.useEffect(() => {
    let cancelled = false;
    if (!catalogIsCurrent) {
      hydratedDraft.current = null;
      setDraft(null);
      return;
    }
    const hydrate = (id: string, value: PluginDraft) => {
      if (usePluginsStore.getState().selectedId !== id || getPluginsConfigDirectory() !== configDirectory) return;
      const previous = hydratedDraft.current;
      const current = usePluginsStore.getState().draft;
      const dirty = previous?.id === id && previous.directory === configDirectory && current !== null && (
        current.spec !== previous.value.spec
        || !optionsEqual(current.optionsJson, previous.value.optionsJson)
        || current.content !== previous.value.content
      );
      hydratedDraft.current = { id, directory: configDirectory, value };
      if (!dirty) setDraft(value);
    };

    if (selectedEntry) {
      hydrate(selectedEntry.id, buildEntryDraft(selectedEntry));
      return () => {
        cancelled = true;
      };
    }

    if (selectedFile) {
      setIsLoadingFile(hydratedDraft.current?.id !== selectedFile.id || hydratedDraft.current.directory !== configDirectory);
      void (async () => {
        const result = await readFile(selectedFile.id);
        if (cancelled || getPluginsConfigDirectory() !== configDirectory) return;
        setIsLoadingFile(false);
        const content = result?.content ?? '';
        originalFileContentById.current.set(fileKey, content);
        hydrate(selectedFile.id, buildFileDraft(selectedFile, content));
      })();
      return () => {
        cancelled = true;
      };
    }

    hydratedDraft.current = null;
    setDraft(null);
    return () => {
      cancelled = true;
    };
  }, [selectedEntry, selectedFile, readFile, setDraft, catalogIsCurrent, configDirectory, fileKey]);

  // One routine for both shapes the page edits: a registry entry (spec +
  // options) and a plugin file (its contents). Text fields commit on blur, so
  // this runs with whatever the draft holds at that moment.
  const save = React.useCallback(async (): Promise<AutosaveResult> => {
    if (!draft || !catalogIsCurrent || getPluginsConfigDirectory() !== configDirectory) return AUTOSAVE_UNCHANGED;

    if (selectedEntry && draft.mode === 'entry') {
      const spec = draft.spec.trim();
      const unchanged = spec === selectedEntry.spec
        && optionsEqual(draft.optionsJson, stringifyOptions(selectedEntry.options));
      if (unchanged) return AUTOSAVE_UNCHANGED;
      if (!spec) return autosaveFailed(t('settings.plugins.validation.specRequired'));
      const options = parseOptionsJson(draft.optionsJson);
      if (!options.ok) return autosaveFailed(t('settings.plugins.page.field.options.invalidJson'));

      const result = await updateEntry(selectedEntry.id, { spec, options: options.value });
      if (!result.ok) {
        return autosaveFailed(result.message || t('settings.plugins.toast.reloadFailed'));
      }
      if (result.reloadFailed) {
        return autosaveFailed(result.warning || result.message || t('settings.plugins.toast.reloadFailed'));
      }
      return AUTOSAVE_SAVED;
    }

    if (selectedFile && draft.mode === 'file') {
      const originalContent = originalFileContentById.current.get(fileKey) ?? '';
      if (draft.content === originalContent) return AUTOSAVE_UNCHANGED;

      const result = await updateFile(selectedFile.id, { content: draft.content });
      if (!result.ok) {
        return autosaveFailed(result.message || t('settings.plugins.toast.reloadFailed'));
      }
      originalFileContentById.current.set(fileKey, draft.content);
      if (result.reloadFailed) {
        return autosaveFailed(result.warning || result.message || t('settings.plugins.toast.reloadFailed'));
      }
      return AUTOSAVE_SAVED;
    }

    return AUTOSAVE_UNCHANGED;
  }, [draft, selectedEntry, selectedFile, t, updateEntry, updateFile, catalogIsCurrent, configDirectory, fileKey]);

  const autosave = useAutosave(save);

  if (!selectedId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="plug" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.plugins.page.empty.select')}</p>
          <p className="typography-meta mt-1 opacity-75">
            {t('settings.plugins.page.empty.add')}
          </p>
        </div>
      </div>
    );
  }

  if (selectedEntry && draft && draft.mode === 'entry') {
    const optionsResult = parseOptionsJson(draft.optionsJson);
    const optionsValid = optionsResult.ok;

    return (
      <SettingsPageLayout
        title={t('settings.plugins.page.header.entry')}
        titleAccessory={(
          <ScopeBadge
            scope={selectedEntry.scope}
            label={
              selectedEntry.scope === 'project'
                ? t('settings.plugins.sidebar.group.projectEntries')
                : t('settings.plugins.sidebar.group.userEntries')
            }
          />
        )}
        onBlurCapture={autosave.onBlurCapture}
      >
        <SettingsSection divider={false}>
          <div className="flex flex-col gap-3">
            <PluginStatusBanner target={selectedEntryTarget} name={selectedEntry.spec} />
            <RegistryBanner entryId={selectedEntry.id} spec={selectedEntry.spec} />
          </div>
        </SettingsSection>

        <SettingsSection
          title={t('settings.plugins.page.field.spec')}
          settingsItem="plugins.spec"
        >
          <Input
            value={draft.spec}
            onChange={(e) =>
              setDraft({ ...draft, spec: e.target.value })
            }
            placeholder={t('settings.plugins.page.field.spec.placeholder')}
            className="font-mono typography-meta"
            spellCheck={false}
          />
        </SettingsSection>

        <SettingsSection
          title={t('settings.plugins.page.field.options')}
          settingsItem="plugins.options"
        >
          <Textarea
            value={draft.optionsJson}
            onChange={(e) =>
              setDraft({ ...draft, optionsJson: e.target.value })
            }
            rows={10}
            className={cn(
              'font-mono typography-meta min-h-[200px]',
              !optionsValid && 'border-[var(--status-error-border)]',
            )}
            spellCheck={false}
            placeholder='{ }'
          />
          {!optionsValid && (
            <p className="typography-micro text-[var(--status-error)]">
              {t('settings.plugins.page.field.options.invalidJson')}
            </p>
          )}
        </SettingsSection>
      </SettingsPageLayout>
    );
  }

  if (selectedFile && draft && draft.mode === 'file') {
    return (
      <SettingsPageLayout
        title={t('settings.plugins.page.header.file')}
        titleAccessory={(
          <>
            <ScopeBadge
              scope={selectedFile.scope}
              label={
                selectedFile.scope === 'project'
                  ? t('settings.plugins.sidebar.group.projectFiles')
                  : t('settings.plugins.sidebar.group.userFiles')
              }
            />
            <span
              className={cn(
                'typography-micro font-mono rounded-full px-2 py-0.5',
                'bg-[var(--surface-elevated)] text-foreground',
                'border border-[var(--interactive-border)]',
              )}
            >
              {selectedFile.fileName}
            </span>
          </>
        )}
        onBlurCapture={autosave.onBlurCapture}
      >
        <SettingsSection divider={false}>
          <PluginStatusBanner target={selectedFileTarget} name={selectedFile.fileName} />
        </SettingsSection>

        <SettingsSection
          title={t('settings.plugins.page.field.content')}
          settingsItem="plugins.content"
        >
          <Textarea
            value={draft.content}
            onChange={(e) =>
              setDraft({ ...draft, content: e.target.value })
            }
            onKeyDown={(event) => {
              // The file editor is long enough that leaving the field to save
              // is a chore; the usual shortcut writes it where you are.
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                autosave.requestSave();
              }
            }}
            rows={16}
            className="font-mono typography-meta min-h-[320px]"
            spellCheck={false}
            disabled={isLoadingFile}
          />
        </SettingsSection>
      </SettingsPageLayout>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center text-muted-foreground">
        <Icon name="loader-4" className="mx-auto mb-3 h-6 w-6 animate-spin opacity-50" />
      </div>
    </div>
  );
};
