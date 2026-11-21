import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { MobileSheetRow } from '@/components/ui/MobileSheetList';
import { useI18n } from '@/lib/i18n';

type TerminalSheetTab = {
    id: string;
    label: string;
    icon: React.ReactNode;
    renamable: boolean;
};

type TerminalTabsSheetProps = {
    tabs: TerminalSheetTab[];
    activeId: string | null;
    onSelect: (tabId: string) => void;
    onClose: (tabId: string) => void;
    onRename: (tabId: string) => void;
    onCreate: () => void;
};

const ROW_ACTION_CLASS = 'h-9 w-9 p-0 text-muted-foreground';

export const TerminalTabsSheet: React.FC<TerminalTabsSheetProps> = ({ tabs, activeId, onSelect, onClose, onRename, onCreate }) => {
    const { t } = useI18n();
    const [open, setOpen] = React.useState(false);
    const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];
    const dismiss = React.useCallback(() => setOpen(false), []);

    return (
        <>
            <button
                type="button"
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(true)}
                className="flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-md px-2 text-foreground touch-manipulation active:bg-interactive-hover"
            >
                {activeTab ? <span className="flex shrink-0 items-center">{activeTab.icon}</span> : null}
                <span dir="auto" className="min-w-0 truncate typography-ui-label">{activeTab?.label ?? t('terminalView.tabs.sheetTitle')}</span>
                {tabs.length > 1 ? (
                    <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md bg-interactive-hover px-1 typography-micro font-medium text-foreground tabular-nums">
                        {tabs.length}
                    </span>
                ) : null}
                <Icon name="arrow-down-s" className="size-4 shrink-0 text-muted-foreground" />
            </button>
            <MobileOverlayPanel
                open={open && tabs.length > 0}
                title={t('terminalView.tabs.sheetTitle')}
                onClose={dismiss}
                footer={(
                    <MobileSheetRow
                        icon="add"
                        onClick={() => {
                            dismiss();
                            onCreate();
                        }}
                    >
                        {t('contextTooltips.terminalBrowser.terminal.newTab')}
                    </MobileSheetRow>
                )}
            >
                {tabs.map((tab) => (
                    <MobileSheetRow
                        key={tab.id}
                        selected={tab.id === activeTab?.id}
                        leading={<span className="flex shrink-0 items-center">{tab.icon}</span>}
                        onClick={() => {
                            dismiss();
                            onSelect(tab.id);
                        }}
                        action={(
                            <>
                                {tab.renamable ? (
                                    <Button
                                        type="button"
                                        variant="ghost"
                                        size="icon"
                                        className={ROW_ACTION_CLASS}
                                        aria-label={t('terminalView.tabs.menu.rename')}
                                        onClick={() => {
                                            dismiss();
                                            onRename(tab.id);
                                        }}
                                    >
                                        <Icon name="edit" className="size-4" />
                                    </Button>
                                ) : null}
                                <Button
                                    type="button"
                                    variant="ghost"
                                    size="icon"
                                    className={ROW_ACTION_CLASS}
                                    aria-label={t('terminalView.tabs.closeTabTitle')}
                                    onClick={() => onClose(tab.id)}
                                >
                                    <Icon name="close" className="size-4" />
                                </Button>
                            </>
                        )}
                    >
                        <span dir="auto">{tab.label}</span>
                    </MobileSheetRow>
                ))}
            </MobileOverlayPanel>
        </>
    );
};
