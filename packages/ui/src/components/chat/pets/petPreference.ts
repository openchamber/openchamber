/**
 * The selected pet id, stored locally per runtime. The visibility setting
 * (`showPet`) is a global contract that syncs across devices; which pet is
 * chosen is a local aesthetic preference, so it stays in localStorage.
 */

import React from 'react';
import { DEFAULT_PET_ID, PET_PREFERENCE_KEY } from './catalog';

function readPreference(): string {
    try {
        const value = window.localStorage.getItem(PET_PREFERENCE_KEY);
        if (value) {
            return value;
        }
    } catch {
        // Storage unavailable (privacy mode etc.): fall back to the default.
    }
    return DEFAULT_PET_ID;
}

function persistPreference(petId: string) {
    try {
        window.localStorage.setItem(PET_PREFERENCE_KEY, petId);
    } catch {
        // Non-fatal: the preference just does not persist this time.
    }
}

const listeners = new Set<() => void>();

function emitPreferenceChanged() {
    for (const listener of listeners) {
        listener();
    }
}

/** Reactive view of the stored pet preference. */
export function usePetPreference(): string {
    const [petId, setPetId] = React.useState<string>(readPreference);

    React.useEffect(() => {
        const listener = () => setPetId(readPreference());
        listeners.add(listener);
        return () => {
            listeners.delete(listener);
        };
    }, []);

    return petId;
}

export function changePetPreference(petId: string) {
    if (!petId) return;
    persistPreference(petId);
    emitPreferenceChanged();
}
