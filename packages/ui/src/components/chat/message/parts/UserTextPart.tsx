import React from 'react';
import { cn } from '@/lib/utils';
import type { Part } from '@opencode-ai/sdk/v2';
import type { AgentMentionInfo } from '../types';
import { SimpleMarkdownRenderer } from '../../MarkdownRenderer';
import { useUIStore } from '@/stores/useUIStore';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { getDirectoryForFilePath } from '@/lib/path-utils';
import { useI18n } from '@/lib/i18n';
import { Icon } from "@/components/icon/Icon";
import { buildUserTextPreview, countAdditionalLines } from './userTextPreview';

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

const SKILL_TOKEN_PATTERN = /(^|\s)\/([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)/g;
const SKILL_LINK_PREFIX = '#openchamber-skill:';

const parseSkillHref = (href: string | null | undefined): string | null => {
    if (!href?.startsWith(SKILL_LINK_PREFIX)) return null;
    try {
        return decodeURIComponent(href.slice(SKILL_LINK_PREFIX.length));
    } catch {
        return null;
    }
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

// In Markdown a single "\n" is a soft break (rendered as a space). Users type plain
// text where each newline is meant literally, so convert soft breaks into hard breaks
// (two trailing spaces) outside of fenced code blocks, where newlines are already literal.
const applyHardLineBreaks = (markdown: string): string => {
    return markdown
        .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/g)
        .map((segment, index) => (index % 2 === 1 ? segment : segment.replace(/ *\n/g, '  \n')))
        .join('');
};

const UserTextPart: React.FC<UserTextPartProps> = ({ part, messageId, agentMention }) => {
    const partWithText = part as PartWithText;
    const rawText = partWithText.text;
    const textContent = typeof rawText === 'string' ? rawText : partWithText.content || partWithText.value || '';

    const [isExpanded, setIsExpanded] = React.useState(false);
    const userMessageRenderingMode = useUIStore((state) => state.userMessageRenderingMode);
    const skills = useSkillsStore((state) => state.skills);
    const openContextFile = useUIStore((state) => state.openContextFile);
    const effectiveDirectory = useEffectiveDirectory();
    const normalizedRenderingMode = normalizeUserMessageRenderingMode(userMessageRenderingMode);
    const { t } = useI18n();

    const skillByName = React.useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);

    const openSkill = React.useCallback((name: string) => {
        const skill = skillByName.get(name);
        if (!skill?.path) return;
        openContextFile(effectiveDirectory || getDirectoryForFilePath('', skill.path) || '/', skill.path);
    }, [effectiveDirectory, openContextFile, skillByName]);

    // Derive collapse affordance directly from content shape — no DOM
    // measurement, no ResizeObserver. `line-clamp-2` would silently fail
    // on block descendants (<pre>, <ul>, etc.) and let the message keep
    // its full height; an explicit single-line preview is reliable.
    const previewText = React.useMemo(() => buildUserTextPreview(textContent), [textContent]);
    const additionalLines = React.useMemo(() => countAdditionalLines(textContent), [textContent]);
    const canCollapse = additionalLines > 0;

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

    const previewRef = React.useRef<HTMLDivElement>(null);

    const handleExpandClick = React.useCallback(() => {
        const element = previewRef.current;
        if (element && hasActiveSelectionInElement(element)) {
            return;
        }
        if (!isExpanded && canCollapse) {
            setIsExpanded(true);
        }
    }, [hasActiveSelectionInElement, isExpanded, canCollapse]);

    // Expanded-view click handler: only intercepts skill mention clicks so they
    // open the skill file; selection/normal clicks are ignored (no collapse on
    // click in expanded mode — explicit chevron button handles that).
    const handleExpandedClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement | null;
        const skillLink = target?.closest<HTMLElement>('[data-skill-name]');
        const skillName = skillLink?.dataset.skillName
            ?? parseSkillHref(target?.closest<HTMLAnchorElement>('a[href]')?.getAttribute('href'));
        if (skillName) {
            event.preventDefault();
            event.stopPropagation();
            openSkill(skillName);
        }
    }, [openSkill]);

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

        // Step 3: Skill mentions (`/skill-name`) become clickable spans handled
        // by handleExpandedClick. Markdown renderer keeps the anchors intact.
        content = content.replace(SKILL_TOKEN_PATTERN, (match, prefix: string, skillName: string) => {
            if (!skillByName.has(skillName)) return match;
            return `${prefix}<a href="#" data-skill-name="${skillName}" class="text-primary hover:underline">/${skillName}</a>`;
        });

        // Step 4: Preserve user newlines (markdown soft breaks would otherwise collapse to spaces)
        content = applyHardLineBreaks(content);

        return content;
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
                    href={buildMentionUrl(agentMention.name)}
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

    if (!textContent || textContent.trim().length === 0) {
        return null;
    }

    // Collapsed view: render only a one-line plain-text preview plus a
    // "+N lines" hint. This box is intentionally short — no markdown,
    // no block elements — so the surrounding scroll container collapses
    // with it instead of holding the previous ~40dvh reservation.
    // Skill mentions appear as plain `/name` text in the preview; clicking
    // the row expands first, then expanded view renders interactive skills.
    if (!isExpanded && canCollapse) {
        return (
            <div
                ref={previewRef}
                role="button"
                tabIndex={0}
                onClick={handleExpandClick}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        handleExpandClick();
                    }
                }}
                className="flex items-center gap-2 min-w-0 cursor-pointer rounded-sm py-1 hover:bg-[var(--interactive-hover)]/40 transition-colors"
                aria-expanded={false}
                aria-label={t('chat.userText.expand')}
                key={part.id || `${messageId}-user-text`}
            >
                <span className="typography-markdown text-foreground/90 truncate min-w-0 flex-1">
                    {previewText}
                </span>
                {additionalLines > 0 && (
                    <span className="typography-meta text-muted-foreground shrink-0 tabular-nums">
                        {t('chat.userText.moreLines', { count: additionalLines })}
                    </span>
                )}
                <Icon name="arrow-down-s" className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            </div>
        );
    }

    return (
        <div className="relative" key={part.id || `${messageId}-user-text`}>
            {canCollapse && (
                <button
                    type="button"
                    onClick={handleCollapse}
                    className="absolute top-0 right-0 z-10 flex items-center justify-center rounded-sm bg-[var(--surface-elevated)] p-0.5 text-[var(--surface-mutedForeground)] hover:text-[var(--surface-foreground)] hover:bg-[var(--interactive-hover)] transition-colors"
                    aria-label={t('chat.userText.collapse')}
                >
                    <Icon name="arrow-up-s" className="h-3.5 w-3.5" />
                </button>
            )}
            <div
                className={cn(
                    "break-words font-sans typography-markdown-body",
                    canCollapse && "pb-3",
                    normalizedRenderingMode === 'plain' && 'whitespace-pre-wrap'
                )}
                onClick={handleExpandedClick}
            >
                {normalizedRenderingMode === 'markdown' ? (
                    <SimpleMarkdownRenderer
                        content={processedMarkdownContent}
                        className="[&_.markdown-content>*:first-child]:mt-0 [&_.markdown-content>*:last-child]:mb-0"
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
