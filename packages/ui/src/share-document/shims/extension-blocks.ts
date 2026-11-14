import { NO_EXTENSION_BLOCKS, type ExtensionBlocks } from '@/components/chat/uiBlocks/catalog';

/**
 * `useExtensionBlocks` inside a shared page: extensions run in the author's
 * app, so a reader gets only the built-in components, and a page naming an
 * extension's component draws as a page with an unknown component.
 */
export const useExtensionBlocks = (): ExtensionBlocks => NO_EXTENSION_BLOCKS;
