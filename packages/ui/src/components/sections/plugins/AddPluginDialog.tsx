import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Radio } from '@/components/ui/radio';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { usePluginsStore, type PluginScope } from '@/stores/usePluginsStore';

type TabKey = 'npm' | 'path' | 'file';

interface AddPluginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultScope?: PluginScope;
}

const FILENAME_PATTERN = /^[a-z0-9][a-z0-9-_.]*\.(js|ts|mjs|cjs)$/;

function parseOptions(raw: string): { ok: true; value?: Record<string, unknown> } | { ok: false } {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: true, value: undefined };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
}

export const AddPluginDialog: React.FC<AddPluginDialogProps> = ({
  open,
  onOpenChange,
  defaultScope = 'user',
}) => {
  const { t } = useI18n();
  const createEntry = usePluginsStore((s) => s.createEntry);
  const createFile = usePluginsStore((s) => s.createFile);

  const [tab, setTab] = React.useState<TabKey>('npm');
  const [spec, setSpec] = React.useState('');
  const [optionsJson, setOptionsJson] = React.useState('');
  const [fileName, setFileName] = React.useState('');
  const [content, setContent] = React.useState('');
  const [scope, setScope] = React.useState<PluginScope>(defaultScope);
  const [submitting, setSubmitting] = React.useState(false);

  const resetForm = React.useCallback(() => {
    setSpec('');
    setOptionsJson('');
    setFileName('');
    setContent('');
    setScope(defaultScope);
  }, [defaultScope]);

  React.useEffect(() => {
    if (open) {
      setTab('npm');
      resetForm();
    }
  }, [open, resetForm]);

  const handleTabChange = (next: TabKey) => {
    if (next === tab) return;
    setTab(next);
    resetForm();
  };

  const optionsResult = React.useMemo(() => parseOptions(optionsJson), [optionsJson]);
  const optionsInvalid = !optionsResult.ok;
  const fileNameInvalid = tab === 'file' && fileName.trim() !== '' && !FILENAME_PATTERN.test(fileName.trim());
  const specEmpty = (tab === 'npm' || tab === 'path') && spec.trim() === '';
  const contentEmpty = tab === 'file' && content.trim() === '';
  const fileNameEmpty = tab === 'file' && fileName.trim() === '';

  const submitDisabled =
    submitting ||
    optionsInvalid ||
    (tab === 'npm' && specEmpty) ||
    (tab === 'path' && specEmpty) ||
    (tab === 'file' && (fileNameEmpty || fileNameInvalid || contentEmpty));

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSubmitting(true);
    try {
      let result;
      if (tab === 'file') {
        result = await createFile({ fileName: fileName.trim(), content, scope });
      } else {
        result = await createEntry({
          spec: spec.trim(),
          options: optionsResult.ok ? optionsResult.value : undefined,
          scope,
        });
      }
      if (result.ok) {
        toast.success(result.message || t('settings.plugins.toast.created'));
        if (result.reloadFailed) {
          toast.warning(t('settings.plugins.toast.reloadFailed'));
        }
        onOpenChange(false);
      } else {
        toast.error(result.message || t('settings.plugins.sidebar.toast.deleteFailed'));
      }
    } finally {
      setSubmitting(false);
    }
  };

  const tabs = React.useMemo<SortableTabsStripItem[]>(() => [
    { id: 'npm', label: t('settings.plugins.dialog.add.tab.npm') },
    { id: 'path', label: t('settings.plugins.dialog.add.tab.path') },
    { id: 'file', label: t('settings.plugins.dialog.add.tab.file') },
  ], [t]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && submitting) return;
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t('settings.plugins.dialog.add.title')}</DialogTitle>
          <DialogDescription>
            {t('settings.plugins.sidebar.empty.description')}
          </DialogDescription>
        </DialogHeader>

        <SortableTabsStrip
          items={tabs}
          activeId={tab}
          onSelect={(id) => handleTabChange(id as TabKey)}
          layoutMode="fit"
          variant="active-pill"
          activePillLowercase={false}
          className="h-10"
        />

        <div className="flex flex-col gap-4">
          {(tab === 'npm' || tab === 'path') && (
            <>
              <div data-settings-item="plugins.spec" className="flex flex-col gap-1.5">
                <label htmlFor="plugin-spec" className="typography-ui-label text-foreground">
                  {t('settings.plugins.page.field.spec')}
                </label>
                <Input
                  id="plugin-spec"
                  value={spec}
                  onChange={(e) => setSpec(e.target.value)}
                  placeholder={t('settings.plugins.page.field.spec.placeholder')}
                  aria-invalid={specEmpty ? false : undefined}
                  disabled={submitting}
                />
                {specEmpty && (
                  <p className="typography-meta text-muted-foreground">
                    {t('settings.plugins.validation.specRequired')}
                  </p>
                )}
              </div>

              <div data-settings-item="plugins.options" className="flex flex-col gap-1.5">
                <label htmlFor="plugin-options" className="typography-ui-label text-foreground">
                  {t('settings.plugins.page.field.options')}
                </label>
                <Textarea
                  id="plugin-options"
                  value={optionsJson}
                  onChange={(e) => setOptionsJson(e.target.value)}
                  rows={5}
                  className="font-mono"
                  hasError={optionsInvalid}
                  disabled={submitting}
                />
                {optionsInvalid && (
                  <p className="typography-meta text-[var(--status-error)]">
                    {t('settings.plugins.page.field.options.invalidJson')}
                  </p>
                )}
              </div>
            </>
          )}

          {tab === 'file' && (
            <>
              <div data-settings-item="plugins.content" className="flex flex-col gap-1.5">
                <label htmlFor="plugin-filename" className="typography-ui-label text-foreground">
                  {t('settings.plugins.page.field.fileName')}
                </label>
                <Input
                  id="plugin-filename"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder="my-plugin.ts"
                  aria-invalid={fileNameInvalid || undefined}
                  disabled={submitting}
                />
                {fileNameInvalid && (
                  <p className="typography-meta text-[var(--status-error)]">
                    {t('settings.plugins.validation.fileName')}
                  </p>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <label htmlFor="plugin-content" className="typography-ui-label text-foreground">
                  {t('settings.plugins.page.field.content')}
                </label>
                <Textarea
                  id="plugin-content"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                  rows={16}
                  className="font-mono"
                  disabled={submitting}
                />
              </div>
            </>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="typography-ui-label text-foreground">
              {t('settings.plugins.page.field.scope')}
            </span>
            <div className="flex items-center gap-4">
              {(['user', 'project'] as const).map((value) => {
                const selected = scope === value;
                const label =
                  value === 'user'
                    ? t('settings.plugins.scope.user')
                    : t('settings.plugins.scope.project');
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setScope(value)}
                    disabled={submitting}
                    className="flex items-center gap-2 py-1 text-left disabled:opacity-50"
                  >
                    <Radio
                      checked={selected}
                      onChange={() => setScope(value)}
                      ariaLabel={label}
                    />
                    <span
                      className={cn(
                        'typography-ui-label font-normal',
                        selected ? 'text-foreground' : 'text-foreground/60',
                      )}
                    >
                      {label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t('settings.plugins.dialog.add.action.cancel')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void handleSubmit();
            }}
            disabled={submitDisabled}
          >
            {submitting ? (
              <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" />
            ) : null}
            {t('settings.plugins.dialog.add.action.submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
