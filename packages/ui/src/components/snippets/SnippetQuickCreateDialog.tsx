import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { normalizeSnippetNameInput, snippetNameProblem, suggestSnippetName } from '@/lib/snippetNames';
import { useSnippetsStore, type SnippetQuickCreate, type SnippetScope } from '@/stores/useSnippetsStore';

/**
 * Saves text from the chat as a snippet without leaving it: a message, a
 * selection, the composer's draft. Mounted once per app shell; the store's
 * `quickCreate` opens it.
 */
export const SnippetQuickCreateDialog: React.FC = () => {
  const request = useSnippetsStore((state) => state.quickCreate);
  const closeQuickCreate = useSnippetsStore((state) => state.closeQuickCreate);
  return (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) closeQuickCreate(); }}>
      {request ? <QuickCreateForm request={request} onDone={closeQuickCreate} /> : null}
    </Dialog>
  );
};

const QuickCreateForm: React.FC<{ request: SnippetQuickCreate; onDone: () => void }> = ({ request, onDone }) => {
  const { t } = useI18n();
  const snippets = useSnippetsStore((state) => state.snippets);
  const loadSnippets = useSnippetsStore((state) => state.loadSnippets);
  const createSnippet = useSnippetsStore((state) => state.createSnippet);
  const [name, setName] = React.useState(() => request.name ?? suggestSnippetName(request.content, snippets));
  const [scope, setScope] = React.useState<SnippetScope>('global');
  const [content, setContent] = React.useState(request.content);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    void loadSnippets();
  }, [loadSnippets]);

  const problem = snippetNameProblem(name, snippets);
  const canSave = !saving && problem === null && content.trim().length > 0;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    const result = await createSnippet(name, content, { scope });
    setSaving(false);
    if (!result.ok) {
      toast.error(result.reason === 'taken' ? t('snippets.name.taken', { name }) : t('settings.snippets.page.toast.saveFailed'));
      return;
    }
    toast.success(t('snippets.toast.saved', { name }));
    request.onSaved?.(name);
    onDone();
  };

  return (
    <DialogContent className="max-w-md">
      <DialogHeader>
        <DialogTitle>{request.content ? t('snippets.quickCreate.action') : t('snippets.quickCreate.titleNew')}</DialogTitle>
        <DialogDescription>{t('snippets.quickCreate.description', { name: name || '…' })}</DialogDescription>
      </DialogHeader>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => { event.preventDefault(); void handleSave(); }}
      >
        <div className="flex flex-col gap-1.5">
          <span className="typography-meta font-medium text-muted-foreground">{t('snippets.field.name')}</span>
          <div className="flex items-center gap-2">
            <Input
              value={name}
              onChange={(event) => setName(normalizeSnippetNameInput(event.target.value))}
              aria-invalid={name.length > 0 && problem !== null}
              aria-label={t('snippets.field.name')}
              placeholder={t('settings.snippets.page.field.namePlaceholder')}
              className="min-w-0 flex-1"
              autoFocus
            />
            <Select value={scope} onValueChange={(value) => setScope(value === 'project' ? 'project' : 'global')}>
              <SelectTrigger className="w-fit shrink-0" aria-label={t('snippets.field.scopeAria')}>
                <SelectValue>{scope === 'project' ? t('settings.common.scope.project') : t('settings.common.scope.global')}</SelectValue>
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="global">{t('settings.common.scope.global')}</SelectItem>
                <SelectItem value="project">{t('settings.common.scope.project')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {/* Reserved, so a taken name does not push the content down. */}
          <p className="min-h-4 truncate typography-meta text-[var(--status-error)]" aria-live="polite">
            {name.length > 0 && problem === 'taken' ? t('snippets.name.taken', { name }) : null}
            {name.length > 0 && problem === 'invalid' ? t('snippets.name.invalid') : null}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="typography-meta font-medium text-muted-foreground">{t('settings.snippets.page.field.content')}</span>
          <Textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            placeholder={t('settings.snippets.page.field.contentPlaceholder')}
            rows={6}
            className="max-h-[40vh] font-mono typography-meta"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void handleSave();
              }
            }}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onDone}>{t('settings.common.actions.cancel')}</Button>
          <Button type="submit" disabled={!canSave}>
            {saving ? t('settings.common.actions.saving') : t('snippets.quickCreate.save')}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
};
