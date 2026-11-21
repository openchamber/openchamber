import React from 'react';

import { LiveActivityInteractionContext } from '@/components/chat/components/liveActivityContext';

export const useLiveActivityHold = (held: boolean): boolean | null => {
    const interaction = React.useContext(LiveActivityInteractionContext);
    const hold = interaction?.hold;
    const release = interaction?.release;
    React.useEffect(() => {
        if (!hold || !release || !held) return;
        hold();
        return release;
    }, [hold, release, held]);
    return interaction?.pagesShown ?? null;
};
