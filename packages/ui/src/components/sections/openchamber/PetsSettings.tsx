import React from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { updateDesktopSettings } from '@/lib/persistence';
import { useUIStore } from '@/stores/useUIStore';
import {
    SettingsSection,
    SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import {
    getCustomPetsDirectory,
    useAllPets,
} from '@/components/chat/pets/customPets';
import { changePetPreference, usePetPreference } from '@/components/chat/pets/petPreference';
import { PetListItem } from '@/components/chat/pets/PetListItem';
import { PetSizeSlider } from '@/components/chat/pets/PetSizeSlider';

export const PetsSettings: React.FC = () => {
    const { t } = useI18n();
    const showPet = useUIStore((state) => state.showPet);
    const setShowPet = useUIStore((state) => state.setShowPet);
    const petSize = useUIStore((state) => state.petSize);
    const setPetSize = useUIStore((state) => state.setPetSize);
    const petId = usePetPreference();
    const { all: allPets, refresh } = useAllPets();
    const runtimeApis = useRuntimeAPIs();
    const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

    const handleSelectPet = React.useCallback(
        (id: string) => {
            changePetPreference(id);
            if (!showPet) {
                setShowPet(true);
                void updateDesktopSettings({ showPet: true });
            }
        },
        [showPet, setShowPet],
    );

    // Wake: show the pet with no status bubble. Dismiss: hide it entirely.
    const handleWakePet = React.useCallback(() => {
        setShowPet(true);
        void updateDesktopSettings({ showPet: true });
    }, [setShowPet]);

    const handleDismissPet = React.useCallback(() => {
        setShowPet(false);
        void updateDesktopSettings({ showPet: false });
    }, [setShowPet]);

    const handleSizeChange = React.useCallback(
        (value: number) => {
            setPetSize(value);
            void updateDesktopSettings({ petSize: value });
        },
        [setPetSize],
    );

    const handleOpenFolder = React.useCallback(async () => {
        if (!homeDirectory || !runtimeApis?.files?.revealPath || !runtimeApis?.files?.createDirectory) return;
        const dir = getCustomPetsDirectory(homeDirectory);
        // The reveal route fails with 404 when the folder does not exist yet
        // (first visit); create it so the file manager opens the pets folder.
        try {
            await runtimeApis.files.createDirectory(dir);
        } catch {
            // Already exists (or read-only home): proceed to reveal anyway.
        }
        try {
            await runtimeApis.files.revealPath(dir);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t('settings.page.pets.action.openFolderFailed'));
        }
    }, [homeDirectory, runtimeApis, t]);

    const customPetsDir = homeDirectory ? getCustomPetsDirectory(homeDirectory) : '';

    const headerAction = React.useMemo(
        () => (
            <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" onClick={refresh} aria-label={t('settings.page.pets.action.refresh')}>
                    <Icon name="refresh" className="h-4 w-4" />
                </Button>
                {showPet ? (
                    <Button variant="outline" size="sm" onClick={handleDismissPet}>
                        {t('settings.page.pets.action.dismiss')}
                    </Button>
                ) : (
                    <Button size="sm" onClick={handleWakePet}>
                        {t('settings.page.pets.action.wake')}
                    </Button>
                )}
            </div>
        ),
        [handleDismissPet, handleWakePet, refresh, showPet, t],
    );

    return (
        <>
            <SettingsSection
                title={t('settings.page.pets.section.pet')}
                description={t('settings.page.pets.choosePetDescription')}
                divider={false}
                settingsItem="pets.choose-pet"
                headerAction={headerAction}
                contentClassName={SETTINGS_OPTION_STACK_CLASS}
            >
                <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)]">
                    {allPets.map((pet) => (
                        <PetListItem
                            key={pet.id}
                            pet={pet}
                            isSelected={pet.id === petId}
                            onSelect={() => handleSelectPet(pet.id)}
                        />
                    ))}
                </div>
            </SettingsSection>

            <SettingsSection
                title={t('settings.page.pets.section.customPets')}
                settingsItem="pets.custom-pets"
            >
                <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                        <div className="truncate text-sm text-muted-foreground">{customPetsDir}</div>
                    </div>
                    <Button variant="ghost" size="sm" onClick={handleOpenFolder}>
                        {t('settings.page.pets.action.openFolder')}
                    </Button>
                </div>
            </SettingsSection>

            <SettingsSection
                title={t('settings.page.pets.section.appearance')}
                settingsItem="pets.appearance"
            >
                <div className="rounded-xl border border-border/60 bg-[var(--surface-elevated)] p-4">
                    <div className="mb-3">
                        <div className="text-base font-medium text-foreground">
                            {t('settings.page.pets.field.petSize')}
                        </div>
                        <div className="text-sm text-muted-foreground">
                            {t('settings.page.pets.field.petSizeDescription')}
                        </div>
                    </div>
                    <PetSizeSlider value={petSize} onChange={handleSizeChange} />
                </div>
            </SettingsSection>
        </>
    );
};
