import React from 'react';
import { TextSelectionMenu } from '../message/TextSelectionMenu';
import { useChatSurfaceMode } from '../useChatSurfaceMode';
import { useConfigStore } from '@/stores/useConfigStore';

export function HoistedUiPageSelection({ scrollNode, sessionId }: { scrollNode: HTMLElement; sessionId: string }) {
    const containerRef = React.useMemo(() => ({ current: scrollNode }), [scrollNode]);
    const surface = useChatSurfaceMode();
    const showTTS = useConfigStore((state) => state.showMessageTTSButtons);
    return <TextSelectionMenu containerRef={containerRef} readingKey={sessionId} uiRenderSelection
        canReadAloud={surface !== 'mini-chat' && showTTS} />;
}
