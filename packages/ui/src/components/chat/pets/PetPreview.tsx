import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { SPRITESHEET_COLUMNS } from './animations';
import type { PetCatalogEntry } from './catalog';
import { loadCustomPetSprite, type CustomPetCatalogEntry } from './customPets';
import { getPetAssetImage, usePetAsset } from './petAssetStore';

interface PetPreviewProps {
    pet: PetCatalogEntry | CustomPetCatalogEntry;
    size?: number;
}

export const PetPreview: React.FC<PetPreviewProps> = ({ pet, size = 48 }) => {
    const runtimeApis = useRuntimeAPIs();
    const loadSprite = React.useMemo(() => {
        if ('isCustom' in pet && runtimeApis?.files?.readFileBinary) {
            return () => loadCustomPetSprite(runtimeApis.files, pet as CustomPetCatalogEntry);
        }
        return undefined;
    }, [pet, runtimeApis]);
    const assetStatus = usePetAsset(pet, loadSprite);

    if (assetStatus !== 'ok') {
        return (
            <div
                className="shrink-0 rounded-md bg-[var(--surface-muted)]"
                style={{ width: size, height: size }}
            />
        );
    }

    const image = getPetAssetImage(pet.id);
    if (!image) {
        return (
            <div
                className="shrink-0 rounded-md bg-[var(--surface-muted)]"
                style={{ width: size, height: size }}
            />
        );
    }

    return (
        <div
            className="shrink-0"
            style={{
                width: size,
                height: size,
                backgroundImage: `url(${image.src})`,
                backgroundSize: `${SPRITESHEET_COLUMNS * size}px ${9 * size}px`,
                backgroundPosition: '0 0',
                backgroundRepeat: 'no-repeat',
            }}
        />
    );
};
