import React from 'react';
import { SimpleMarkdownRenderer } from '@/components/chat/MarkdownRenderer';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { linkReleaseNoteMentions, type ReleaseNotesContent, type ReleaseNotesGroupKey } from './releaseNotes';

/** Lines each group shows until the person asks for the rest. */
const GROUP_PREVIEW = 3;

const GROUP_LABEL_KEYS = {
  new: 'releaseNotes.group.new',
  improvements: 'releaseNotes.group.improvements',
  fixes: 'releaseNotes.group.fixes',
  sdk: 'releaseNotes.group.sdk',
  misc: 'releaseNotes.group.misc',
} as const satisfies Record<ReleaseNotesGroupKey, string>;

const MARKDOWN_CLASS = 'typography-markdown-body text-foreground leading-relaxed break-words [&_a]:!text-[var(--primary-base)] [&_a]:!no-underline [&_a:hover]:!underline';
const GROUP_HEADING_CLASS = 'mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground';
const TEXT_BUTTON_CLASS = 'typography-meta text-[var(--primary-base)] hover:underline';

/** Links in the notes open in the browser, also in the desktop app. */
const openLinksExternally = (event: React.MouseEvent) => {
  const link = event.target instanceof Element ? event.target.closest('a') : null;
  if (!link?.href) return;
  event.preventDefault();
  event.stopPropagation();
  void openExternalUrl(link.href);
};

const Markdown: React.FC<{ content: string }> = ({ content }) => (
  <SimpleMarkdownRenderer content={linkReleaseNoteMentions(content)} disableLinkSafety={true} enableFileReferences={false} />
);

const ReleaseGroup: React.FC<{ group: ReleaseNotesContent['groups'][number] }> = ({ group }) => {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const hidden = group.bullets.length - GROUP_PREVIEW;
  const shown = expanded || hidden <= 0 ? group.bullets : group.bullets.slice(0, GROUP_PREVIEW);
  return (
    <div>
      <h4 className={GROUP_HEADING_CLASS}>{t(GROUP_LABEL_KEYS[group.key])}</h4>
      <Markdown content={shown.map((bullet) => `- ${bullet}`).join('\n')} />
      {hidden > 0 && (
        <button type="button" className={`mt-1 ${TEXT_BUTTON_CLASS}`} onClick={() => setExpanded((value) => !value)}>
          {expanded ? t('updateDialog.changelog.showLess') : t('updateDialog.changelog.showMore', { count: hidden })}
        </button>
      )}
    </div>
  );
};

type ReleaseNotesBodyProps = {
  notes: ReleaseNotesContent;
  /** Only the first group opens; the rest wait behind a line of counts. */
  folded: boolean;
};

/**
 * One release's title, intro and groups, each group cut to a few lines.
 * Settings > About and the update dialog both draw releases with it.
 */
export const ReleaseNotesBody: React.FC<ReleaseNotesBodyProps> = ({ notes, folded }) => {
  const { t } = useI18n();
  const [unfolded, setUnfolded] = React.useState(false);
  const foldGroups = folded && !unfolded && notes.groups.length > 1;
  const groups = foldGroups ? notes.groups.slice(0, 1) : notes.groups;
  return (
    <div onClickCapture={openLinksExternally}>
      {notes.title && <p className="typography-ui-label mb-2 font-semibold text-foreground">{notes.title}</p>}
      <div className={`space-y-4 ${MARKDOWN_CLASS}`}>
        {notes.intro && <Markdown content={notes.intro} />}
        {groups.map((group) => <ReleaseGroup key={group.key} group={group} />)}
      </div>
      {foldGroups && (
        <p className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 typography-meta text-muted-foreground">
          {notes.groups.slice(1).map((group, index) => (
            <React.Fragment key={group.key}>
              {index > 0 && <span aria-hidden="true">·</span>}
              <span>{t(GROUP_LABEL_KEYS[group.key])} {group.bullets.length}</span>
            </React.Fragment>
          ))}
          <button type="button" className={TEXT_BUTTON_CLASS} onClick={() => setUnfolded(true)}>
            {t('releaseNotes.showAll')}
          </button>
        </p>
      )}
    </div>
  );
};
