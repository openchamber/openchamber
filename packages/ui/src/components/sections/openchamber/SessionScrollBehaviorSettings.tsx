import React from 'react';

import { Radio } from '@/components/ui/radio';
import { useUIStore, type SessionScrollRestoreMode } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

const RESTORE_OPTIONS: { id: SessionScrollRestoreMode; labelKey: string }[] = [
    { id: 'restore', labelKey: 'settings.openchamber.scrollBehavior.option.restore.label' },
    { id: 'jump-to-end', labelKey: 'settings.openchamber.scrollBehavior.option.jumpToEnd.label' },
];

export const SessionScrollBehaviorSettings: React.FC = () => {
    const { t } = useI18n();
    const sessionScrollRestoreMode = useUIStore((state) => state.sessionScrollRestoreMode);
    const setSessionScrollRestoreMode = useUIStore((state) => state.setSessionScrollRestoreMode);

    const handleSelect = React.useCallback(
        (mode: SessionScrollRestoreMode) => {
            setSessionScrollRestoreMode(mode);
        },
        [setSessionScrollRestoreMode]
    );

    return (
        <div className="mb-6">
            <div className="mb-0.5 px-1">
                <h3 className="typography-ui-header font-medium text-foreground">
                    {t('settings.openchamber.scrollBehavior.title')}
                </h3>
            </div>

            <section className="px-2 pb-2 pt-0">
                <p className="mt-0 mb-1 typography-meta text-muted-foreground">
                    {t('settings.openchamber.scrollBehavior.description')}
                </p>

                <div
                    data-settings-item="sessions.scroll-behavior"
                    role="radiogroup"
                    aria-label={t('settings.openchamber.scrollBehavior.sectionAria')}
                    className="mt-0.5 space-y-0"
                >
                    {RESTORE_OPTIONS.map((option) => {
                        const selected = sessionScrollRestoreMode === option.id;
                        return (
                            <div
                                key={option.id}
                                role="button"
                                tabIndex={0}
                                aria-pressed={selected}
                                onClick={() => handleSelect(option.id)}
                                onKeyDown={(event) => {
                                    if (event.key === ' ' || event.key === 'Enter') {
                                        event.preventDefault();
                                        handleSelect(option.id);
                                    }
                                }}
                                className="flex w-full items-center gap-2 py-0 text-left"
                            >
                                <Radio
                                    checked={selected}
                                    onChange={() => handleSelect(option.id)}
                                    ariaLabel={t('settings.openchamber.scrollBehavior.field.modeAria', {
                                        option: t(option.labelKey as Parameters<typeof t>[0]),
                                    })}
                                />
                                <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>
                                    {t(option.labelKey as Parameters<typeof t>[0])}
                                </span>
                            </div>
                        );
                    })}
                </div>
            </section>
        </div>
    );
};
