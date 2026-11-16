import React from 'react';

/**
 * Set by the phone's Status tab. The desktop card is dense, 28px rows read
 * with a pointer; on the phone the primitives take the phone's grouped look
 * (see `WorkStatusPrimitives.tsx`). The primitives read it, so sections need
 * no props.
 */
export const WorkStatusTouchContext = React.createContext(false);

/**
 * An extension's controls (header buttons and selects, actions in host-drawn
 * rows) keep the desktop's `xs` button, grown to the phone's 36px touch floor,
 * with room for a word its wider padding would otherwise cut.
 */
export const TOUCH_CONTROL_CLASS = 'h-9 max-w-[8rem] px-3';
