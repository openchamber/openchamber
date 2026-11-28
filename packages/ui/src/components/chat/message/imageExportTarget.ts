import { isCapacitorMobileApp } from '@/apps/mobileNativeChrome';
import type { I18nKey } from '@/lib/i18n';
import { useUIStore, type ImageExportTarget } from '@/stores/useUIStore';
import type { MessageImageDelivery } from './imageExport';

export const canCopyImageToClipboard = (): boolean => {
    if (isCapacitorMobileApp() || !globalThis.ClipboardItem || !globalThis.isSecureContext) return false;
    const clipboard = globalThis.navigator?.clipboard;
    return Boolean(clipboard && 'write' in clipboard);
};

export const resolveImageExportTarget = (target: ImageExportTarget, canCopy: boolean): ImageExportTarget => (canCopy ? target : 'file');

export const useImageExportTarget = (): ImageExportTarget => {
    const target = useUIStore((state) => state.imageExportTarget);
    return resolveImageExportTarget(target, canCopyImageToClipboard());
};

export const imageExportActionKey = (target: ImageExportTarget): I18nKey => {
    if (target === 'clipboard') return 'chat.messageBody.actions.copyAsImage';
    if (target === 'both') return 'chat.messageBody.actions.saveAndCopyAsImage';
    return 'chat.messageBody.actions.saveAsImage';
};

export const selectionImageExportLabelKey = (target: ImageExportTarget): I18nKey => {
    if (target === 'clipboard') return 'chat.messageSelection.copyImage';
    if (target === 'both') return 'chat.messageSelection.saveAndCopyImage';
    return 'chat.messageSelection.saveImage';
};

export const imageDeliveryToast = (delivery: MessageImageDelivery): { key: I18nKey; tone: 'success' | 'warning' | 'error' } | null => {
    if (delivery.canceled) return null;
    if (delivery.copyFailed) {
        return delivery.saved
            ? { key: 'chat.messageBody.toast.imageSavedCopyFailed', tone: 'warning' }
            : { key: 'chat.messageBody.toast.imageCopyFailed', tone: 'error' };
    }
    if (delivery.copied) {
        return delivery.saved
            ? { key: 'chat.messageBody.toast.imageSavedAndCopied', tone: 'success' }
            : { key: 'chat.messageBody.toast.imageCopied', tone: 'success' };
    }
    return delivery.saved ? { key: 'chat.messageBody.toast.imageSaved', tone: 'success' } : null;
};
