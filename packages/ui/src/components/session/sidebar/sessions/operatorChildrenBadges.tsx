import type React from 'react';

import { isOperatorChildSession } from '@/lib/sessionOperatorChild';
import type { SessionNode } from '../types';
import { OperatorChildrenCount } from './OperatorChildrenCount';

export const withOperatorChildrenCount = (marks: React.ReactNode, childNodes: readonly SessionNode[]): React.ReactNode => (
  childNodes.some((child) => isOperatorChildSession(child.session))
    ? <>{marks}<OperatorChildrenCount childNodes={childNodes} /></>
    : marks
);
