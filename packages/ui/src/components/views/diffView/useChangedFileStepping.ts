import { useKeybinds } from '@/hooks/useKeybind';

interface ChangedFileSteppingOptions<T> {
    visible: boolean;
    files: readonly T[];
    currentIndex: number;
    onStep: (file: T) => void;
}

export function useChangedFileStepping<T>({ visible, files, currentIndex, onStep }: ChangedFileSteppingOptions<T>) {
    const step = (event: KeyboardEvent, delta: -1 | 1): boolean | void => {
        if (!visible) return false;
        const target = event.target;
        if (target instanceof HTMLElement && (
            target.isContentEditable
            || target.tagName === 'INPUT'
            || target.tagName === 'TEXTAREA'
            || target.closest('[role="dialog"]')
        )) {
            return false;
        }
        if (files.length === 0) return;
        const nextIndex = currentIndex === -1
            ? (delta > 0 ? 0 : files.length - 1)
            : currentIndex + delta;
        const next = files[nextIndex];
        if (next === undefined) return;
        onStep(next);
    };
    useKeybinds({
        diff_next_file: (event) => step(event, 1),
        diff_previous_file: (event) => step(event, -1),
    });
}
