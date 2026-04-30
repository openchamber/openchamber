import React from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { RiInformationLine } from '@remixicon/react';

const AGENTS_MD_PATH = '~/.config/opencode/AGENTS.md';

const readApiError = async (response: Response, fallback: string) => {
  const data = await response.json().catch(() => null) as { error?: unknown } | null;
  return typeof data?.error === 'string' && data.error.trim() ? data.error : fallback;
};

const normalizeAgentsMdContent = (content: string) => {
  return content.length > 0 && !content.endsWith('\n') ? `${content}\n` : content;
};

const saveBehaviorSetting = async (globalBehaviorPrompt: string, fallbackError: string) => {
  const response = await fetch('/api/config/settings', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ globalBehaviorPrompt }),
  });

  if (!response.ok) {
    throw new Error(await readApiError(response, fallbackError));
  }
};

export const BehaviorPage: React.FC = () => {
  const { t } = useI18n();
  const [prompt, setPrompt] = React.useState('');
  const [isLoading, setIsLoading] = React.useState(true);
  const [isSaving, setIsSaving] = React.useState(false);
  const [initialPrompt, setInitialPrompt] = React.useState('');

  React.useEffect(() => {
    const abort = new AbortController();

    const load = async () => {
      try {
        const [settingsRes, agentsMdRes] = await Promise.all([
          fetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: abort.signal,
          }),
          fetch('/api/behavior/agents-md', {
            method: 'GET',
            headers: { Accept: 'application/json' },
            signal: abort.signal,
          }),
        ]);

        let settingsPrompt = '';
        if (settingsRes.ok) {
          const data = await settingsRes.json();
          if (typeof data.globalBehaviorPrompt === 'string') {
            settingsPrompt = data.globalBehaviorPrompt;
          }
        }

        if (!settingsPrompt.trim() && agentsMdRes.ok) {
          const agentsData = await agentsMdRes.json();
          if (typeof agentsData.content === 'string') {
            settingsPrompt = agentsData.content;
          }
        }

        setPrompt(settingsPrompt);
        setInitialPrompt(settingsPrompt);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          console.warn('Failed to load behavior settings:', error);
        }
      } finally {
        setIsLoading(false);
      }
    };

    void load();
    return () => abort.abort();
  }, []);

  const isDirty = prompt !== initialPrompt;

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const content = normalizeAgentsMdContent(prompt);
      const response = await fetch('/api/behavior/agents-md', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ content }),
      });

      if (!response.ok) {
        throw new Error(await readApiError(response, t('settings.behavior.page.toast.saveFailed')));
      }

      await saveBehaviorSetting(content, t('settings.behavior.page.toast.saveFailed'));

      setPrompt(content);
      setInitialPrompt(content);
      toast.success(t('settings.behavior.page.toast.saved'));
    } catch (error) {
      console.error('Failed to save behavior:', error);
      const message = error instanceof Error ? error.message : t('settings.behavior.page.toast.saveFailed');
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8 space-y-6">
        <div className="space-y-1">
          <h2 className="typography-ui-header font-semibold text-foreground">
            {t('settings.behavior.page.title')}
          </h2>
        </div>

        <div>
          <div className="mb-1 px-1">
            <div className="flex items-center gap-1.5">
              <h3 className="typography-ui-header font-medium text-foreground">
                {t('settings.behavior.page.section.systemPrompt')}
              </h3>
              <Tooltip>
                <TooltipTrigger asChild>
                  <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  <div className="space-y-1">
                    <p className="font-medium text-foreground">
                      {t('settings.behavior.page.warning.title')}
                    </p>
                    <p>
                      {t('settings.behavior.page.warning.description', { path: AGENTS_MD_PATH })}
                    </p>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <section className="px-2 pb-2 pt-0">
            <Textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t('settings.behavior.page.field.systemPromptPlaceholder')}
              rows={12}
              disabled={isLoading}
              outerClassName="min-h-[160px] max-h-[70vh]"
              className="w-full font-mono typography-meta bg-transparent"
            />
          </section>
        </div>

        <div className="px-2 py-1">
          <Button
            onClick={handleSave}
            disabled={isSaving || !isDirty || isLoading}
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
