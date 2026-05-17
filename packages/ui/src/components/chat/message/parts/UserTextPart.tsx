import React from 'react';
import { cn } from '@/lib/utils';
import type { Part } from '@opencode-ai/sdk/v2';
import type { AgentMentionInfo } from '../types';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { useUIStore } from '@/stores/useUIStore';
import { Icon } from "@/components/icon/Icon";

type PartWithText = Part & { text?: string; content?: string; value?: string };

type UserTextPartProps = {
    part: Part;
    messageId: string;
    isMobile: boolean;
    agentMention?: AgentMentionInfo;
};

const buildMentionUrl = (name: string): string => {
    const encoded = encodeURIComponent(name);
    return `https://opencode.ai/docs/agents/#${encoded}`;
};

const escapeHtml = (text: string): string => {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
};

const normalizeUserMessageRenderingMode = (mode: unknown): 'markdown' | 'plain' => {
    return mode === 'markdown' ? 'markdown' : 'plain';
};

const UserTextPart: React.FC<UserTextPartProps> = ({ part, messageId, agentMention }) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    const textContent = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';

    const [isExpanded, setIsExpanded] = React.useState(false);
    const [isTruncated, setIsTruncated] = React.useState(false);
    const userMessageRenderingMode = useUIStore((state) => state.userMessageRenderingMode);
    const normalizedRenderingMode = normalizeUserMessageRenderingMode(userMessageRenderingMode);
    const textRef = React.useRef<HTMLDivElement>(null);

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
            if (!isExpanded) {
                setIsTruncated(el.scrollHeight > el.clientHeight);
            }
        };

        checkTruncation();

        const resizeObserver = new ResizeObserver(checkTruncation);
        resizeObserver.observe(el);

        return () => resizeObserver.disconnect();
    }, [textContent, isExpanded]);

    const handleClick = React.useCallback(() => {
        const element = textRef.current;
        if (!element) {
            return;
        }

        if (hasActiveSelectionInElement(element)) {
            return;
        }

        if (!isExpanded && isTruncated) {
            setIsExpanded(true);
        }
    }, [hasActiveSelectionInElement, isExpanded, isTruncated]);

    const handleCollapse = React.useCallback((event: React.MouseEvent) => {
        event.stopPropagation();
        setIsExpanded(false);
    }, []);

    const processedMarkdownContent = React.useMemo(() => {
        let content = textContent;

        // Step 1: First escape HTML to protect against XSS and ensure HTML tags display as text
        content = escapeHtml(content);

        // Step 2: Then insert agent mention links (after escaping, so <a> tags won't be escaped)
        if (agentMention?.token && content.includes(agentMention.token)) {
            const mentionHtml = `<a href="${buildMentionUrl(agentMention.name)}" class="text-primary hover:underline" target="_blank" rel="noopener noreferrer">${agentMention.token}</a>`;
            content = content.replace(agentMention.token, mentionHtml);
        }

        return content;
    }, [agentMention, textContent]);

    const plainTextContent = React.useMemo(() => {
        if (!agentMention?.token || !textContent.includes(agentMention.token)) {
            return textContent;
        }

        const idx = textContent.indexOf(agentMention.token);
        const before = textContent.slice(0, idx);
        const after = textContent.slice(idx + agentMention.token.length);
        return (
            <>
                {before}
                <a
                    href={buildMentionUrl(agentMention.name)}
                    className="text-primary hover:underline"
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(event) => event.stopPropagation()}
                >
                    {agentMention.token}
                </a>
                {after}
            </>
        );
    }, [agentMention, textContent]);

    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    return (
        <div className="relative" key={part.id || `${messageId}-user-text`}>
            {isExpanded && (
                <button
                    type="button"
                    onClick={handleCollapse}
                    className="absolute top-0 right-0 z-10 flex items-center justify-center rounded-sm bg-[var(--surface-elevated)] p-0.5 text-[var(--surface-mutedForeground)] hover:text-[var(--surface-foreground)] hover:bg-[var(--interactive-hover)] transition-colors"
                    aria-label="Collapse"
                >
                    <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
                </button>
            )}
            <div
                className={cn(
                    "break-words font-sans typography-markdown",
                    isExpanded && "pb-3",
                    normalizedRenderingMode === 'plain' && 'whitespace-pre-wrap',
                    !isExpanded && "line-clamp-2",
                    isTruncated && !isExpanded && "cursor-pointer"
                )}
                ref={textRef}
                onClick={handleClick}
            >
                {normalizedRenderingMode === 'markdown' ? (
                    <SimpleMarkdownRenderer 
                        content={processedMarkdownContent} 
                        disableLinkSafety 
                    />
                ) : (
                    plainTextContent
                )}
            </div>
        </div>
    );
};

export default React.memo(UserTextPart);
