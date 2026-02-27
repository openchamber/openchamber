import React from 'react';
import { cn } from '@/lib/utils';
import type { Part } from '@opencode-ai/sdk/v2';
import type { AgentMentionInfo } from '../types';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';

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

const UserTextPart: React.FC<UserTextPartProps> = ({ part, messageId, agentMention }) => {
    const CLAMP_LINES = 2;
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    const textContent = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';

    const [isExpanded, setIsExpanded] = React.useState(false);
    const [isTruncated, setIsTruncated] = React.useState(false);
    const [collapseZoneHeight, setCollapseZoneHeight] = React.useState<number>(0);
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

            const styles = window.getComputedStyle(el);
            const lineHeight = parseFloat(styles.lineHeight);
            const fontSize = parseFloat(styles.fontSize);
            const fallbackLineHeight = isFinite(fontSize) ? fontSize * 1.4 : 20;
            const resolvedLineHeight = isFinite(lineHeight) ? lineHeight : fallbackLineHeight;
            setCollapseZoneHeight(Math.max(1, Math.round(resolvedLineHeight * CLAMP_LINES)));
        };

        checkTruncation();

        const resizeObserver = new ResizeObserver(checkTruncation);
        resizeObserver.observe(el);

        return () => resizeObserver.disconnect();
    }, [textContent, isExpanded]);

    const handleClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const element = textRef.current;
        if (!element) {
            return;
        }

        if (hasActiveSelectionInElement(element)) {
            return;
        }

        if (!isExpanded) {
            if (isTruncated) {
                setIsExpanded(true);
            }
            return;
        }

        const clickY = event.clientY - element.getBoundingClientRect().top;
        if (clickY <= collapseZoneHeight) {
            setIsExpanded(false);
        }
    }, [collapseZoneHeight, hasActiveSelectionInElement, isExpanded, isTruncated]);

    const processedContent = React.useMemo(() => {
        if (!agentMention?.token || !textContent.includes(agentMention.token)) {
            return textContent;
        }
        
        const mentionHtml = `<a href="${buildMentionUrl(agentMention.name)}" class="text-primary hover:underline" target="_blank" rel="noopener noreferrer">${agentMention.token}</a>`;
        return textContent.replace(agentMention.token, mentionHtml);
    }, [agentMention, textContent]);

    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    return (
        <div className="relative" key={part.id || `${messageId}-user-text`}>
            <div
                className={cn(
                    "break-words font-sans typography-markdown",
                    !isExpanded && "line-clamp-2",
                    isTruncated && !isExpanded && "cursor-pointer"
                )}
                ref={textRef}
                onClick={handleClick}
            >
                <SimpleMarkdownRenderer 
                    content={processedContent} 
                    disableLinkSafety 
                />
            </div>
        </div>
    );
};

export default React.memo(UserTextPart);
