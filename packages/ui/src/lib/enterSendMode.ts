export const ENTER_SEND_MODES = ['enter', 'modifier', 'right-modifier'] as const;

export type EnterSendMode = (typeof ENTER_SEND_MODES)[number];

export interface EnterSendModeSettings {
    enterToSend: boolean;
    enterToSendConfigured: boolean;
    enterToSendMode?: EnterSendMode;
}

type ResolvedEnterSendMode = EnterSendMode | 'default';

export const resolveEnterSendMode = ({
    enterToSend,
    enterToSendConfigured,
    enterToSendMode,
}: EnterSendModeSettings): ResolvedEnterSendMode => {
    if (enterToSendMode) return enterToSendMode;
    if (!enterToSendConfigured) return 'default';
    return enterToSend ? 'enter' : 'modifier';
};
