import React from 'react';
import type { MotionValue } from 'motion/react';

export interface DrawerContextValue {
    leftDrawerOpen: boolean;
    rightDrawerOpen: boolean;
    toggleLeftDrawer: () => void;
    toggleRightDrawer: () => void;
    // Motion values for real-time drawer dragging
    leftDrawerX: MotionValue<number>;
    rightDrawerX: MotionValue<number>;
    leftDrawerWidth: React.MutableRefObject<number>;
    rightDrawerWidth: React.MutableRefObject<number>;
    setMobileLeftDrawerOpen: (open: boolean) => void;
    setRightSidebarOpen: (open: boolean) => void;
}

const DrawerContext = React.createContext<DrawerContextValue | null>(null);

export const DrawerProvider: React.FC<{
    children: React.ReactNode;
    value: DrawerContextValue;
}> = ({ children, value }) => {
    return (
        <DrawerContext.Provider value={value}>
            {children}
        </DrawerContext.Provider>
    );
};

// eslint-disable-next-line react-refresh/only-export-components
export const useDrawer = (): DrawerContextValue => {
    const context = React.useContext(DrawerContext);
    if (!context) {
        throw new Error('useDrawer must be used within a DrawerProvider');
    }
    return context;
};
