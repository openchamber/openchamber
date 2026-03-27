import React from 'react';
import type { TurnProjectionResult } from '../lib/turns/types';

export interface TurnLookupResult {
    turnById: TurnProjectionResult['indexes']['turnById'];
    messageToTurnId: TurnProjectionResult['indexes']['messageToTurnId'];
    messageMetaById: TurnProjectionResult['indexes']['messageMetaById'];
    getTurnByMessageId: (messageId: string) => TurnProjectionResult['turns'][number] | undefined;
}

export const useTurnLookup = (projection: TurnProjectionResult): TurnLookupResult => {
    const getTurnByMessageId = React.useCallback((messageId: string) => {
        const turnId = projection.indexes.messageToTurnId.get(messageId);
        if (!turnId) {
            return undefined;
        }
        return projection.indexes.turnById.get(turnId);
    }, [projection.indexes.messageToTurnId, projection.indexes.turnById]);

    return {
        turnById: projection.indexes.turnById,
        messageToTurnId: projection.indexes.messageToTurnId,
        messageMetaById: projection.indexes.messageMetaById,
        getTurnByMessageId,
    };
};
