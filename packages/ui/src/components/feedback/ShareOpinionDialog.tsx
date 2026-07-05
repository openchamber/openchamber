import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';

type ShareOpinionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const SHARE_OPINION_MARKDOWN = `**Help shape what OpenChamber becomes next!**

Hey 👋,

OpenChamber has grown mostly through word of mouth, GitHub issues, Discord feedback, and people telling me what is broken, confusing, or surprisingly useful.

I'm planning the next chapter now - mobile, better remote access, a tighter VS Code ↔ desktop/web/mobile flow, and more, but before building too much, I want to hear from the people actually using it.

I'm doing a round of short 1-on-1 calls. No sales pitch, no formal script - just a real conversation about how you use OpenChamber, what you love, what frustrates you, and what would make it much more valuable.

You can book a call or use the short survey below.

What you get:

- A direct chance to influence the roadmap
- Your pain points and feature requests prioritized with more context
- A Power User role in Discord for people helping shape the product
- My genuine thanks for helping make OpenChamber better

**This project is what it is because of your feedback. Thank you, genuinely.**

I'll remove this button in two weeks 🙂`;

export function ShareOpinionDialog({ open, onOpenChange }: ShareOpinionDialogProps): React.ReactNode {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogTitle className="sr-only">{t('shareOpinion.dialog.title')}</DialogTitle>
        <SimpleMarkdownRenderer content={SHARE_OPINION_MARKDOWN} className="typography-markdown-body" enableFileReferences={false} />
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-4 py-2.5 typography-ui-label text-foreground hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            onClick={() => void openExternalUrl('https://calendly.com/artmore/30min')}
          >
            <Icon name="video-chat" className="size-5 text-[var(--status-warning)]" />
            {t('shareOpinion.actions.bookCall')}
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-2 rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-4 py-2.5 typography-ui-label text-foreground hover:bg-[var(--interactive-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
            onClick={() => void openExternalUrl('https://forms.gle/cdMVKUGs5QuLWkA86')}
          >
            <Icon name="survey" className="size-5 text-[var(--pr-merged)]" />
            {t('shareOpinion.actions.shortSurvey')}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
