import * as React from 'react';

import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';

export const RawToggleContext = React.createContext<React.ReactNode>(null);

export const usePanelsAvailable = (isMobile: boolean): boolean => {
    const runtime = React.useContext(RuntimeAPIContext);
    return !isMobile && !runtime?.runtime.isVSCode;
};
