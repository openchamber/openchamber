import React from 'react';

import { TrackerItemRequests } from '@/components/sourceBoard/trackerItemRequest';

import { DedicatedMobileAppProvider, type MobileAppActions } from './mobileAppContext';

export type { MobileAppActions };

export const MobileAppScope: React.FC<{ actions: MobileAppActions; children: React.ReactNode }> = ({ actions, children }) => (
  <DedicatedMobileAppProvider actions={actions}>
    <TrackerItemRequests />
    {children}
  </DedicatedMobileAppProvider>
);
