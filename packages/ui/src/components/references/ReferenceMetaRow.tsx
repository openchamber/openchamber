import * as React from 'react';

import { cn } from '@/lib/utils';
import { REFERENCE_META_TEXT } from './referencePickerItems';

export const MetaRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <>
        <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{label}</dt>
        <dd className="min-w-0 typography-meta text-muted-foreground">{children}</dd>
    </>
);
