import * as React from 'react';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';

/** The row's own "Show the raw answer" switch, which the actions row of a tool result view ends with. */
export const RawToggleContext = React.createContext<React.ReactNode>(null);

/** Where a panel can open beside the chat: not on a phone or in VS Code, which show one surface at a time. */
export const usePanelsAvailable = (isMobile: boolean): boolean => {
    const runtime = React.useContext(RuntimeAPIContext);
    return !isMobile && !runtime?.runtime.isVSCode;
};
