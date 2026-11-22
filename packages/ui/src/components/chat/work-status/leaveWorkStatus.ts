import React from 'react';

export const LeaveWorkStatusContext = React.createContext<(() => void) | null>(null);

export const useLeaveWorkStatus = (): (() => void) | null => React.useContext(LeaveWorkStatusContext);
