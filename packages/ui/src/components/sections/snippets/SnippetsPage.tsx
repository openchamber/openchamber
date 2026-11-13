import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useSnippetsStore, type SnippetDraft, type SnippetScope } from '@/stores/useSnippetsStore';
import { useShallow } from 'zustand/react/shallow';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { normalizeSnippetNameInput, snippetNameProblem } from '@/lib/snippetNames';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsChipGroup,
  SettingsSection,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { SnippetAliasesField } from './SnippetAliasesField';
import type { Snippet } from '@/types/snippet';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';

interface SnippetForm {
  name: string;
  scope: SnippetScope;
  description: string;
  aliases: string[];
  content: string;
}

const sameForm = (a: SnippetForm, b: SnippetForm): boolean => (
  a.name === b.name
  && a.scope === b.scope
  && a.description === b.description
  && a.content === b.content
  && a.aliases.join('\n') === b.aliases.join('\n')
);

// Each draft is its own editor, also when a discarded one is followed by a
// new draft under the same free name.
const draftKeys = new WeakMap<SnippetDraft, number>();
let lastDraftKey = 0;
const draftKey = (draft: SnippetDraft): number => {
  let key = draftKeys.get(draft);
  if (key === undefined) {
    lastDraftKey += 1;
    key = lastDraftKey;
    draftKeys.set(draft, key);
  }
  return key;
};

type ContentMode = 'edit' | 'preview';
type PreviewState = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'failed' };

export const SnippetsPage: React.FC = () => {
  const { t } = useI18n();
  const { selectedSnippetName, snippets, snippetDraft } = useSnippetsStore(useShallow((s) => ({
    selectedSnippetName: s.selectedSnippetName,
    snippets: s.snippets,
    snippetDraft: s.snippetDraft,
  })));

  const selectedSnippet = React.useMemo(
    () => selectedSnippetName
      ? snippets.find((snippet) => snippet.name === selectedSnippetName || snippet.aliases.includes(selectedSnippetName)) ?? null
      : null,
    [selectedSnippetName, snippets],
  );
  const draft = snippetDraft && snippetDraft.name === selectedSnippetName && !selectedSnippet ? snippetDraft : null;

  if (!selectedSnippetName || (!selectedSnippet && !draft)) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="file-text" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-ui-label">{t('settings.snippets.page.empty.title')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.snippets.page.empty.description')}</p>
        </div>
      </div>
    );
  }

  // The form starts over only when another snippet or draft opens; a list
  // reload for the same file keeps the edits in progress.
  const initial: SnippetForm = selectedSnippet
    ? {
      name: selectedSnippet.name,
      scope: selectedSnippet.source,
      description: selectedSnippet.description ?? '',
      aliases: selectedSnippet.aliases,
      content: selectedSnippet.content,
    }
    : {
      name: draft?.name ?? '',
      scope: draft?.scope ?? 'global',
      description: draft?.description ?? '',
      aliases: draft?.aliases ?? [],
      content: draft?.content ?? '',
    };
  return (
    <SnippetEditor
      key={selectedSnippet ? selectedSnippet.filePath : `draft:${draft ? draftKey(draft) : ''}`}
      snippet={selectedSnippet}
      draft={draft}
      initial={initial}
    />
  );
};

const SnippetEditor: React.FC<{ snippet: Snippet | null; draft: SnippetDraft | null; initial: SnippetForm }> = ({ snippet, draft, initial: initialForm }) => {
  const { t } = useI18n();
  const {
    snippets,
    setSnippetDraft,
    setSelectedSnippet,
    setHasUnsavedChanges,
    updateSnippet,
    createSnippet,
    previewSnippet,
  } = useSnippetsStore(useShallow((s) => ({
    snippets: s.snippets,
    setSnippetDraft: s.setSnippetDraft,
    setSelectedSnippet: s.setSelectedSnippet,
    setHasUnsavedChanges: s.setHasUnsavedChanges,
    updateSnippet: s.updateSnippet,
    createSnippet: s.createSnippet,
    previewSnippet: s.previewSnippet,
  })));
  const isNew = snippet === null;

  const [initial, setInitial] = React.useState(initialForm);
  const [form, setForm] = React.useState(initialForm);
  const [isSaving, setIsSaving] = React.useState(false);
  const [contentMode, setContentMode] = React.useState<ContentMode>('edit');
  const [preview, setPreview] = React.useState<PreviewState>({ status: 'loading' });

  const isChanged = !sameForm(form, initial);
  // A new draft saves as it is; only real edits ask before being dropped.
  const canSave = !isSaving && (isNew || isChanged);

  React.useEffect(() => {
    setHasUnsavedChanges(isChanged);
  }, [isChanged, setHasUnsavedChanges]);
  React.useEffect(() => () => setHasUnsavedChanges(false), [setHasUnsavedChanges]);

  const previewContent = contentMode === 'preview' ? form.content : null;
  React.useEffect(() => {
    if (previewContent === null) return;
    let cancelled = false;
    setPreview({ status: 'loading' });
    previewSnippet(previewContent)
      .then((text) => { if (!cancelled) setPreview({ status: 'ready', text }); })
      .catch(() => { if (!cancelled) setPreview({ status: 'failed' }); });
    return () => { cancelled = true; };
  }, [previewContent, previewSnippet]);

  const updateForm = (changes: Partial<SnippetForm>) => setForm((current) => ({ ...current, ...changes }));
  const nameProblem = form.name ? snippetNameProblem(form.name, snippets, snippet ?? undefined) : null;

  const handleSave = async () => {
    const name = form.name.trim();
    if (!name) {
      toast.error(t('settings.snippets.page.toast.nameRequired'));
      return;
    }
    if (nameProblem) {
      toast.error(nameProblem === 'taken' ? t('snippets.name.taken', { name }) : t('snippets.name.invalid'));
      return;
    }
    if (!form.content.trim()) {
      toast.error(t('settings.snippets.page.toast.contentRequired'));
      return;
    }

    setIsSaving(true);
    try {
      const fields = { content: form.content, aliases: form.aliases, description: form.description };
      let result;
      if (snippet) {
        const updates: Parameters<typeof updateSnippet>[1] = { ...fields };
        if (name !== snippet.name) updates.name = name;
        if (form.scope !== snippet.source) updates.scope = form.scope;
        result = await updateSnippet(snippet.name, updates);
      } else {
        result = await createSnippet(name, form.content, { ...fields, scope: form.scope });
      }
      if (!result.ok) {
        toast.error(result.reason === 'taken' ? t('snippets.name.taken', { name }) : t('settings.snippets.page.toast.saveFailed'));
        return;
      }
      toast.success(t('settings.snippets.page.toast.saved'));
      // The saved fields are the new baseline; a rename or a move reopens the
      // snippet under its new file (the store moves the selection).
      setInitial(form);
      // A new snippet opens once saved, unless the user went on to another
      // one while the save was in flight.
      if (isNew && useSnippetsStore.getState().snippetDraft === draft) {
        setSnippetDraft(null);
        setSelectedSnippet(name);
      }
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <SettingsPageLayout
      title={snippet ? `#${snippet.name}` : t('settings.snippets.page.title.new')}
      description={snippet?.filePath}
      showSaveStatus={false}
      fillHeight
    >
      <SettingsSection divider={false} contentClassName="space-y-4">
        <SettingsStackedField label={t('snippets.field.name')}>
          <div className="flex w-full max-w-sm min-w-0 items-center gap-2">
            <Input
              value={form.name}
              onChange={(event) => updateForm({ name: normalizeSnippetNameInput(event.target.value) })}
              placeholder={t('settings.snippets.page.field.namePlaceholder')}
              aria-label={t('snippets.field.name')}
              aria-invalid={nameProblem !== null}
              className="min-w-0 flex-1 px-2"
            />
            <Select value={form.scope} onValueChange={(value) => updateForm({ scope: value === 'project' ? 'project' : 'global' })}>
              <SelectTrigger className="w-fit shrink-0" aria-label={t('snippets.field.scopeAria')}>
                <SelectValue>{form.scope === 'project' ? t('settings.common.scope.project') : t('settings.common.scope.global')}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="global">{t('settings.common.scope.global')}</SelectItem>
                <SelectItem value="project">{t('settings.common.scope.project')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </SettingsStackedField>
        <SettingsStackedField label={t('settings.common.field.description')}>
          <Input
            value={form.description}
            onChange={(event) => updateForm({ description: event.target.value })}
            placeholder={t('settings.snippets.page.field.descriptionPlaceholder')}
            className="w-full max-w-sm px-2"
          />
        </SettingsStackedField>
        <SettingsStackedField label={t('settings.snippets.page.field.aliases')}>
          <SnippetAliasesField
            aliases={form.aliases}
            onChange={(aliases) => updateForm({ aliases })}
            className="max-w-sm"
          />
        </SettingsStackedField>
      </SettingsSection>

      <SettingsSection
        settingsItem="snippets.content"
        title={t('settings.snippets.page.field.content')}
        info={t('settings.snippets.page.contentHint')}
        headerAction={(
          <SettingsChipGroup<ContentMode>
            value={contentMode}
            onChange={setContentMode}
            aria-label={t('settings.snippets.page.content.modeAria')}
            options={[
              { value: 'edit', label: t('settings.snippets.page.content.edit') },
              { value: 'preview', label: t('settings.snippets.page.content.preview') },
            ]}
          />
        )}
        className="flex flex-1 flex-col pb-0"
        contentClassName="flex flex-1 flex-col"
      >
        {contentMode === 'edit' ? (
          <Textarea
            value={form.content}
            onChange={(event) => updateForm({ content: event.target.value })}
            placeholder={t('settings.snippets.page.field.contentPlaceholder')}
            outerClassName="flex-1 min-h-[240px]"
            className="font-mono typography-meta"
          />
        ) : (
          <ScrollableOverlay outerClassName="oc-tile min-h-[240px] flex-1 rounded-[var(--radius-xl)]" className="flex flex-col px-3 py-2.5">
            {preview.status === 'ready' && preview.text ? (
              <pre className="whitespace-pre-wrap break-words font-mono typography-meta text-foreground">{preview.text}</pre>
            ) : (
              <p className="typography-meta text-muted-foreground">
                {preview.status === 'failed'
                  ? t('settings.snippets.page.preview.failed')
                  : preview.status === 'ready' ? t('settings.snippets.page.preview.empty') : null}
              </p>
            )}
          </ScrollableOverlay>
        )}
        <div className="pt-3">
          <Button onClick={handleSave} disabled={!canSave} size="xs" className="!font-normal">
            {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
          </Button>
        </div>
      </SettingsSection>
    </SettingsPageLayout>
  );
};
