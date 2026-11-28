import { useKeybinds } from '@/hooks/useKeybind';
import type { DiffData } from './types';

interface FileReviewNavigation<T> {
    path: (file: T) => string;
    staged?: (file: T) => boolean;
    isReviewed: (file: T) => boolean;
    toggle: (file: T, diff: DiffData | null) => void;
}

interface ChangedFileSteppingOptions<T> {
    visible: boolean;
    files: readonly T[];
    currentIndex: number;
    rootRef: React.RefObject<HTMLElement | null>;
    onStep: (file: T) => void;
    review: FileReviewNavigation<T>;
}

export function useChangedFileStepping<T>({ visible, files, currentIndex, rootRef, onStep, review }: ChangedFileSteppingOptions<T>) {
    const stepTo = (file: T) => {
        const root = rootRef.current;
        const focused = root?.ownerDocument.activeElement;
        if (focused?.closest('[data-review-file-path]') && root?.contains(focused)) {
            root.focus({ preventScroll: true });
        }
        onStep(file);
    };
    const findIndex = (path: string, staged?: boolean) => files.findIndex((file) => (
        review.path(file) === path && (!review.staged || review.staged(file) === staged)
    ));
    const canStep = (event: KeyboardEvent) => {
        if (!visible) return false;
        const target = event.target;
        return !(target instanceof HTMLElement && (
            target.isContentEditable
            || target.tagName === 'INPUT'
            || target.tagName === 'TEXTAREA'
            || target.closest('[role="dialog"]')
        ));
    };
    const toggleAndAdvance = (file: T, diff: DiffData | null) => {
        const wasReviewed = review.isReviewed(file);
        review.toggle(file, diff);
        if (wasReviewed) return;
        const index = findIndex(review.path(file), review.staged?.(file));
        if (index < 0) return;
        const next = files.find((entry, position) => position > index && !review.isReviewed(entry));
        if (next !== undefined) stepTo(next);
    };
    const step = (event: KeyboardEvent, delta: -1 | 1): boolean | void => {
        if (!canStep(event)) return false;
        if (files.length === 0) return;
        const nextIndex = currentIndex === -1
            ? (delta > 0 ? 0 : files.length - 1)
            : currentIndex + delta;
        const next = files[nextIndex];
        if (next === undefined) return;
        stepTo(next);
    };
    useKeybinds({
        diff_next_file: (event) => step(event, 1),
        diff_previous_file: (event) => step(event, -1),
        diff_review_next_file: (event) => {
            if (!canStep(event) || event.defaultPrevented) return false;
            const target = event.target instanceof Element ? event.target : null;
            const surface = target?.closest('[data-find-surface]');
            if (surface && surface !== rootRef.current) return false;
            const focusedFile = target?.closest<HTMLElement>('[data-review-file-path]');
            const index = focusedFile?.dataset.reviewFilePath
                ? findIndex(focusedFile.dataset.reviewFilePath, focusedFile.hasAttribute('data-review-file-staged'))
                : currentIndex;
            const current = files[index];
            if (current === undefined || review.isReviewed(current)) return false;
            toggleAndAdvance(current, null);
        },
    });
    return toggleAndAdvance;
}
