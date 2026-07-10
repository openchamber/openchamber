import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { RegistryBanner } from './RegistryBanner';
import {
  usePluginsStore,
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

  const [isSaving, setIsSaving] = React.useState(false);
  const [isLoadingFile, setIsLoadingFile] = React.useState(false);
  const originalFileContentById = React.useRef(new Map<string, string>());

  React.useEffect(() => {
    let cancelled = false;

    if (selectedEntry) {
      setDraft(buildEntryDraft(selectedEntry));
      return () => {
        cancelled = true;
      };
    }

    if (selectedFile) {
      setIsLoadingFile(true);
      void (async () => {
        const result = await readFile(selectedFile.id);
        if (cancelled) return;
        setIsLoadingFile(false);
        const content = result?.content ?? '';
        originalFileContentById.current.set(selectedFile.id, content);
        setDraft(buildFileDraft(selectedFile, content));
      })();
      return () => {
        cancelled = true;
      };
    }

    setDraft(null);
    return () => {
      cancelled = true;
    };
  }, [selectedEntry, selectedFile, readFile, setDraft]);

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
    const isDirty =
      draft.spec !== selectedEntry.spec ||
      draft.optionsJson !== stringifyOptions(selectedEntry.options);

    const handleEntryDiscard = () => {
      setDraft(buildEntryDraft(selectedEntry));
    };

    const handleEntrySave = async () => {
      if (!optionsValid) return;
      const spec = draft.spec.trim();
      if (!spec) {
        toast.error(t('settings.plugins.validation.specRequired'));
        return;
      }

      setIsSaving(true);
      try {
        const result = await updateEntry(selectedEntry.id, {
          spec,
          options: optionsResult.value,
        });
        if (result.ok) {
          if (result.reloadFailed) {
            toast.warning(
              result.message || t('settings.plugins.toast.reloadFailed'),
              { description: result.warning },
            );
          } else {
            toast.success(result.message || t('settings.plugins.toast.updated'));
          }
        } else {
          toast.error(result.message || t('settings.plugins.toast.reloadFailed'));
        }
      } finally {
        setIsSaving(false);
      }
    };

    return (
      <SettingsPageLayout
        title={(
          <div className="flex items-center gap-2 min-w-0">
            <h1 className="typography-ui-header font-semibold text-foreground truncate">
              {t('settings.plugins.page.header.entry')}
            </h1>
            <ScopeBadge
              scope={selectedEntry.scope}
              label={
                selectedEntry.scope === 'project'
                  ? t('settings.plugins.sidebar.group.projectEntries')
                  : t('settings.plugins.sidebar.group.userEntries')
              }
            />
          </div>
        )}
        showSaveStatus={false}
      >
        <SettingsSection divider={false}>
          <RegistryBanner entryId={selectedEntry.id} spec={selectedEntry.spec} />
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
          <div className="flex items-center gap-2 pt-3">
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleEntrySave()}
              disabled={!isDirty || !optionsValid || isSaving}
            >
              {t('settings.plugins.page.action.save')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleEntryDiscard}
              disabled={!isDirty || isSaving}
            >
              {t('settings.plugins.page.action.discard')}
            </Button>
          </div>
        </SettingsSection>
      </SettingsPageLayout>
    );
  }

  if (selectedFile && draft && draft.mode === 'file') {
    const originalContent = originalFileContentById.current.get(selectedFile.id) ?? '';
    const isDirty = draft.content !== originalContent || draft.fileName !== selectedFile.fileName;

    const handleFileDiscard = () => {
      void (async () => {
        setIsLoadingFile(true);
        const result = await readFile(selectedFile.id);
        const content = result?.content ?? '';
        setIsLoadingFile(false);
        originalFileContentById.current.set(selectedFile.id, content);
        setDraft(buildFileDraft(selectedFile, content));
      })();
    };

    const handleFileSave = async () => {
      setIsSaving(true);
      try {
        const result = await updateFile(selectedFile.id, { content: draft.content });
        if (result.ok) {
          originalFileContentById.current.set(selectedFile.id, draft.content);
          if (result.reloadFailed) {
            toast.warning(
              result.message || t('settings.plugins.toast.reloadFailed'),
              { description: result.warning },
            );
          } else {
            toast.success(result.message || t('settings.plugins.toast.updated'));
          }
        } else {
          toast.error(result.message || t('settings.plugins.toast.reloadFailed'));
        }
      } finally {
        setIsSaving(false);
      }
    };

    return (
      <SettingsPageLayout
        title={(
          <div className="flex items-center gap-2 min-w-0 flex-wrap">
            <h1 className="typography-ui-header font-semibold text-foreground truncate">
              {t('settings.plugins.page.header.file')}
            </h1>
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
          </div>
        )}
        showSaveStatus={false}
      >
        <SettingsSection
          title={t('settings.plugins.page.field.content')}
          divider={false}
          settingsItem="plugins.content"
        >
          <Textarea
            value={draft.content}
            onChange={(e) =>
              setDraft({ ...draft, content: e.target.value })
            }
            rows={16}
            className="font-mono typography-meta min-h-[320px]"
            spellCheck={false}
            disabled={isLoadingFile}
          />
          <div className="flex items-center gap-2 pt-3">
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleFileSave()}
              disabled={!isDirty || isSaving || isLoadingFile}
            >
              {t('settings.plugins.page.action.save')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleFileDiscard}
              disabled={isSaving || isLoadingFile}
            >
              {t('settings.plugins.page.action.discard')}
            </Button>
          </div>
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
