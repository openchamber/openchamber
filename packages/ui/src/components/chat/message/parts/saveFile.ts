import { isCapacitorMobileApp } from '@/apps/mobileNativeChrome';
import { shareFileFromNativeApp } from '@/lib/nativeFileShare';

/**
 * Saves a file the chat made or shows: the share sheet in the native app,
 * whose WebView has no downloads, a download everywhere else. Desktop names
 * its save dialog after the download URL, so the file goes as an object URL,
 * never a data URL.
 */
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
