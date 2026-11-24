import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ButtonTooltip } from '@/components/ui/action-toolbar';
import { Button } from '@/components/ui/button';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import { useDeviceInfo, useTabletLayout } from '@/lib/device';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { TerminalTabsSheet } from './TerminalTabsSheet';

type StripProps = React.ComponentProps<typeof SortableTabsStrip>;

type TerminalTabsBarProps = {
    tabs: Array<SortableTabsStripItem & { icon: React.ReactNode; renamable: boolean }>;
    activeId: string | null;
    inPanelHeader: boolean;
    onSelect: (tabId: string) => void;
    onClose: (tabId: string) => void;
    onReorder: (tabId: string, overTabId: string) => void;
    onRename: (tabId: string) => void;
    onCreate: () => void;
    tabContextMenu: StripProps['tabContextMenu'];
    onTabDragOut: StripProps['onTabDragOut'];
};

const PHONE_PORTRAIT_MAX_WIDTH = 640;

export const TerminalTabsBar: React.FC<TerminalTabsBarProps> = ({
    tabs,
    activeId,
    inPanelHeader,
    onSelect,
    onClose,
    onReorder,
    onRename,
    onCreate,
    tabContextMenu,
    onTabDragOut,
}) => {
    const { t } = useI18n();
    const { isMobile, isTablet, screenWidth } = useDeviceInfo();
    const tabletLayout = useTabletLayout().enabled;
    const isTouch = isMobile || isTablet;

    if (isMobile && !tabletLayout && screenWidth < PHONE_PORTRAIT_MAX_WIDTH) {
        return (
            <div className="flex min-w-0 flex-1 items-center">
                <TerminalTabsSheet
                    tabs={tabs}
                    activeId={activeId}
                    onSelect={onSelect}
                    onClose={onClose}
                    onRename={onRename}
                    onCreate={onCreate}
                />
            </div>
        );
    }

    return (
        <>
            <div className={cn('min-w-0 flex-1', inPanelHeader ? 'self-stretch' : isTouch ? 'h-8' : 'h-7')}>
                <SortableTabsStrip
                    items={tabs}
                    activeId={activeId}
                    onSelect={onSelect}
                    onClose={onClose}
                    onReorder={onReorder}
                    tabContextMenu={tabContextMenu}
                    onTabDragOut={onTabDragOut}
                    layoutMode="scrollable"
                    variant="default"
                    className="h-full bg-transparent"
                />
            </div>

            <ButtonTooltip label={t('contextTooltips.terminalBrowser.terminal.newTab')} side="bottom" className="shrink-0">
                <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className={cn('shrink-0', isTouch ? 'h-8 w-8 p-0' : 'h-7 w-7 p-0')}
                    onClick={onCreate}
                    aria-label={t('contextTooltips.terminalBrowser.terminal.newTab')}
                >
                    <Icon name="add" className={isTouch ? 'h-[18px] w-[18px]' : 'h-4 w-4'} />
                </Button>
            </ButtonTooltip>
        </>
    );
};
