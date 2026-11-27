import React from 'react';
import { ContextWindowLayout } from './ContextWindowLayout';
import { MainLayout } from './MainLayout';
import { isContextWindow } from '@/lib/contextWindow/role';
import { TrackerItemRequests } from '@/components/sourceBoard/trackerItemRequest';

export const WindowLayout: React.FC = () => (isContextWindow() ? <ContextWindowLayout /> : <><TrackerItemRequests /><MainLayout /></>);
