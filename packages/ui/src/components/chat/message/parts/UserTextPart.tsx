import React from 'react';
import { cn } from '@/lib/utils';
import { isInvisibleText } from '@/lib/invisibleText';
import { Icon } from '@/components/icon/Icon';
import type { FilePart, Part } from '@/lib/opencode/model';
import {
    collectOpenableAttachmentNames,
    findAttachmentPart,
    isOpenableAttachmentName,
    resolveAttachmentOpenTarget,
} from '@/lib/messages/attachmentPreview';
import type { AgentMentionInfo, ToolPopupContent } from '../types';
import { useOpenAttachment } from '../useOpenAttachment';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { useUIStore } from '@/stores/useUIStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getDirectoryForFilePath } from '@/lib/path-utils';
import { hasTextSelectionInside } from '@/lib/textSelection';
import { useI18n } from '@/lib/i18n';
import {
    INTERACTIVE_REFERENCE_CHIP_CLASS,
    REFERENCE_CHIP_LABEL_CLASS,
    buildAgentMentionUrl,
    parseSkillHref,
    type AttachmentCitationLink,
} from '@/lib/messages/inlineMessageLinks';
import { getFileTypeIconHref } from '@/lib/fileTypeIcons';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { glueChipPunctuation, withAttachmentChips, type InlineTextNode } from './attachmentCitationChips';
import { prepareUserMarkdownContent, SKILL_TOKEN_PATTERN } from './userTextPartContent';
import { extractTerminalContexts } from '@/lib/messages/terminalContext';
import { readContextPart } from '@/lib/messages/contextParts';
import UserContextPart from './UserContextPart';
import { SessionMentionChipsContext, withSessionMentionChips, type SessionMentionChips } from './sessionMentionChips';
import { appOwnOrigins } from '@/lib/router/appOrigins';

type PartWithText = Part & { text?: string; content?: string; value?: string };

type UserTextPartProps = {
    part: Part;
    messageId: string;
    isMobile: boolean;
    agentMention?: AgentMentionInfo;
    /**
     * Message-level collapse: all parts of the user message share one expanded
     * state owned by the message body, expanding any part expands the whole
     * message, and the message body renders the single show more / show less
     * control from the truncation each part reports.
     */
    messageExpanded: boolean;
    onExpandMessage: () => void;
    partIndex: number;
    onTruncationChange: (partIndex: number, truncated: boolean) => void;
    /** Names of the files attached to this message; `[name]` in the text renders as a file chip. */
    attachmentFilenames: readonly string[];
    /** The message's file parts; a citation of one the app can show opens it on click. */
    attachmentFiles?: readonly FilePart[];
    /** The message's popup opener, for images and inline text. */
    onShowPopup?: (content: ToolPopupContent) => void;
    /** Sessions and messages the message mentioned; their links in the text draw as chips. */
    sessionMentionChips?: SessionMentionChips;
};

const NO_SESSION_MENTIONS: SessionMentionChips = new Map();

const EMPTY_ATTACHMENT_LINKS: AttachmentCitationLink[] = [];
const EMPTY_ATTACHMENT_FILES: readonly FilePart[] = [];


const normalizeUserMessageRenderingMode = (mode: unknown): 'markdown' | 'plain' => {
    return mode === 'markdown' ? 'markdown' : 'plain';
};

const UserTextPart: React.FC<UserTextPartProps> = ({
    part,
    messageId,
    agentMention,
    messageExpanded,
    onExpandMessage,
    partIndex,
    onTruncationChange,
    attachmentFilenames,
    attachmentFiles = EMPTY_ATTACHMENT_FILES,
    onShowPopup,
    sessionMentionChips = NO_SESSION_MENTIONS,
}) => {
    // Structured context (inline comments, terminal selections, annotations,
    // PR context) renders as a dedicated block instead of raw prompt text.
    const contextPayload = React.useMemo(() => readContextPart(part), [part]);

    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    const serializedText = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';
    const terminalContextState = React.useMemo(() => extractTerminalContexts(serializedText), [serializedText]);
    const textContent = terminalContextState.visibleText;

    const [isTruncated, setIsTruncated] = React.useState(false);
    const userMessageRenderingMode = useUIStore((state) => state.userMessageRenderingMode);
    const collapsibleUserMessages = useUIStore((state) => state.collapsibleUserMessages);
    const skills = useSkillsStore((state) => state.skills);
    const openContextFile = useUIStore((state) => state.openContextFile);
    const effectiveDirectory = useEffectiveDirectory();
    const { t } = useI18n();
    const normalizedRenderingMode = normalizeUserMessageRenderingMode(userMessageRenderingMode);
    const isCollapsed = collapsibleUserMessages && !messageExpanded;
    const textRef = React.useRef<HTMLDivElement>(null);
    const skillByName = React.useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);
    const themeSystem = useOptionalThemeSystem();
    const themeVariant = themeSystem?.currentTheme.metadata.variant === 'light' ? 'light' : 'dark';
    const openableAttachmentNames = React.useMemo(() => collectOpenableAttachmentNames(attachmentFiles), [attachmentFiles]);
    const isOpenableAttachment = React.useCallback(
        (filename: string) => isOpenableAttachmentName(openableAttachmentNames, filename),
        [openableAttachmentNames],
    );
    const attachmentLinks = React.useMemo<AttachmentCitationLink[]>(() => (
        attachmentFilenames.length === 0
            ? EMPTY_ATTACHMENT_LINKS
            : attachmentFilenames.map((filename) => ({
                filename,
                iconId: getFileTypeIconHref(filename, { themeVariant }).slice(1),
                openable: isOpenableAttachment(filename),
            }))
    ), [attachmentFilenames, isOpenableAttachment, themeVariant]);
    const openAttachment = useOpenAttachment(onShowPopup);

    const openCitedAttachment = React.useCallback((chip: HTMLElement) => {
        const target = resolveAttachmentOpenTarget(
            findAttachmentPart(chip.getAttribute('data-attachment-open'), attachmentFiles),
            attachmentFiles,
        );
        if (target) openAttachment(target);
    }, [attachmentFiles, openAttachment]);

    const openSkill = React.useCallback((name: string) => {
        const skill = skillByName.get(name);
        if (!skill?.path) return;
        openContextFile(effectiveDirectory || getDirectoryForFilePath('', skill.path) || '/', skill.path);
    }, [effectiveDirectory, openContextFile, skillByName]);

    // Measured before paint, and reported to the message (which renders the
    // show-full-message link) before paint too: measured after it, a sent
    // message painted without the link and grew by its height a frame later,
    // and the list placed the grown row 28px too high before settling it.
    React.useLayoutEffect(() => {
        const el = textRef.current;
        if (!el) return;
        if (!collapsibleUserMessages || messageExpanded) return;

        const checkTruncation = () => {
            setIsTruncated(el.scrollHeight > el.clientHeight);
        };

        checkTruncation();
        // A just-sent message mounts while its turn is still settling, so the
        // synchronous read can land before the clamp has its final geometry.
        // One deferred re-read covers that without waiting for an observer.
        const initialFrame = window.requestAnimationFrame(checkTruncation);

        // `el` is the clamped box: once line-clamp pins it to two lines its own
        // size stops changing, so observing it alone freezes the first
        // measurement. Markdown settles after mount (highlighting, late layout),
        // and a message measured while still short would never regain the
        // expand affordance. The children keep their natural height under the
        // clamp, so they are what reports content growth.
        const resizeObserver = new ResizeObserver(checkTruncation);
        resizeObserver.observe(el);

        const observeChildren = () => {
            for (const child of Array.from(el.children)) {
                resizeObserver.observe(child);
            }
        };
        observeChildren();

        // The renderer swaps subtrees as it settles; re-observe the new children.
        const mutationObserver = new MutationObserver(() => {
            observeChildren();
            checkTruncation();
        });
        mutationObserver.observe(el, { childList: true, subtree: true });

        return () => {
            window.cancelAnimationFrame(initialFrame);
            mutationObserver.disconnect();
            resizeObserver.disconnect();
        };
    }, [collapsibleUserMessages, textContent, messageExpanded]);

    React.useEffect(() => {
        if (!collapsibleUserMessages) {
            setIsTruncated(false);
        }
    }, [collapsibleUserMessages]);

    React.useLayoutEffect(() => {
        onTruncationChange(partIndex, isTruncated);
    }, [isTruncated, onTruncationChange, partIndex]);

    React.useEffect(() => () => onTruncationChange(partIndex, false), [onTruncationChange, partIndex]);

    const handleExpand = React.useCallback(() => {
        setIsTruncated(true);
        onExpandMessage();
    }, [onExpandMessage]);

    const handleClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;

        // A file-name citation opens what its attachment chip opens, unless
        // the click ends a text selection over it.
        const citationChip = target?.closest<HTMLElement>('[data-attachment-open]');
        if (citationChip) {
            event.preventDefault();
            event.stopPropagation();
            if (textRef.current && hasTextSelectionInside(textRef.current)) return;
            openCitedAttachment(citationChip);
            return;
        }

        const skillLink = target?.closest<HTMLElement>('[data-skill-name]');
        const skillName = skillLink?.dataset.skillName
            ?? parseSkillHref(target?.closest<HTMLAnchorElement>('a[href]')?.getAttribute('href'));
        if (skillName) {
            event.preventDefault();
            event.stopPropagation();
            openSkill(skillName);
            return;
        }

        const element = textRef.current;
        if (!element) {
            return;
        }

        if (hasTextSelectionInside(element)) {
            return;
        }

        // Measure at click time instead of trusting the observed flag: whether
        // the text is clipped right now is what decides if expanding does
        // anything, and the flag can still be catching up on a fresh message.
        if (collapsibleUserMessages && !messageExpanded && element.scrollHeight > element.clientHeight) {
            handleExpand();
        }
    }, [collapsibleUserMessages, messageExpanded, handleExpand, openCitedAttachment, openSkill]);

    // The Markdown chip is a focusable span with the button role; the plain
    // one is a real button, which turns Enter and Space into a click itself.
    const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        if (!(event.target instanceof HTMLElement) || event.target.tagName === 'BUTTON') return;
        if (!event.target.hasAttribute('data-attachment-open')) return;
        event.preventDefault();
        event.stopPropagation();
        openCitedAttachment(event.target);
    }, [openCitedAttachment]);

    const processedMarkdownContent = React.useMemo(() => {
        return prepareUserMarkdownContent({
            textContent,
            agentMention,
            skillNames: new Set(skillByName.keys()),
            attachments: attachmentLinks,
            sessionMentions: { chips: sessionMentionChips, origins: appOwnOrigins() },
        });
    }, [agentMention, attachmentLinks, sessionMentionChips, skillByName, textContent]);

    const plainTextNodes = React.useMemo(() => {
        const nodes: InlineTextNode[] = [];
        let cursor = 0;
        let agentMentionUsed = false;
        let match: RegExpExecArray | null;
        SKILL_TOKEN_PATTERN.lastIndex = 0;

        while ((match = SKILL_TOKEN_PATTERN.exec(textContent)) !== null) {
            const prefix = match[1] || '';
            const skillName = match[2];
            const slashIndex = match.index + prefix.length;
            if (!skillByName.has(skillName)) continue;

            if (match.index > cursor) nodes.push(textContent.slice(cursor, match.index));
            if (prefix) nodes.push(prefix);
            nodes.push(
                <button
                    key={`skill-${slashIndex}-${skillName}`}
                    type="button"
                    dir="ltr"
                    className={cn(INTERACTIVE_REFERENCE_CHIP_CLASS, '[unicode-bidi:isolate]')}
                    // Inline minimums opt out of the mobile 36px button floor.
                    style={{ minHeight: 0, minWidth: 0 }}
                    title={`$${skillName}`}
                    onClick={(event) => {
                        event.stopPropagation();
                        openSkill(skillName);
                    }}
                >
                    <Icon name="book-open" className="h-[1.1em] w-[1.1em] shrink-0" />
                    <span className={REFERENCE_CHIP_LABEL_CLASS}>{skillName}</span>
                </button>
            );
            cursor = slashIndex + skillName.length + 1;
        }

        if (cursor < textContent.length) nodes.push(textContent.slice(cursor));

        const withSkills = nodes.length > 0 ? nodes : [textContent];
        if (!agentMention?.token || !textContent.includes(agentMention.token)) {
            return withSkills;
        }

        return withSkills.flatMap<InlineTextNode>((node, index) => {
            if (agentMentionUsed || typeof node !== 'string') return node;
            const idx = node.indexOf(agentMention.token);
            if (idx === -1) return node;
            agentMentionUsed = true;
            return [
                node.slice(0, idx),
                <a
                    key={`agent-${index}`}
                    href={buildAgentMentionUrl(agentMention.name)}
                    dir="ltr"
                    className="text-primary hover:underline [unicode-bidi:isolate]"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                >
                    {agentMention.token}
                </a>,
                node.slice(idx + agentMention.token.length),
            ];
        });
    }, [agentMention, openSkill, skillByName, textContent]);

    // Attachment citations and mentioned sessions become chips in the plain-text path too.
    const plainTextContent = React.useMemo(() => glueChipPunctuation(
        attachmentFilenames.length === 0 && sessionMentionChips.size === 0 ? plainTextNodes : plainTextNodes.flatMap((node, nodeIndex) => (
            React.isValidElement<unknown>(node)
                ? node
                : withSessionMentionChips(node, sessionMentionChips, `session-${nodeIndex}`).flatMap((run, runIndex) => (
                    React.isValidElement<unknown>(run)
                        ? run
                        : withAttachmentChips(run, attachmentFilenames, `attachment-${nodeIndex}-${runIndex}`, isOpenableAttachment)
                ))
        )),
        'chip-glue',
    ), [attachmentFilenames, isOpenableAttachment, plainTextNodes, sessionMentionChips]);

    if (contextPayload) {
        return (
            <UserContextPart
                payload={contextPayload}
                attachmentFilenames={attachmentFilenames}
                collapsed={isCollapsed}
                onExpand={onExpandMessage}
            />
        );
    }

    if (isInvisibleText(textContent) && terminalContextState.contexts.length === 0) {
        return null;
    }

    return (
        <div className="relative" key={part.id || `${messageId}-user-text`}>
            <div
                className={cn(
                    "break-words font-sans typography-markdown-body",
                    normalizedRenderingMode === 'plain' && 'whitespace-pre-wrap [unicode-bidi:plaintext] text-start',
                    isCollapsed && "line-clamp-2",
                    collapsibleUserMessages && isTruncated && !messageExpanded && "cursor-pointer"
                )}
                ref={textRef}
                onClick={handleClick}
                onKeyDown={handleKeyDown}
            >
                {normalizedRenderingMode === 'markdown' ? (
                    <SessionMentionChipsContext.Provider value={sessionMentionChips}>
                        <SimpleMarkdownRenderer
                            singleTilde={false}
                            content={processedMarkdownContent}
                            className={cn(
                                "[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0",
                                isCollapsed && [
                                    "[&_.markdown-content>*]:my-0",
                                    "[&_[data-oc-streamdown]>*]:![margin-block:0]",
                                    "[&_[data-oc-markdown-block]>*]:![margin-block:0]",
                                    "[&_[data-streamdown='code-block']]:!my-0",
                                    "[&_[data-streamdown='code-block']]:!inline",
                                    "[&_[data-streamdown='code-block']]:!border-0",
                                    "[&_[data-streamdown='code-block']]:!bg-transparent",
                                    "[&_[data-streamdown='code-block-header']]:!hidden",
                                    "[&_[data-streamdown='code-block-actions']]:!hidden",
                                    "[&_[data-streamdown='code-block-body']]:!inline",
                                    "[&_[data-streamdown='code-block-body']]:!p-0",
                                    "[&_[data-streamdown='code-block-body']_pre]:!inline",
                                    "[&_[data-streamdown='code-block-body']_pre]:!p-0",
                                    "[&_[data-streamdown='code-block-body']_code]:!inline",
                                    "[&_[data-streamdown='code-block-body']_code]:!ps-0",
                                    "[&_[data-streamdown='code-block-body']_code]:![background-image:none]",
                                    "[&_[data-streamdown='code-block-body']_code>span]:!block",
                                    "[&_[data-streamdown='code-block-body']_code>span]:before:!hidden",
                                 ]
                            )}
                            disableLinkSafety
                            enableFileReferences={false}
                        />
                    </SessionMentionChipsContext.Provider>
                ) : (
                    plainTextContent
                )}
            </div>
            {terminalContextState.contexts.length > 0 ? (
                <div className="mt-2 space-y-1.5">
                    {terminalContextState.contexts.map((context, index) => (
                        <details key={`${context.terminalLabel}-${context.startLine}-${index}`} className="oc-tile rounded-md px-2 py-1.5 text-xs">
                            <summary className="cursor-pointer text-muted-foreground">
                                {t('chat.message.terminalContext', { terminal: context.terminalLabel, start: context.startLine, end: context.endLine })}
                            </summary>
                            <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[var(--surface-foreground)]">{context.text}</pre>
                        </details>
                    ))}
                </div>
            ) : null}
        </div>
    );
};

export default React.memo(UserTextPart);
