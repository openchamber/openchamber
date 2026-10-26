import React from 'react';
import type { ExtraProps } from 'streamdown';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { getExternalFaviconUrl, isAppLinkUrl, isExternalHttpUrl, isLoopbackHttpUrl } from '@/lib/url';
import { parseSessionLink } from '@/lib/sessionLinks';
import { openSessionLink } from '@/lib/router/openSessionFromRoute';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { appOwnOrigins } from '@/lib/router/appOrigins';
import { sessionLinkKey } from '@/lib/sessionLinks';
import { SessionMentionChipsContext } from '../message/parts/sessionMentionChips';
import { SessionMentionChipButton } from '../message/parts/SessionMentionChipButton';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { parseAgentHref, parseAttachmentHref, parseSkillHref, INLINE_REFERENCE_CHIP_CLASS, INTERACTIVE_REFERENCE_CHIP_CLASS, REFERENCE_CHIP_LABEL_CLASS, buildAgentMentionUrl } from '@/lib/messages/inlineMessageLinks';
import { openAppLinkWithConfirmation } from '../appLinkConfirmation';
import { useOpenChatLink } from '../useOpenChatLink';
import { useMarkdownPresentation } from './MarkdownPresentationContext';
import { activateMarkdownFile, resolveMarkdownFile, useOpenMarkdownFile } from './markdownFileReferences';
import { MarkdownMediaLinkContext, useMarkdownMedia } from './markdown-media-context';
import { openMarkdownDocumentLink } from '@/components/views/files/previews/useMarkdownLocalAssets';

function useConfirmedInlineFile(raw: string): string | null {
  const { directory, fileReferences, confirmFile } = useMarkdownPresentation();
  const runtimeKey = getRuntimeKey();
  const [confirmed, setConfirmed] = React.useState<{ raw: string; directory: string; runtimeKey: string; path: string } | null>(null);
  React.useEffect(() => {
    if (!fileReferences) return;
    let active = true;
    void confirmFile(raw).then((path) => {
      if (active && runtimeKey === getRuntimeKey()) setConfirmed(path ? { raw, directory, runtimeKey, path } : null);
    });
    return () => { active = false; };
  }, [raw, directory, fileReferences, runtimeKey, confirmFile]);
  return fileReferences && confirmed?.raw === raw && confirmed.directory === directory && confirmed.runtimeKey === runtimeKey ? confirmed.path : null;
}

export function MarkdownInlineCode({ children, node: _node, ...props }: React.ComponentProps<'code'> & ExtraProps) {
  const raw = _node?.children.map((child) => child.type === 'text' ? child.value : '').join('') ?? '';
  const path = useConfirmedInlineFile(raw);
  const open = useOpenMarkdownFile();
  const activate = (event: React.MouseEvent | React.KeyboardEvent) => {
    if (path) activateMarkdownFile(event, (external) => { void open(raw, path, external); });
  };
  return (
    <code
      {...props}
      dir="ltr"
      data-streamdown="inline-code"
      data-openchamber-file-link={path ? 'true' : undefined}
      data-openchamber-file-ref={path ? raw : undefined}
      data-openchamber-file-path={path ?? undefined}
      role={path ? 'button' : undefined}
      tabIndex={path ? 0 : undefined}
      onClick={path ? activate : undefined}
      onKeyDown={path ? activate : undefined}
    >
      {children}
    </code>
  );
}

export function MarkdownLink(props: React.ComponentProps<'a'> & ExtraProps) {
  const { purpose } = useMarkdownPresentation();
  if (purpose) {
    const { node: _node, children, ...rest } = props;
    return (
      <a {...rest}>
        <MarkdownMediaLinkContext.Provider value={true}>{children}</MarkdownMediaLinkContext.Provider>
      </a>
    );
  }
  return <ScreenMarkdownLink {...props} />;
}

// The favicon sits before its link, framed, loads lazily, and goes away when
// the site has none; a broken-image icon would read as a broken link.
function LinkFavicon({ src }: { src: string }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) return null;
  return (
    <span
      data-message-image-export-exclude="true"
      className="me-1 inline-flex size-[18px] items-center justify-center rounded border border-[var(--border)] bg-[var(--interactive-hover)] align-middle"
    >
      <img src={src} alt="" aria-hidden="true" loading="lazy" decoding="async" className="size-3.5 rounded-sm" onError={() => setFailed(true)} />
    </span>
  );
}

const textOf = (node: ExtraProps['node']): string => {
  if (!node) return '';
  let text = '';
  const visit = (child: NonNullable<ExtraProps['node']>['children'][number]) => {
    if (child.type === 'text') text += child.value;
    else if (child.type === 'element') child.children.forEach(visit);
  };
  node.children.forEach(visit);
  return text.trim();
};

function ScreenMarkdownLink({ href, children: originalChildren, node, ...props }: React.ComponentProps<'a'> & ExtraProps) {
  // The policy dropped an unsafe or unsupported URL: the anchor stays inert,
  // as the old sanitizer left it, instead of opening the app in a new window.
  if (!href) {
    const { target: _target, rel: _rel, ...inert } = props;
    return <a {...inert}><MarkdownMediaLinkContext.Provider value={true}>{originalChildren}</MarkdownMediaLinkContext.Provider></a>;
  }
  return <ScreenMarkdownHref href={href} node={node} {...props}>{originalChildren}</ScreenMarkdownHref>;
}

function ScreenMarkdownHref({ href, children: originalChildren, node, ...props }: React.ComponentProps<'a'> & ExtraProps & { href: string }) {
  const children = <MarkdownMediaLinkContext.Provider value={true}>{originalChildren}</MarkdownMediaLinkContext.Provider>;
  const presentation = useMarkdownPresentation();
  const { directory } = presentation;
  const { t } = useI18n();
  const openChatLink = useOpenChatLink(directory);
  const openFile = useOpenMarkdownFile();
  const media = useMarkdownMedia();
  const openLinksInBrowserPanel = useUIStore((state) => state.openLinksInBrowserPanel);
  const text = textOf(node);
  const skill = parseSkillHref(href);
  const agent = parseAgentHref(href);
  const attachment = parseAttachmentHref(href);
  // VS Code keeps session links inert: its sessions live on its own OpenCode,
  // so a link to a web session opens in the browser like any other.
  const session = isVSCodeRuntime() ? null : parseSessionLink(href, appOwnOrigins());
  // A session or message the user's message mentioned draws as its chip.
  const mentionChips = React.useContext(SessionMentionChipsContext);
  const mentionChip = session ? mentionChips.get(sessionLinkKey(session)) : undefined;
  const app = isAppLinkUrl(href);
  const file = presentation.fileNavigation && resolveMarkdownFile(href, directory, 'click');
  // A link whose URL is not a file but whose text is a path opens that file
  // once the file is confirmed, as the old annotation pass did.
  const probe = file || app || session || skill || agent || attachment ? href : text;
  const path = useConfirmedInlineFile(probe);
  const textFile = Boolean(path && probe !== href);
  const external = isExternalHttpUrl(href);
  // A host's own reference (`#12`, a commit) reads as part of the text, without the site's mark.
  const reference = node?.properties.dataOcReference !== undefined;
  const favicon = external && !path && !reference ? getExternalFaviconUrl(href) : null;
  const showPreview = presentation.loopbackPreview && isLoopbackHttpUrl(href) && directory
    && !(isDesktopShell() && openLinksInBrowserPanel);
  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (media?.documentAssets && openMarkdownDocumentLink(event, media.documentAssets)) return;
    if (textFile && path) {
      activateMarkdownFile(event, (external) => { void openFile(text, path, external); });
      return;
    }
    if (session) {
      if (!external || !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
        event.preventDefault();
        void openSessionLink(session.sessionId, session.messageId);
        return;
      }
    }
    if (app) {
      event.preventDefault();
      event.stopPropagation();
      void openAppLinkWithConfirmation(href);
      return;
    }
    if (skill) return;
    if (file) {
      activateMarkdownFile(event, (external) => { void openFile(href, path ?? undefined, external); });
      return;
    }
    if (href.startsWith('#') && !media?.documentAssets) {
      // In-message anchors (footnotes) scroll within this message.
      event.preventDefault();
      const id = decodeURIComponent(href.slice(1));
      const root = event.currentTarget.closest('[data-markdown-content]');
      const target = root ? Array.from(root.querySelectorAll<HTMLElement>('[id]')).find((element) => element.id === id) : null;
      target?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (external && !presentation.disableLinkSafety && !(event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) {
      event.preventDefault();
      event.stopPropagation();
      openChatLink(href);
    }
  };
  if (attachment) {
    return (
      <span
        className={attachment.openable ? INTERACTIVE_REFERENCE_CHIP_CLASS : INLINE_REFERENCE_CHIP_CLASS}
        data-attachment-citation={attachment.iconId}
        data-attachment-open={attachment.openable ? attachment.filename : undefined}
        role={attachment.openable ? 'button' : undefined}
        tabIndex={attachment.openable ? 0 : undefined}
        title={attachment.filename}
      >
        <svg className="size-[1.1em] shrink-0" aria-hidden="true"><use href={`#${attachment.iconId}`} /></svg>
        <span className={REFERENCE_CHIP_LABEL_CLASS}>{attachment.filename}</span>
      </span>
    );
  }
  if (session && mentionChip) {
    return <SessionMentionChipButton chip={mentionChip} target={session} />;
  }
  if (agent) {
    return (
      <a data-openchamber-agent-mention="true" className="text-primary hover:underline" href={buildAgentMentionUrl(agent)} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  }
  return (
    <>
      {favicon && <LinkFavicon src={favicon} />}
      <a
        {...props}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        dir={text === href ? 'ltr' : props.dir}
        className={skill ? INTERACTIVE_REFERENCE_CHIP_CLASS : props.className}
        data-skill-name={skill ?? undefined}
        title={skill ? `$${skill}` : props.title}
        data-openchamber-file-link={path ? 'true' : undefined}
        data-openchamber-file-ref={path ? probe : undefined}
        data-openchamber-file-path={path ?? undefined}
        onClick={handleClick}
        onAuxClick={(event) => {
          if (!app) return;
          event.preventDefault();
          if (event.button === 1) void openAppLinkWithConfirmation(href);
        }}
        onDragStart={app ? (event) => event.preventDefault() : undefined}
      >
        {skill && <Icon name="book-open" className="size-[1.1em] shrink-0" />}
        {skill ? <span className={REFERENCE_CHIP_LABEL_CLASS}>{skill}</span> : children}
      </a>
      {showPreview && (
        <Button
          variant="ghost"
          size="xs"
          className="ms-1 align-middle"
          data-export-ignore
          title={t('terminalView.preview.openTitle')}
          aria-label={t('terminalView.preview.open')}
          onClick={() => useUIStore.getState().openContextPreview(directory, href)}
        >
          <Icon name="global" className="size-3.5" />
        </Button>
      )}
    </>
  );
}
