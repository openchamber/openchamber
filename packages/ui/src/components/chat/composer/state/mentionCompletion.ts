import type { ChangeDesc } from '@codemirror/state';

type CompletedMention = { start: number; end: number };

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
                if (from <= mention.end && to > mention.start) edited = true;
            });
            return edited ? [] : [{
                start: changes.mapPos(mention.start, 1),
                end: changes.mapPos(mention.end, -1),
            }];
        });

        if (completesMention) {
            changes.iterChangedRanges((_from, _to, start, end) => {
                this.mentions.push({ start, end: end - 1 });
            });
        }
    }
}
