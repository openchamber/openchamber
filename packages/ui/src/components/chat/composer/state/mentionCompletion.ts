import type { ChangeDesc } from '@codemirror/state';

type CompletedMention = { start: number; end: number };

/** Explicit picker selections in the current composer document, never chip heuristics. */
export class MentionCompletionState {
    private mentions: CompletedMention[] = [];

    clear(): void {
        this.mentions = [];
    }

    isCompleted(start: number): boolean {
        return this.mentions.some((mention) => mention.start <= start && start < mention.end);
    }

    applyChange(changes: ChangeDesc, completesMention: boolean): void {
        this.mentions = this.mentions.flatMap((mention) => {
            let edited = false;
            changes.iterChangedRanges((from, to) => {
                // Inserting before @ moves the occurrence. Editing its name or
                // trailing boundary makes it an unfinished query again.
                if (from <= mention.end && to > mention.start) edited = true;
            });
            return edited ? [] : [{
                start: changes.mapPos(mention.start, 1),
                end: changes.mapPos(mention.end, -1),
            }];
        });

        if (completesMention) {
            changes.iterChangedRanges((_from, _to, start, end) => {
                // The shared picker insertion writes @reference plus one space.
                // Use the editor's normalized range rather than string length.
                this.mentions.push({ start, end: end - 1 });
            });
        }
    }
}
