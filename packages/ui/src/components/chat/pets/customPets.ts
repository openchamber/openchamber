import type { FilesAPI } from '@/lib/api/types';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import React from 'react';
import { BUILTIN_PETS, builtinPet, type PetCatalogEntry } from './catalog';

interface CustomPetManifest {
    id?: string;
    displayName?: string;
    description?: string;
    spritesheetPath?: string;
}

export interface CustomPetCatalogEntry extends PetCatalogEntry {
    /** Absolute path to the pet's containing directory. */
    directory: string;
    /** True for pets loaded from the user's custom pets directory. */
    isCustom: true;
}

const CUSTOM_PET_PREFIX = 'custom:';

export function getCustomPetsDirectory(homeDirectory: string): string {
    return `${homeDirectory}/.opencode/pets`;
}

function makeCustomPetId(folderName: string): string {
    return `${CUSTOM_PET_PREFIX}${folderName}`;
}

export function resolvePet(
    petId: string,
    customPets: CustomPetCatalogEntry[],
): PetCatalogEntry | CustomPetCatalogEntry | undefined {
    return builtinPet(petId) ?? customPets.find((pet) => pet.id === petId);
}

/**
 * Scan the user's custom pets directory for available pets.
 * Each subfolder is treated as one pet. The folder may contain a `pet.json`
 * manifest; otherwise the folder name is used as the display name and a
 * `spritesheet.webp` inside the folder is assumed.
 */
export async function scanCustomPets(
    files: FilesAPI,
    homeDirectory: string,
): Promise<CustomPetCatalogEntry[]> {
    const dir = getCustomPetsDirectory(homeDirectory);
    const result = await files.listDirectory(dir, { respectGitignore: false });
    const folders = result.entries.filter((entry) => entry.isDirectory);

    const pets: CustomPetCatalogEntry[] = [];
    for (const folder of folders) {
        const directory = folder.path;
        const folderName = folder.name;
        let manifest: CustomPetManifest = {};
        try {
            if (files.readFile) {
                const manifestResult = await files.readFile(`${directory}/pet.json`);
                if (manifestResult?.content) {
                    manifest = JSON.parse(manifestResult.content) as CustomPetManifest;
                }
            }
        } catch {
            // No manifest is fine; fall back to folder name + default spritesheet.
        }

        const spritesheetFile = manifest.spritesheetPath
            ? manifest.spritesheetPath.replace(/^\.\//, '')
            : 'spritesheet.webp';

        const id = manifest.id ?? folderName;
        pets.push({
            id: makeCustomPetId(id),
            displayName: manifest.displayName ?? folderName,
            description: manifest.description ?? '',
            spritesheetFile,
            directory,
            isCustom: true,
        });
    }

    return pets;
}

/**
 * Read a custom pet's spritesheet as a base64 data URL and decode it into an
 * image. Returns null on failure so the UI can show an explicit error state.
 */
export async function loadCustomPetSprite(
    files: FilesAPI,
    pet: CustomPetCatalogEntry,
): Promise<HTMLImageElement | null> {
    if (!files.readFileBinary) {
        return null;
    }
    const path = `${pet.directory}/${pet.spritesheetFile}`;
    try {
        const result = await files.readFileBinary(path);
        if (!result?.dataUrl) {
            return null;
        }
        return await decodeDataUrl(result.dataUrl);
    } catch {
        return null;
    }
}

function decodeDataUrl(dataUrl: string): Promise<HTMLImageElement | null> {
    return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
            if (image.naturalWidth === 0 || image.naturalHeight === 0) {
                resolve(null);
                return;
            }
            resolve(image);
        };
        image.onerror = () => resolve(null);
        image.src = dataUrl;
    });
}

export interface AllPetsResult {
    builtIn: readonly PetCatalogEntry[];
    custom: CustomPetCatalogEntry[];
    all: (PetCatalogEntry | CustomPetCatalogEntry)[];
    isLoading: boolean;
    refresh: () => void;
}

export function useAllPets(): AllPetsResult {
    const runtimeApis = useRuntimeAPIs();
    const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
    const [customPets, setCustomPets] = React.useState<CustomPetCatalogEntry[]>([]);
    const [isLoading, setIsLoading] = React.useState(false);
    const [epoch, setEpoch] = React.useState(0);

    const refresh = React.useCallback(() => setEpoch((e) => e + 1), []);

    React.useEffect(() => {
        if (!homeDirectory || !runtimeApis?.files?.listDirectory) {
            setCustomPets([]);
            setIsLoading(false);
            return;
        }
        let cancelled = false;
        setIsLoading(true);
        scanCustomPets(runtimeApis.files, homeDirectory)
            .then((pets) => {
                if (!cancelled) setCustomPets(pets);
            })
            .catch(() => {
                if (!cancelled) setCustomPets([]);
            })
            .finally(() => {
                if (!cancelled) setIsLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [homeDirectory, runtimeApis?.files, epoch]);

    const all = React.useMemo(() => [...BUILTIN_PETS, ...customPets], [customPets]);
    return { builtIn: BUILTIN_PETS, custom: customPets, all, isLoading, refresh };
}
