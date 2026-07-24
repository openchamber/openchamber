import React from 'react';
import { cn } from '@/lib/utils';
import type { Part } from '@opencode-ai/sdk/v2';
import type { AgentMentionInfo } from '../types';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { useUIStore } from '@/stores/useUIStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { Icon } from "@/components/icon/Icon";
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getDirectoryForFilePath } from '@/lib/path-utils';
import { useI18n } from '@/lib/i18n';
import {
    buildAgentMentionUrl,
    parseSkillHref,
} from '@/lib/messages/inlineMessageLinks';
import { prepareUserMarkdownContent, SKILL_TOKEN_PATTERN } from './userTextPartContent';
import { extractTerminalContexts } from '@/lib/messages/terminalContext';

type PartWithText = Part & { text?: string; content?: string; value?: string };

type UserTextPartProps = {
    part: Part;
    messageId: string;
    isMobile: boolean;
    agentMention?: AgentMentionInfo;
};

const normalizeUserMessageRenderingMode = (mode: unknown): 'markdown' | 'plain' => {
    return mode === 'markdown' ? 'markdown' : 'plain';
};

const UserTextPart: React.FC<UserTextPartProps> = ({ part, messageId, agentMention }) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    const serializedText = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';
    const terminalContextState = React.useMemo(() => extractTerminalContexts(serializedText), [serializedText]);
    const textContent = terminalContextState.visibleText;

    const [isExpanded, setIsExpanded] = React.useState(false);
    const [isTruncated, setIsTruncated] = React.useState(false);
    const userMessageRenderingMode = useUIStore((state) => state.userMessageRenderingMode);
    const collapsibleUserMessages = useUIStore((state) => state.collapsibleUserMessages);
    const skills = useSkillsStore((state) => state.skills);
    const openContextFile = useUIStore((state) => state.openContextFile);
    const effectiveDirectory = useEffectiveDirectory();
    const { t } = useI18n();
    const normalizedRenderingMode = normalizeUserMessageRenderingMode(userMessageRenderingMode);
    const isCollapsed = collapsibleUserMessages && !isExpanded;
    const textRef = React.useRef<HTMLDivElement>(null);
    const skillByName = React.useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);

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

        const checkTruncation = () => {
            if (collapsibleUserMessages && !isExpanded) {
                setIsTruncated(el.scrollHeight > el.clientHeight);
            }
        };

        checkTruncation();

        const resizeObserver = new ResizeObserver(checkTruncation);
        resizeObserver.observe(el);

        return () => resizeObserver.disconnect();
    }, [collapsibleUserMessages, textContent, isExpanded]);

    React.useEffect(() => {
        if (!collapsibleUserMessages) {
            setIsExpanded(false);
            setIsTruncated(false);
        }
    }, [collapsibleUserMessages]);

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

        if (collapsibleUserMessages && !isExpanded && isTruncated) {
            setIsExpanded(true);
        }
    }, [collapsibleUserMessages, hasActiveSelectionInElement, isExpanded, isTruncated, openSkill]);

    const handleCollapse = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        setIsExpanded(false);
    }, []);

    const processedMarkdownContent = React.useMemo(() => {
        return prepareUserMarkdownContent({
            textContent,
            agentMention,
            skillNames: new Set(skillByName.keys()),
        });
    }, [agentMention, skillByName, textContent]);

    const plainTextContent = React.useMemo(() => {
        const nodes: React.ReactNode[] = [];
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
                    className="text-primary hover:underline"
                    onClick={(event) => {
                        event.stopPropagation();
                        openSkill(skillName);
                    }}
                >
                    /{skillName}
                </button>
            );
            cursor = slashIndex + skillName.length + 1;
        }

        if (cursor < textContent.length) nodes.push(textContent.slice(cursor));

        const withSkills = nodes.length > 0 ? nodes : [textContent];
        if (!agentMention?.token || !textContent.includes(agentMention.token)) {
            return withSkills;
        }

        return withSkills.flatMap((node, index) => {
            if (agentMentionUsed || typeof node !== 'string') return node;
            const idx = node.indexOf(agentMention.token);
            if (idx === -1) return node;
            agentMentionUsed = true;
            return [
                node.slice(0, idx),
                <a
                    key={`agent-${index}`}
                    href={buildAgentMentionUrl(agentMention.name)}
                    className="text-primary hover:underline"
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

    if ((!textContent || textContent.trim().length === 0) && terminalContextState.contexts.length === 0) {
        return null;
    }

    return (
        <div className="relative" key={part.id || `${messageId}-user-text`}>
            {collapsibleUserMessages && isExpanded && (
                <div className="sticky top-0 z-10 flex justify-end pointer-events-none h-0 overflow-visible">
                    <button
                        type="button"
                        onClick={handleCollapse}
                        className="pointer-events-auto flex items-center justify-center rounded-sm bg-[var(--surface-elevated)] p-0.5 text-[var(--surface-mutedForeground)] hover:text-[var(--surface-foreground)] hover:bg-[var(--interactive-hover)] transition-colors"
                        aria-label={t('chat.message.userText.collapseAria')}
                    >
                        <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
                    </button>
                </div>
            )}
            <div
                className={cn(
                    "break-words font-sans typography-markdown-body",
                    isExpanded && "pb-3",
                    normalizedRenderingMode === 'plain' && 'whitespace-pre-wrap',
                    isCollapsed && "line-clamp-2",
                    collapsibleUserMessages && isTruncated && !isExpanded && "cursor-pointer"
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
                                 "[&_[data-md-code-line-numbers]]:hidden",
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
                            <summary className="cursor-pointer text-[var(--surface-mutedForeground)]">
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
