import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { PetCatalogEntry } from './catalog';
import type { CustomPetCatalogEntry } from './customPets';
import { PetPreview } from './PetPreview';

interface PetListItemProps {
    pet: PetCatalogEntry | CustomPetCatalogEntry;
    isSelected: boolean;
    onSelect: () => void;
}

export const PetListItem: React.FC<PetListItemProps> = ({ pet, isSelected, onSelect }) => {
    const { t } = useI18n();

    return (
        <div className="flex items-center gap-4 border-b border-border/60 px-4 py-3 last:border-b-0">
            <PetPreview pet={pet} size={48} />
            <div className="min-w-0 flex-1">
                <div className="text-base font-medium text-foreground">{pet.displayName}</div>
                <div className="truncate text-sm text-muted-foreground">{pet.description}</div>
            </div>
            <Button variant={isSelected ? 'secondary' : 'outline'} size="sm" onClick={onSelect} disabled={isSelected}>
                {isSelected ? t('settings.page.pets.action.selected') : t('settings.page.pets.action.select')}
            </Button>
        </div>
    );
};
