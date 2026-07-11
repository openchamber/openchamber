import React from 'react';
import type { RuntimeAPIs } from '@/lib/api/types';

export const RuntimeAPIContext = React.createContext<RuntimeAPIs | null>(null);
