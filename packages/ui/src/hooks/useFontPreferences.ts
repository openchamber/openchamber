import type { MonoFontOption, UiFontOption } from '@/lib/fontOptions';
import { useUIStore } from '@/stores/useUIStore';

interface FontPreferences {
    uiFont: UiFontOption;
    monoFont: MonoFontOption;
    customUiFont: string;
    customMonoFont: string;
}

export const useFontPreferences = (): FontPreferences => {
    const uiFont = useUIStore(state => state.uiFont);
    const monoFont = useUIStore(state => state.monoFont);
    const customUiFont = useUIStore(state => state.customUiFont);
    const customMonoFont = useUIStore(state => state.customMonoFont);

    return {
        uiFont,
        monoFont,
        customUiFont,
        customMonoFont,
    };
};
