import React from 'react';
import { ContextWindowLayout } from './ContextWindowLayout';
import { MainLayout } from './MainLayout';
import { isContextWindow } from '@/lib/contextWindow/role';

export const WindowLayout: React.FC = () => (isContextWindow() ? <ContextWindowLayout /> : <MainLayout />);
