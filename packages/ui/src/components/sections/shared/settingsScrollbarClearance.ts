import React from 'react';

/**
 * Pixels the page scrollbar keeps clear at the top of the Settings content
 * pane. Settings sets it where its close button floats over the content's
 * top-right corner; `SettingsPageLayout` reads it.
 */
export const SettingsScrollbarTopClearanceContext = React.createContext(0);
