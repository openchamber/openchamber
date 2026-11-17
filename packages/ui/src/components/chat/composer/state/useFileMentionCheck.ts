import React from 'react';

import { findMissingPaths, type DirectoryLister } from '../attachments/inlineMentionAttachments';
import { confirmMention, isMentionDismissed, scanMentions } from '../language/mentions';
import { useComposerTextEffect, type ComposerText } from './composerText';

const CHECK_DELAY_MS = 200;
const CHECK_BATCH_SIZE = 8;

export function useFileMentionCheck({ text, enabled, confirmedMentionsRef, resolvePath, lister, onConfirmed }: {
    text: ComposerText;
    enabled: boolean;
    confirmedMentionsRef: React.RefObject<Set<string>>;
    resolvePath: (name: string) => string | null;
    lister: DirectoryLister;
    onConfirmed: () => void;
}): void {
    const missingRef = React.useRef({ resolvePath, names: new Set<string>() });

    useComposerTextEffect(text, (value) => {
        if (!enabled || !value.includes('@')) return;
        let cancelled = false;

        const timer = setTimeout(() => {
            void (async () => {
                if (missingRef.current.resolvePath !== resolvePath) {
                    missingRef.current = { resolvePath, names: new Set() };
                }
                const missing = missingRef.current.names;
                const confirmed = confirmedMentionsRef.current;
                const names = new Set(scanMentions(value, confirmed).map((token) => token.name));
                for (const name of missing) {
                    if (!names.has(name)) missing.delete(name);
                }

                const unchecked: Array<[name: string, path: string]> = [];
                for (const name of names) {
                    if (confirmed.has(name) || missing.has(name)) continue;
                    const path = resolvePath(name);
                    if (path) unchecked.push([name, path]);
                }

                for (let index = 0; index < unchecked.length; index += CHECK_BATCH_SIZE) {
                    const batch = unchecked.slice(index, index + CHECK_BATCH_SIZE);
                    const notFound = await findMissingPaths(batch.map(([, path]) => path), lister);
                    if (cancelled) return;
                    let anyConfirmed = false;
                    for (const [name, path] of batch) {
                        if (notFound.has(path)) {
                            missing.add(name);
                            continue;
                        }
                        const current = confirmedMentionsRef.current;
                        if (isMentionDismissed(name, current)) continue;
                        confirmMention(name, current);
                        anyConfirmed = true;
                    }
                    if (anyConfirmed) onConfirmed();
                }
            })();
        }, CHECK_DELAY_MS);

        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [confirmedMentionsRef, enabled, lister, onConfirmed, resolvePath]);
}
