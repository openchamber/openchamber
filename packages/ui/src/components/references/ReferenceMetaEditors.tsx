import * as React from 'react';

import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { REFERENCE_META_TEXT } from './referencePickerItems';

export const MetaRow: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
    <>
        <dt className={cn('typography-meta', REFERENCE_META_TEXT)}>{label}</dt>
        <dd className="min-w-0 typography-meta text-muted-foreground">{children}</dd>
    </>
);

export const LoadError: React.FC<{ error: string }> = ({ error }) => {
    const { t } = useI18n();
    return <span className="text-[var(--status-error-text)]">{t('references.picker.error.load', { error })}</span>;
};
