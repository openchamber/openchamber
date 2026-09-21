import React from 'react';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { cn } from '@/lib/utils';

import { getApplyPatchFilePath } from './toolDiffUtils';

type ApplyPatchFileEntry = {
    file: Record<string, unknown>;
    path: string;
    name: string;
    added: number | null;
    removed: number | null;
};

const parseCount = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.trunc(value));
    }
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? Math.max(0, parsed) : null;
    }
    return null;
};

const combineCounts = (base: number | null, incoming: number | null): number | null => {
    if (base === null) return incoming;
    if (incoming === null) return base;
    return base + incoming;
};

const getApplyPatchFileEntries = (metadata: Record<string, unknown> | undefined): ApplyPatchFileEntry[] => {
    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    const entriesByPath = new Map<string, ApplyPatchFileEntry>();

    for (const file of files) {
        if (!file || typeof file !== 'object') continue;
        const fileRecord = file as Record<string, unknown>;
        const displayPath = typeof fileRecord.relativePath === 'string'
            ? fileRecord.relativePath
            : typeof fileRecord.filePath === 'string'
                ? fileRecord.filePath
                : '';
        if (!displayPath) continue;

        const added = parseCount(fileRecord.additions);
        const removed = parseCount(fileRecord.deletions);
        const existing = entriesByPath.get(displayPath);
        if (existing) {
            existing.added = combineCounts(existing.added, added);
            existing.removed = combineCounts(existing.removed, removed);
            continue;
        }

        entriesByPath.set(displayPath, {
            file: fileRecord,
            path: displayPath,
            name: displayPath.split('/').pop() || displayPath,
            added,
            removed,
        });
    }

    return Array.from(entriesByPath.values());
};

export const ApplyPatchFileButtons = ({
    animate = true,
    metadata,
    onFileClick,
    openDiffLabel,
    showFileIcons = true,
    textClassName,
}: {
    animate?: boolean;
    metadata: Record<string, unknown> | undefined;
    onFileClick?: (file: Record<string, unknown>, event: React.MouseEvent<HTMLButtonElement>) => void;
    openDiffLabel: string;
    showFileIcons?: boolean;
    textClassName?: string;
}): React.ReactNode => {
    const entries = getApplyPatchFileEntries(metadata);
    if (entries.length <= 1) return null;

    return (
        <>
            {entries.map((entry) => {
                const hasPerFileDiff = entry.added !== null || entry.removed !== null;
                const content = (
                    <>
                        {showFileIcons ? <FileTypeIcon filePath={entry.path} className="h-3.5 w-3.5" /> : null}
                        <Text
                            variant={animate ? 'generate-effect' : 'static'}
                            className={cn('min-w-0 max-w-full truncate', textClassName)}
                            style={{ color: 'var(--tools-description)' }}
                            title={entry.path}
                        >
                            {entry.name}
                        </Text>
                        {hasPerFileDiff ? (
                            <span className="flex-shrink-0 inline-flex items-center gap-0 typography-meta" style={{ fontSize: '0.8rem', lineHeight: '1' }}>
                                <span style={{ color: 'var(--status-success)' }}>+{entry.added ?? 0}</span>
                                <span style={{ color: 'var(--tools-description)' }}>/</span>
                                <span style={{ color: 'var(--status-error)' }}>-{entry.removed ?? 0}</span>
                            </span>
                        ) : null}
                    </>
                );
                const canOpen = onFileClick && entry.file.type !== 'delete' && getApplyPatchFilePath(entry.file);
                const actionLabel = `${openDiffLabel}: ${entry.path}`;
                return canOpen ? (
                    <Button
                        key={entry.path}
                        variant="ghost"
                        size="xs"
                        className={cn('min-w-0 max-w-full gap-1 normal-case font-normal tracking-normal', textClassName)}
                        aria-label={actionLabel}
                        title={actionLabel}
                        onClick={(event) => onFileClick(entry.file, event)}
                    >
                        {content}
                    </Button>
                ) : (
                    <span key={entry.path} className={cn('inline-flex min-w-0 max-w-full items-center gap-1', textClassName)} style={{ color: 'var(--tools-description)' }}>
                        {content}
                    </span>
                );
            })}
        </>
    );
};
