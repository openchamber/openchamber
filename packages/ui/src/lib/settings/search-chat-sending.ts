import type { SettingsSearchItem } from './search';

export const CHAT_SENDING_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'chat.keep-model-on-agent-switch',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.keepModelOnAgentSwitch',
    descriptionKey: 'settings.openchamber.visual.field.keepModelOnAgentSwitchInfo',
    keywords: ['agent', 'plan', 'build', 'mode', 'switch', 'model', 'thinking', 'effort', 'reasoning', 'variant', 'cost'],
  },
  {
    id: 'chat.composer',
    page: 'chat',
    titleKey: 'settings.layout.chat.section.sending',
    keywords: ['composer', 'input', 'send', 'paste', 'follow-up'],
  },
  {
    id: 'chat.spellcheck',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.enableSpellcheckInTextInputs',
    keywords: ['spelling', 'input'],
    isAvailable: (ctx) => !ctx.isMobile,
  },
  {
    id: 'chat.large-text-paste',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.largeTextPaste',
    descriptionKey: 'settings.openchamber.visual.field.largeTextPasteHint',
    keywords: ['paste', 'clipboard', 'attachment', 'large', 'text', 'file', 'double paste', 'ctrl v', 'cmd v'],
  },
  {
    id: 'chat.document-attach',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.documentAttach',
    descriptionKey: 'settings.openchamber.visual.field.documentAttachHint',
    keywords: ['office', 'document', 'word', 'excel', 'powerpoint', 'opendocument', 'docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'drop', 'attachment', 'convert', 'save'],
  },
  {
    id: 'chat.enter-to-send',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.enterToSend',
    descriptionKey: 'settings.openchamber.visual.field.enterToSendHint',
    keywords: ['enter', 'shift enter', 'ctrl enter', 'cmd enter', 'mod enter', 'send', 'newline'],
    isAvailable: (ctx) => !ctx.isMobile,
  },
  {
    id: 'chat.mobile-return-key-sends',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.mobileReturnKeySends',
    descriptionKey: 'settings.openchamber.visual.field.mobileReturnKeySendsHint',
    keywords: ['enter', 'return', 'send', 'newline', 'keyboard', 'enterkeyhint', 'voice', 'dictation', 'swipe up'],
    isAvailable: (ctx) => ctx.isMobile,
  },
];
