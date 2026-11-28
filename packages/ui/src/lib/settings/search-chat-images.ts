import type { SettingsSearchItem } from './search';
import { canCopyImageToClipboard } from '@/components/chat/message/imageExportTarget';

export const CHAT_IMAGE_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'chat.image-export',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.imageExportTarget',
    descriptionKey: 'settings.openchamber.visual.field.imageExportTargetInfo',
    keywords: ['image', 'png', 'save', 'copy', 'clipboard', 'screenshot', 'share'],
    isAvailable: () => canCopyImageToClipboard(),
  },
  {
    id: 'chat.save-pasted-images',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.savePastedImagesAsFiles',
    descriptionKey: 'settings.openchamber.visual.field.savePastedImagesAsFilesInfo',
    keywords: ['image', 'screenshot', 'paste', 'vision', 'text-only', 'model', 'path', 'attachment', 'file', 'link'],
  },
];
