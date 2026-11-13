import React from 'react';

/**
 * Set by the phone's Status tab. The desktop card is dense, 28px rows read
 * with a pointer; on the phone the primitives take the phone's grouped look
 * (see `WorkStatusPrimitives.tsx`). The primitives read it, so sections need
 * no props.
 */
export const WorkStatusTouchContext = React.createContext(false);
