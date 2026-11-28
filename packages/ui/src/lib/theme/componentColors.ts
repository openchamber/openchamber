import type { Theme } from '@/types/theme';
import { mixColor, opaqueColor, withOpacity } from './color';

export function componentColors(theme: Theme) {
  const { primary, surface, interactive, status, syntax, chat, markdown, tools } = theme.colors;
  const background = chat?.background || surface.background;
  return {
    chat: { background, userMessageBackground: surface.elevated, divider: interactive.border, ...chat },
    markdown: {
      link: primary.base, linkHover: opaqueColor(primary.hover || primary.base),
      inlineCode: syntax.base.string, inlineCodeBackground: background,
      blockquote: surface.mutedForeground, blockquoteBorder: interactive.border,
      listMarker: mixColor(primary.base, surface.background, 0.6),
      bold: surface.foreground, italic: mixColor(surface.foreground, surface.background, 0.9),
      strikethrough: surface.mutedForeground, hr: interactive.border, ...markdown,
    },
    tools: {
      border: withOpacity(interactive.border, 0.3), icon: surface.mutedForeground,
      title: surface.foreground, description: mixColor(surface.mutedForeground, surface.background, 0.6),
      ...tools,
      edit: {
        addedBackground: status.successBackground, removedBackground: status.errorBackground,
        modifiedBackground: status.infoBackground, lineNumber: mixColor(surface.mutedForeground, surface.background, 0.6),
        ...tools?.edit,
      },
    },
  };
}
