import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { useSnippetsStore, type SnippetScope } from '@/stores/useSnippetsStore';
import { useShallow } from 'zustand/react/shallow';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';

export const SnippetsPage: React.FC = () => {
  const { t } = useI18n();
  const { selectedSnippetName, snippets, snippetDraft, setSnippetDraft, updateSnippet, createSnippet } = useSnippetsStore(useShallow((s) => ({
    selectedSnippetName: s.selectedSnippetName,
    snippets: s.snippets,
    snippetDraft: s.snippetDraft,
    setSnippetDraft: s.setSnippetDraft,
    updateSnippet: s.updateSnippet,
    createSnippet: s.createSnippet,
  })));

  const selectedSnippet = React.useMemo(
    () => selectedSnippetName
      ? snippets.find((snippet) => snippet.name === selectedSnippetName || snippet.aliases.includes(selectedSnippetName)) ?? null
      : null,
    [selectedSnippetName, snippets],
  );
  const isNew = Boolean(snippetDraft && snippetDraft.name === selectedSnippetName && !selectedSnippet);
  const [draftName, setDraftName] = React.useState('');
  const [draftScope, setDraftScope] = React.useState<SnippetScope>('global');
  const [description, setDescription] = React.useState('');
  const [aliases, setAliases] = React.useState('');
  const [content, setContent] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const initialStateRef = React.useRef<{ draftName: string; draftScope: SnippetScope; description: string; aliases: string; content: string } | null>(null);

  React.useEffect(() => {
    if (isNew && snippetDraft) {
      const next = {
        draftName: snippetDraft.name || '',
        draftScope: snippetDraft.scope || 'global',
        description: snippetDraft.description || '',
        aliases: (snippetDraft.aliases || []).join(', '),
        content: snippetDraft.content || '',
      };
      setDraftName(next.draftName);
      setDraftScope(next.draftScope);
      setDescription(next.description);
      setAliases(next.aliases);
      setContent(next.content);
      initialStateRef.current = next;
    } else if (selectedSnippet) {
      const next = {
        draftName: '',
        draftScope: 'global' as SnippetScope,
        description: selectedSnippet.description ?? '',
        aliases: selectedSnippet.aliases.join(', '),
        content: selectedSnippet.content,
      };
      setDescription(next.description);
      setAliases(next.aliases);
      setContent(next.content);
      initialStateRef.current = next;
    }
  }, [selectedSnippet, isNew, selectedSnippetName, snippetDraft]);

  const isDirty = React.useMemo(() => {
    const initial = initialStateRef.current;
    if (!initial) return false;
    if (isNew && draftName !== initial.draftName) return true;
    if (isNew && draftScope !== initial.draftScope) return true;
    return description !== initial.description || aliases !== initial.aliases || content !== initial.content;
  }, [aliases, content, description, draftName, draftScope, isNew]);

  const handleSave = async () => {
    const snippetName = isNew ? draftName.trim().replace(/\s+/g, '-') : selectedSnippetName?.trim();
    if (!snippetName) {
      toast.error(t('settings.snippets.page.toast.nameRequired'));
      return;
    }

    if (!content.trim()) {
      toast.error(t('settings.snippets.page.toast.contentRequired'));
      return;
    }

    const parsedAliases = aliases.split(',').map((alias) => alias.trim()).filter(Boolean);

    setIsSaving(true);
    try {
      const success = isNew
        ? await createSnippet(snippetName, content, { aliases: parsedAliases, description, scope: draftScope })
        : await updateSnippet(snippetName, { content, aliases: parsedAliases, description });
      if (!success) {
        toast.error(t('settings.snippets.page.toast.saveFailed'));
        return;
      }
      toast.success(t('settings.snippets.page.toast.saved'));
      if (isNew) setSnippetDraft(null);
    } finally {
      setIsSaving(false);
    }
  };

  if (!selectedSnippetName) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="file-text" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.snippets.page.empty.title')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.snippets.page.empty.description')}</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
        <div className="mb-4 min-w-0">
          <h2 className="typography-ui-header font-semibold text-foreground truncate">
            {isNew ? t('settings.snippets.page.title.new') : `#${selectedSnippetName}`}
          </h2>
          {selectedSnippet ? <p className="typography-meta text-muted-foreground truncate">{selectedSnippet.filePath}</p> : null}
        </div>

        <div className="mb-8 space-y-3 px-2">
          <div>
            {isNew ? (
              <div className="mb-3 flex items-center gap-2">
                <span className="typography-ui-label text-foreground">#</span>
                <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder={t('settings.snippets.page.field.namePlaceholder')} className="h-7 w-44 px-2" />
                <Select value={draftScope} onValueChange={(value) => setDraftScope(value as SnippetScope)}>
                  <SelectTrigger className="w-fit min-w-[100px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent align="end">
                    <SelectItem value="global">{t('settings.common.scope.global')}</SelectItem>
                    <SelectItem value="project">{t('settings.common.scope.project')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <span className="typography-ui-label text-foreground">{t('settings.common.field.description')}</span>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('settings.snippets.page.field.descriptionPlaceholder')} className="mt-1.5 h-7 w-full max-w-sm px-2" />
          </div>
          <div>
            <span className="typography-ui-label text-foreground">{t('settings.snippets.page.field.aliases')}</span>
            <Input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder={t('settings.snippets.page.field.aliasesPlaceholder')} className="mt-1.5 h-7 w-full max-w-sm px-2" />
          </div>
        </div>

        <div data-settings-item="snippets.content" className="mb-2 px-2">
          <span className="typography-ui-label text-foreground">{t('settings.snippets.page.field.content')}</span>
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder={t('settings.snippets.page.field.contentPlaceholder')} rows={12} className="mt-1.5 w-full font-mono typography-meta min-h-[160px] max-h-[60vh] bg-transparent" />
          <p className="mt-2 typography-meta text-muted-foreground">{t('settings.snippets.page.hint')}</p>
        </div>

        <div className="px-2 py-1">
          <Button onClick={handleSave} disabled={isSaving || !isDirty} size="xs" className="!font-normal">
            {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
          </Button>
        </div>
      </div>
    </ScrollableOverlay>
  );
};
