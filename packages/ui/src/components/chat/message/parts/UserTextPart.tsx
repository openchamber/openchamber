import React from 'react';
import { cn } from '@/lib/utils';
import { Icon } from '@/components/icon/Icon';
import type { Part } from '@/lib/opencode/model';
import type { AgentMentionInfo } from '../types';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { useUIStore } from '@/stores/useUIStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getDirectoryForFilePath } from '@/lib/path-utils';
import { useI18n } from '@/lib/i18n';
import {
    INTERACTIVE_REFERENCE_CHIP_CLASS,
    buildAgentMentionUrl,
    parseSkillHref,
    type AttachmentCitationLink,
} from '@/lib/messages/inlineMessageLinks';
import { getFileTypeIconHref } from '@/lib/fileTypeIcons';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { withAttachmentChips, type InlineTextNode } from './attachmentCitationChips';
import { prepareUserMarkdownContent, SKILL_TOKEN_PATTERN } from './userTextPartContent';
import { extractTerminalContexts } from '@/lib/messages/terminalContext';
import { readContextPart } from '@/lib/messages/contextParts';
import UserContextPart from './UserContextPart';

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
};

const EMPTY_ATTACHMENT_LINKS: AttachmentCitationLink[] = [];


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
    const attachmentLinks = React.useMemo<AttachmentCitationLink[]>(() => (
        attachmentFilenames.length === 0
            ? EMPTY_ATTACHMENT_LINKS
            : attachmentFilenames.map((filename) => ({
                filename,
                iconId: getFileTypeIconHref(filename, { themeVariant }).slice(1),
            }))
    ), [attachmentFilenames, themeVariant]);

    const openSkill = React.useCallback((name: string) => {
        const skill = skillByName.get(name);
        if (!skill?.path) return;
        openContextFile(effectiveDirectory || getDirectoryForFilePath('', skill.path) || '/', skill.path);
    }, [effectiveDirectory, openContextFile, skillByName]);

    const hasActiveSelectionInElement = React.useCallback((element: HTMLElement): boolean => {
        if (typeof window === 'undefined') {
            return false;
        }

        const selection = window.getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            return false;
        }

        const range = selection.getRangeAt(0);
        return element.contains(range.startContainer) || element.contains(range.endContainer);
    }, []);

    React.useEffect(() => {
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

    React.useEffect(() => {
        onTruncationChange(partIndex, isTruncated);
    }, [isTruncated, onTruncationChange, partIndex]);

    React.useEffect(() => () => onTruncationChange(partIndex, false), [onTruncationChange, partIndex]);

    const handleExpand = React.useCallback(() => {
        setIsTruncated(true);
        onExpandMessage();
    }, [onExpandMessage]);

    const handleClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
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

        if (hasActiveSelectionInElement(element)) {
            return;
        }

        // Measure at click time instead of trusting the observed flag: whether
        // the text is clipped right now is what decides if expanding does
        // anything, and the flag can still be catching up on a fresh message.
        if (collapsibleUserMessages && !messageExpanded && element.scrollHeight > element.clientHeight) {
            handleExpand();
        }
    }, [collapsibleUserMessages, messageExpanded, handleExpand, hasActiveSelectionInElement, openSkill]);

    const processedMarkdownContent = React.useMemo(() => {
        return prepareUserMarkdownContent({
            textContent,
            agentMention,
            skillNames: new Set(skillByName.keys()),
            attachments: attachmentLinks,
        });
    }, [agentMention, attachmentLinks, skillByName, textContent]);

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
                    {skillName}
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

    // Attachment citations become file chips in the plain-text path too.
    const plainTextContent = React.useMemo(() => {
        if (attachmentFilenames.length === 0) return plainTextNodes;
        return plainTextNodes.flatMap((node, nodeIndex) => (
            React.isValidElement<unknown>(node) ? node : withAttachmentChips(node, attachmentFilenames, `attachment-${nodeIndex}`)
        ));
    }, [attachmentFilenames, plainTextNodes]);

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

    if ((!textContent || textContent.trim().length === 0) && terminalContextState.contexts.length === 0) {
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
            >
                {normalizedRenderingMode === 'markdown' ? (
                    <SimpleMarkdownRenderer
                        content={processedMarkdownContent}
                        className={cn(
                            "[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0",
                            isCollapsed && [
                                "[&_.markdown-content>*]:my-0",
                                "[&_[data-component='markdown-code']]:my-0",
                                "[&_[data-component='markdown-code']]:inline",
                                "[&_[data-component='markdown-code']]:border-0",
                                "[&_[data-component='markdown-code']]:bg-transparent",
                                "[&_[data-component='markdown-code']>*:first-child]:hidden",
                                "[&_[data-component='markdown-code']>div]:inline",
                                 "[&_[data-component='markdown-code']>div]:p-0",
                                 "[&_[data-component='markdown-code']_pre]:inline",
                                 "[&_[data-component='markdown-code']_code]:inline",
                                 "[&_[data-md-code-line]]:!inline",
                                 "[&_[data-md-code-line-number]]:hidden",
                                 "[&_[data-md-code-line-break]]:!inline",
                             ]
                        )}
                        disableLinkSafety
                        enableFileReferences={false}
                    />
                ) : (
                    plainTextContent
                )}
            </div>
            {terminalContextState.contexts.length > 0 ? (
                <div className="mt-2 space-y-1.5">
                    {terminalContextState.contexts.map((context, index) => (
                        <details key={`${context.terminalLabel}-${context.startLine}-${index}`} className="rounded-md border border-[var(--interactive-border)] bg-[var(--surface-elevated)] px-2 py-1.5 text-xs">
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
