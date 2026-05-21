import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/components/ui';
import { usePromptTemplatesStore } from '@/stores/usePromptTemplatesStore';
import { useShallow } from 'zustand/react/shallow';
import { RiFileTextLine } from '@remixicon/react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';

export const PromptTemplatesPage: React.FC = () => {
  const { t } = useI18n();
  const {
    selectedTemplateId,
    templates,
    updateTemplate,
    createTemplate,
    getTemplateById,
  } = usePromptTemplatesStore(useShallow((s) => ({
    selectedTemplateId: s.selectedTemplateId,
    templates: s.templates,
    updateTemplate: s.updateTemplate,
    createTemplate: s.createTemplate,
    getTemplateById: s.getTemplateById,
  })));

  const selectedTemplate = selectedTemplateId ? getTemplateById(selectedTemplateId) : null;
  const isNew = Boolean(selectedTemplateId && !selectedTemplate && templates.length > 0);

  const [name, setName] = React.useState('');
  const [body, setBody] = React.useState('');
  const [isSaving, setIsSaving] = React.useState(false);
  const initialStateRef = React.useRef<{ name: string; body: string } | null>(null);

  React.useEffect(() => {
    if (selectedTemplate) {
      setName(selectedTemplate.name);
      setBody(selectedTemplate.body);
      initialStateRef.current = { name: selectedTemplate.name, body: selectedTemplate.body };
    } else if (isNew && selectedTemplateId) {
      setName(selectedTemplateId);
      setBody('');
      initialStateRef.current = { name: selectedTemplateId, body: '' };
    }
  }, [selectedTemplate, isNew, selectedTemplateId, templates]);

  const isDirty = React.useMemo(() => {
    const initial = initialStateRef.current;
    if (!initial) return false;
    return name !== initial.name || body !== initial.body;
  }, [name, body]);

  const handleSave = async () => {
    if (!selectedTemplateId) return;

    const trimmedName = name.trim();
    const trimmedBody = body.trim();

    if (!trimmedName) {
      toast.error(t('settings.promptTemplates.page.toast.nameRequired'));
      return;
    }

    setIsSaving(true);
    try {
      if (selectedTemplate) {
        const updates: { name?: string; body?: string } = {};
        if (trimmedName !== selectedTemplate.name) updates.name = trimmedName;
        if (trimmedBody !== selectedTemplate.body) updates.body = trimmedBody;

        if (Object.keys(updates).length > 0) {
          const success = await updateTemplate(selectedTemplateId, updates);
          if (success) {
            toast.success(t('settings.promptTemplates.page.toast.updated'));
            initialStateRef.current = { name: trimmedName, body: trimmedBody };
          } else {
            toast.error(t('settings.promptTemplates.page.toast.updateFailed'));
          }
        }
      } else {
        const success = await createTemplate(selectedTemplateId, trimmedName, trimmedBody);
        if (success) {
          toast.success(t('settings.promptTemplates.page.toast.created'));
          initialStateRef.current = { name: trimmedName, body: trimmedBody };
        } else {
          toast.error(t('settings.promptTemplates.page.toast.createFailed'));
        }
      }
    } catch (error) {
      console.error('Error saving prompt template:', error);
      toast.error(t('settings.promptTemplates.page.toast.saveUnexpectedError'));
    } finally {
      setIsSaving(false);
    }
  };

  if (!selectedTemplateId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <RiFileTextLine className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.promptTemplates.page.empty.title')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.promptTemplates.page.empty.description')}</p>
        </div>
      </div>
    );
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedTemplate ? selectedTemplate.name : t('settings.promptTemplates.page.title.new')}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              {selectedTemplate ? t('settings.promptTemplates.page.subtitle.edit') : t('settings.promptTemplates.page.subtitle.new')}
            </p>
          </div>
        </div>

        <div className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.promptTemplates.page.section.identity')}
            </h3>
          </div>
          <section className="px-2 pb-2 pt-0 space-y-0">
            <div className="py-1.5">
              <span className="typography-ui-label text-foreground">{t('settings.promptTemplates.page.field.name')}</span>
              <div className="mt-1.5">
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('settings.promptTemplates.page.field.namePlaceholder')}
                  className="h-7 w-full max-w-sm px-2"
                  disabled={selectedTemplate?.isDefault === true}
                />
              </div>
            </div>
          </section>
        </div>

        <div className="mb-2">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.promptTemplates.page.section.template')}
            </h3>
          </div>
          <section className="px-2 pb-2 pt-0">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={t('settings.promptTemplates.page.field.templatePlaceholder')}
              rows={12}
              className="w-full font-mono typography-meta min-h-[160px] max-h-[60vh] bg-transparent resize-y"
            />
          </section>
          <div className="mt-2 px-2">
            <p className="typography-meta text-muted-foreground">
              {t('settings.promptTemplates.page.templateHint')}
            </p>
          </div>
        </div>

        <div className="px-2 py-1">
          <Button
            onClick={handleSave}
            disabled={isSaving || !isDirty}
            size="xs"
            className="!font-normal"
          >
            {isSaving ? t('settings.common.actions.saving') : t('settings.common.actions.saveChanges')}
          </Button>
        </div>
      </div>
    </ScrollableOverlay>
  );
};
