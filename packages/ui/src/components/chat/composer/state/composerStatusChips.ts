import React from 'react';

import type { IconName } from '@/components/icon/icons';

/**
 * The composer's top rows, in the order they stack. On a phone, two or more
 * of them collapse into one line of chips (MobileComposerTopRows); each row
 * names itself here while it is on screen.
 */
export const COMPOSER_STATUS_ROW_ORDER = [
    'folderMissing',
    'worktree',
    'creating',
    'space',
    'interrupted',
    'goal',
    'autoReview',
    'shells',
    'revert',
    'queue',
    'done',
    'suggestion',
] as const;

export type ComposerStatusRowId = (typeof COMPOSER_STATUS_ROW_ORDER)[number];

export type ComposerStatusChip = {
    icon: IconName;
    label: string;
    spin?: boolean;
};

type Register = (id: ComposerStatusRowId, chip: ComposerStatusChip | null) => void;

export const ComposerStatusChipsContext = React.createContext<Register | null>(null);

/**
 * Names a top row for the phone's chip line while `chip` is non-null. Outside
 * a phone composer there is no registry and the call does nothing.
 */
export function useComposerStatusChip(id: ComposerStatusRowId, chip: ComposerStatusChip | null): void {
    const register = React.useContext(ComposerStatusChipsContext);
    const icon = chip?.icon;
    const label = chip?.label;
    const spin = chip?.spin === true;
    React.useLayoutEffect(() => {
        if (!register) return;
        register(id, icon && label !== undefined ? { icon, label, spin } : null);
    }, [register, id, icon, label, spin]);
    React.useLayoutEffect(() => {
        if (!register) return;
        return () => register(id, null);
    }, [register, id]);
}
