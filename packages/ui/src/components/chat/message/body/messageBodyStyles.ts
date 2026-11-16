// Layout containment only. A `translateZ(0)` here once gave every message its
// own compositor layer; the transcript's scroller is already one, so the extra
// layers only added tiles (about 10 MB of GPU memory for one screen of chat).
export const CONTAIN_LAYOUT_STYLE = { contain: 'layout' as const };
export const MESSAGE_FOOTER_CONTAINER_STYLE = { containerType: 'inline-size' as const, containerName: 'message-footer' };
export const INLINE_MESSAGE_ACTIONS_CLASS_NAME = 'mt-2 mb-1 flex items-center justify-start gap-1.5';
