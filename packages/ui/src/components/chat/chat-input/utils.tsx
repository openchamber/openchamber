import React from 'react';
import { formatDirectoryName } from '@/lib/utils';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import type { Part } from '@opencode-ai/sdk/v2/client';
import { isSyntheticPart } from '@/lib/messages/synthetic';
import { getSyncMessages } from '@/sync/sync-refs';
import { Icon } from '@/components/icon/Icon';
import { INLINE_SKILL_TOKEN_PATTERN, FILE_URI_PREFIX } from './constants';

export const renameFileForAttachmentCitation = (file: File, filename: string): File => {
    if (file.name === filename) {
        return file;
    }

    return new File([file], filename, {
        type: file.type,
        lastModified: file.lastModified,
    });
};

export const buildImagePasteInsertion = (pastedText: string, citationText: string): string => {
    const text = pastedText;
    if (!text) {
        return citationText;
    }
    return `${text}${/\s$/.test(text) ? '' : ' '}${citationText}`;
};

export const withInlineInsertionBoundaries = (content: string, before: string, after: string): string => {
    if (!content) {
        return content;
    }

    const needsLeadingSpace = before.length > 0
        && !/\s$/.test(before)
        && !/^\s/.test(content)
        && !/[([{]$/.test(before);
    const needsTrailingSpace = after.length > 0
        && !/\s$/.test(content)
        && !/^\s/.test(after)
        && !/^[\])}.,;:!?]/.test(after);

    return `${needsLeadingSpace ? ' ' : ''}${content}${needsTrailingSpace ? ' ' : ''}`;
};

export const collectInlineSkillMentions = (text: string, skillNames: Set<string>): string[] => {
    const mentions: string[] = [];
    INLINE_SKILL_TOKEN_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INLINE_SKILL_TOKEN_PATTERN.exec(text)) !== null) {
        const name = match[2] || '';
        if (!skillNames.has(name) || mentions.includes(name)) {
            continue;
        }
        mentions.push(name);
    }
    return mentions;
};

export const buildSkillMentionInstruction = (skillNames: string[]): string | null => {
    if (skillNames.length === 0) return null;
    const formatted = skillNames.map((name) => `/${name}`).join(', ');
    return `The user explicitly mentioned these skills in their message: ${formatted}. Use the corresponding skill tool when it is relevant to accomplishing the user's request.`;
};

export const hasUserMessages = (sessionId: string, directory?: string) => {
    return getSyncMessages(sessionId, directory).some((message) => message.role === 'user');
};

export const getRevertedPreview = (parts: Part[], fallback: string): string => {
    const text = parts
        .filter((part) => part.type === 'text' && !isSyntheticPart(part))
        .map((part) => {
            const record = part as Record<string, unknown>;
            return typeof record.text === 'string'
                ? record.text
                : typeof record.content === 'string'
                    ? record.content
                    : '';
        })
        .join('\n')
        .replace(/\s+/g, ' ')
        .trim();

    if (text) return text;
    const filePart = parts.find((part) => part.type === 'file') as (Part & { filename?: string }) | undefined;
    return filePart?.filename ? `[${filePart.filename}]` : fallback;
};

const encodeFilePath = (filepath: string): string => {
    let normalized = filepath.replace(/\\/g, '/');
    if (/^[A-Za-z]:/.test(normalized)) {
        normalized = `/${normalized}`;
    }
    return normalized
        .split('/')
        .map((segment, index) => {
            if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
            return encodeURIComponent(segment);
        })
        .join('/');
};

export const toServerFileUrl = (filepath: string): string => {
    const normalized = filepath.replace(/\\/g, '/').trim();
    if (normalized.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return normalized;
    }
    return `file://${encodeFilePath(normalized)}`;
};

export const isLikelyAbsolutePath = (value: string): boolean => (
    value.startsWith('/')
    || value.startsWith('\\\\')
    || /^[A-Za-z]:[\\/]/.test(value)
);

export const toLikelyFileDropReference = (value: string): string | null => {
    const trimmed = value.trim().replace(/^['"]+|['"]+$/g, '');
    if (!trimmed) {
        return null;
    }

    if (/[\r\n]/.test(trimmed)) {
        return null;
    }

    if (trimmed.toLowerCase().startsWith(FILE_URI_PREFIX)) {
        return trimmed;
    }

    if (isLikelyAbsolutePath(trimmed)) {
        return trimmed;
    }

    return null;
};

const collectStringLeaves = (input: unknown, output: Set<string>, depth = 0): void => {
    if (depth > 6 || input == null) {
        return;
    }

    if (typeof input === 'string') {
        output.add(input);
        return;
    }

    if (Array.isArray(input)) {
        for (const item of input) {
            collectStringLeaves(item, output, depth + 1);
        }
        return;
    }

    if (typeof input !== 'object') {
        return;
    }

    for (const value of Object.values(input)) {
        collectStringLeaves(value, output, depth + 1);
    }
};

export const parseDroppedFileReferences = (rawPayload: string): string[] => {
    const extracted = new Set<string>();

    const addCandidatesFromText = (value: string): void => {
        const direct = toLikelyFileDropReference(value);
        if (direct) {
            extracted.add(direct);
            return;
        }

        for (const line of value.split(/\r?\n/)) {
            const candidate = toLikelyFileDropReference(line);
            if (candidate) {
                extracted.add(candidate);
            }
        }
    };

    addCandidatesFromText(rawPayload);

    try {
        const parsed = JSON.parse(rawPayload) as unknown;
        const leaves = new Set<string>();
        collectStringLeaves(parsed, leaves);
        for (const leaf of leaves) {
            addCandidatesFromText(leaf);
        }
    } catch {
        // Ignore non-JSON payloads.
    }

    return Array.from(extracted);
};

export const normalizePath = (value?: string | null): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    const normalized = trimmed.replace(/\\/g, '/');
    if (normalized === '/') {
        return '/';
    }
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
};

export const getProjectDisplayLabel = (project: { label?: string; path: string }): string => {
    const label = project.label?.trim();
    if (label) {
        return label;
    }
    return formatDirectoryName(project.path);
};

export const renderDraftTitle = (title: string, projectLabel: string | null): React.ReactNode => {
    if (!projectLabel) return title;
    const projectIndex = title.indexOf(projectLabel);
    if (projectIndex === -1) return title;

    return (
        <>
            {title.slice(0, projectIndex)}
            <span className="font-medium">{projectLabel}</span>
            {title.slice(projectIndex + projectLabel.length)}
        </>
    );
};

export const getProjectIconColor = (projectColor?: string | null): string | undefined => {
    if (!projectColor) {
        return undefined;
    }
    return PROJECT_COLOR_MAP[projectColor] ?? undefined;
};

export const renderProjectLabelWithIcon = (
    project: {
        id: string;
        path: string;
        label?: string;
        icon?: string | null;
        color?: string | null;
        iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
        iconBackground?: string | null;
    },
    currentTheme: { colors: { surface: { foreground: string } }; metadata: { variant: string } },
): React.ReactNode => {
    const projectIconName = project.icon ? PROJECT_ICON_MAP[project.icon] : null;
    const iconColor = getProjectIconColor(project.color);
    const fallbackIcon = projectIconName ? (
        <Icon name={projectIconName} className="h-3.5 w-3.5 shrink-0" style={iconColor ? { color: iconColor } : undefined} />
    ) : (
        <Icon name="folder" className="h-3.5 w-3.5 shrink-0 text-muted-foreground/80" style={iconColor ? { color: iconColor } : undefined} />
    );

    return (
        <span className="inline-flex min-w-0 items-center gap-1.5">
            {project.iconImage ? (
                <span
                    className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center overflow-hidden rounded-[3px]"
                    style={project.iconBackground ? { backgroundColor: project.iconBackground } : undefined}
                >
                    <ProjectIconImage
                        project={{ id: project.id, iconImage: project.iconImage ?? null }}
                        options={{
                            themeVariant: currentTheme.metadata.variant as 'light' | 'dark',
                            iconColor: currentTheme.colors.surface.foreground,
                        }}
                        className="h-full w-full object-contain"
                        fallback={fallbackIcon}
                    />
                </span>
            ) : fallbackIcon}
            <span className="truncate">{getProjectDisplayLabel(project)}</span>
        </span>
    );
};

export const appendWithLineBreaks = (base: string, next: string): string => {
    const separator = !base
        ? ''
        : base.endsWith('\n\n')
            ? ''
            : base.endsWith('\n')
                ? '\n'
                : '\n\n';

    const nextWithTrailingBreaks = next.endsWith('\n\n')
        ? next
        : next.endsWith('\n')
            ? `${next}\n`
            : `${next}\n\n`;

    return `${base}${separator}${nextWithTrailingBreaks}`;
};

export const appendInlineText = (base: string, next: string): string => {
    const nextTrimmed = next.trim();
    if (!nextTrimmed) {
        return base;
    }
    if (!base) {
        return `${nextTrimmed} `;
    }
    const separator = /[\s\n]$/.test(base) ? '' : ' ';
    return `${base}${separator}${nextTrimmed} `;
};

// Per-session draft key — preserves in-progress messages across project switches
export const getDraftKey = (sessionId: string | null): string =>
    `openchamber_chat_input_draft_${sessionId ?? 'new'}`;

// Helper to safely read from localStorage for a given session
export const getStoredDraft = (sessionId: string | null): string => {
    try {
        return localStorage.getItem(getDraftKey(sessionId)) ?? '';
    } catch {
        return '';
    }
};

// Helper to safely write/clear a per-session draft
export const saveStoredDraft = (sessionId: string | null, draft: string): void => {
    try {
        if (draft) {
            localStorage.setItem(getDraftKey(sessionId), draft);
        } else {
            localStorage.removeItem(getDraftKey(sessionId));
        }
    } catch {
        // Ignore localStorage errors
    }
};

// Per-session confirmed mentions key — tracks which @mentions are confirmed (blue) vs plain text
export const getConfirmedMentionsKey = (sessionId: string | null): string =>
    `openchamber_chat_confirmed_mentions_${sessionId ?? 'new'}`;

export const saveConfirmedMentions = (sessionId: string | null, mentions: Set<string>): void => {
    try {
        if (mentions.size > 0) {
            localStorage.setItem(getConfirmedMentionsKey(sessionId), JSON.stringify([...mentions]));
        } else {
            localStorage.removeItem(getConfirmedMentionsKey(sessionId));
        }
    } catch {
        // Ignore localStorage errors
    }
};

export const loadConfirmedMentions = (sessionId: string | null): Set<string> => {
    try {
        const raw = localStorage.getItem(getConfirmedMentionsKey(sessionId));
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) {
                return new Set(parsed.filter((v): v is string => typeof v === 'string'));
            }
        }
    } catch {
        // Ignore localStorage errors
    }
    return new Set();
};
