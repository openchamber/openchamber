import { isCapacitorMobileApp } from '@/apps/mobileNativeChrome';
import { shareFileFromNativeApp } from '@/lib/nativeFileShare';

export const saveFile = async (file: File): Promise<void> => {
    if (isCapacitorMobileApp()) {
        await shareFileFromNativeApp(file);
        return;
    }
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.download = file.name;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
};
