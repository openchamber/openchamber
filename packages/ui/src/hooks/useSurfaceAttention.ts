import React from 'react';

import { onSurfaceAttentionChange } from '@/lib/surfaceAttention';

export const useSurfaceAttention = (key: string, onChange: (attended: boolean) => void, onEnter: () => void, onLeave: () => void): void => {
    const handlersRef = React.useRef({ onChange, onEnter, onLeave });
    handlersRef.current = { onChange, onEnter, onLeave };
    React.useEffect(() => {
        const stop = onSurfaceAttentionChange((attended) => handlersRef.current.onChange(attended));
        const { onEnter: enter, onLeave: leave } = handlersRef.current;
        enter();
        return () => {
            stop();
            leave();
        };
    }, [key]);
};
