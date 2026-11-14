/**
 * The app modules a shared page replaces, by their path under `packages/ui/src`
 * without extension, with the shim that stands in for each. The page has no
 * stores, runtime or project: these are the seams where the UI block renderer
 * reaches for them. The bundle build (`packages/web/vite-share-document.ts`)
 * and the string collector (`messages.ts`) both read this map.
 */
export const SHARE_DOCUMENT_SHIMS = {
  'lib/i18n/index': 'share-document/shims/i18n.ts',
  'stores/useUIStore': 'share-document/shims/ui-store.ts',
  'hooks/useEffectiveDirectory': 'share-document/shims/effective-directory.ts',
  'components/chat/uiBlocks/useExtensionBlocks': 'share-document/shims/extension-blocks.ts',
  'components/chat/uiBlocks/ExtensionBlockFrame': 'share-document/shims/extension-block-frame.tsx',
  'components/chat/MarkdownRenderer': 'share-document/shims/markdown.tsx',
  'components/emoji/useEmojiPicker': 'share-document/shims/emoji-picker.ts',
  'lib/desktop': 'share-document/shims/desktop.ts',
} as const satisfies Record<string, string>;

export const SHARE_DOCUMENT_ENTRY = 'share-document/entry.tsx';
