/**
 * Built-in pet catalog, ported from the Codex App avatar catalog.
 *
 * Assets are versioned spritesheets published on the public Codex pets CDN.
 * Each spritesheet is 1536x1872 (8 columns x 9 rows of 192x208 frames); the
 * animation tracks for every pet are identical, so they live in animations.ts
 * rather than being repeated per pet.
 */

export interface PetCatalogEntry {
    id: string;
    displayName: string;
    description: string;
    /** CDN-facing filename. Versioned: updating a pet means a new file name. */
    spritesheetFile: string;
}

const PET_CDN_BASE_URL = 'https://persistent.oaistatic.com/codex/pets/v1';

export const DEFAULT_PET_ID = 'codex';

export const PET_PREFERENCE_KEY = 'openchamber.petPreference';

export const BUILTIN_PETS: readonly PetCatalogEntry[] = [
    {
        id: 'codex',
        displayName: 'Codex',
        description: 'The original Codex companion',
        spritesheetFile: 'codex-spritesheet-v4.webp',
    },
    {
        id: 'dewey',
        displayName: 'Dewey',
        description: 'A tidy duck for calm workspace days',
        spritesheetFile: 'dewey-spritesheet-v4.webp',
    },
    {
        id: 'fireball',
        displayName: 'Fireball',
        description: 'Hot path energy for fast iteration',
        spritesheetFile: 'fireball-spritesheet-v4.webp',
    },
    {
        id: 'rocky',
        displayName: 'Rocky',
        description: 'A steady rock when the diff gets large',
        spritesheetFile: 'rocky-spritesheet-v4.webp',
    },
    {
        id: 'seedy',
        displayName: 'Seedy',
        description: 'Small green shoots for new ideas',
        spritesheetFile: 'seedy-spritesheet-v4.webp',
    },
    {
        id: 'stacky',
        displayName: 'Stacky',
        description: 'A balanced stack for deep work',
        spritesheetFile: 'stacky-spritesheet-v4.webp',
    },
    {
        id: 'bsod',
        displayName: 'BSOD',
        description: 'A tiny blue-screen gremlin',
        spritesheetFile: 'bsod-spritesheet-v4.webp',
    },
    {
        id: 'null-signal',
        displayName: 'Null Signal',
        description: 'Quiet signal from the void',
        spritesheetFile: 'null-signal-spritesheet-v4.webp',
    },
];

export function builtinPet(petId: string): PetCatalogEntry | undefined {
    return BUILTIN_PETS.find((pet) => pet.id === petId);
}

export function petSpriteUrl(pet: PetCatalogEntry): string {
    return `${PET_CDN_BASE_URL}/${pet.spritesheetFile}`;
}
