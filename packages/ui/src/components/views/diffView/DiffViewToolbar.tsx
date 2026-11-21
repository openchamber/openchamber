import React from 'react';
import { ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { useInContextPanelHeader } from '@/components/layout/contextPanelHeaderSlotContext';
import { DIFF_TOOLBAR_MENU_STEPS, useDiffToolbarFit } from '../useDiffToolbarFit';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from '@/components/icon/Icon';
import { ToolbarButton } from '@/components/ui/action-toolbar';
import type { DiffViewMode } from '@/components/chat/message/types';

const DIFF_TOOLBAR_VIEW_OPTIONS = ['tree', 'wrap', 'whitespace', 'layout'] as const;
type DiffToolbarMenuOption = 'walkthrough' | typeof DIFF_TOOLBAR_VIEW_OPTIONS[number];

interface DiffViewToolbarProps {
    children: React.ReactNode;
    hasFiles: boolean;
    isMobileLayout: boolean;
    diffFileListMode: 'flat' | 'tree';
    setDiffFileListMode: (mode: 'flat' | 'tree') => void;
    diffWrapLines: boolean;
    setDiffWrapLines: (wrap: boolean) => void;
    diffWrapLinesStore: boolean;
    diffHideWhitespace: boolean;
    setDiffHideWhitespace: (hide: boolean) => void;
    currentLayoutForAllFiles: 'inline' | 'side-by-side' | null;
    handleHeaderLayoutChange: (mode: DiffViewMode) => void;
    showWalkthroughButton: boolean;
    openWalkthrough: () => void;
}

export function DiffViewToolbar({
    children, hasFiles, isMobileLayout, diffFileListMode, setDiffFileListMode, diffWrapLines, setDiffWrapLines,
    diffWrapLinesStore, diffHideWhitespace, setDiffHideWhitespace, currentLayoutForAllFiles, handleHeaderLayoutChange,
    showWalkthroughButton, openWalkthrough,
}: DiffViewToolbarProps) {
    const { t } = useI18n();
    const inPanelHeader = useInContextPanelHeader();
    const toolbarRef = React.useRef<HTMLDivElement | null>(null);
    useDiffToolbarFit(toolbarRef);
    const [toolbarMenuOptions, setToolbarMenuOptions] = React.useState<ReadonlyArray<DiffToolbarMenuOption>>(DIFF_TOOLBAR_VIEW_OPTIONS);
    const handleToolbarMenuOpenChange = React.useCallback((open: boolean) => {
        if (!open) return;
        const walkthroughMoved = toolbarRef.current?.hasAttribute(DIFF_TOOLBAR_MENU_STEPS.walkthrough) ?? false;
        setToolbarMenuOptions(walkthroughMoved ? ['walkthrough', ...DIFF_TOOLBAR_VIEW_OPTIONS] : DIFF_TOOLBAR_VIEW_OPTIONS);
    }, []);
    const toolbarMenuItem = (option: DiffToolbarMenuOption) => {
        switch (option) {
            case 'walkthrough':
                if (!showWalkthroughButton) return null;
                return { label: t('walkthrough.action.open'), icon: <Icon name="route" className="size-4" />, on: false, select: openWalkthrough };
            case 'tree':
                if (isMobileLayout) return null;
                return {
                    label: t('diffView.fileTree.showAsTree'),
                    icon: <Icon name="node-tree" className="size-4" />,
                    on: diffFileListMode === 'tree',
                    select: () => setDiffFileListMode(diffFileListMode === 'tree' ? 'flat' : 'tree'),
                };
            case 'wrap':
                return { label: t('diffView.actions.wrapLines'), icon: <Icon name="text-wrap" className="size-4" />, on: diffWrapLines, select: () => setDiffWrapLines(!diffWrapLinesStore) };
            case 'whitespace':
                return {
                    label: t('diffView.actions.hideWhitespace'),
                    icon: <Icon name="space" className="size-4" />,
                    on: diffHideWhitespace,
                    select: () => setDiffHideWhitespace(!diffHideWhitespace),
                };
            case 'layout': {
                if (!currentLayoutForAllFiles) return null;
                const sideBySide = currentLayoutForAllFiles === 'side-by-side';
                return {
                    label: t('diffView.layout.sideBySide'),
                    icon: <Icon name="layout-column" className="size-4" />,
                    on: sideBySide,
                    select: () => handleHeaderLayoutChange(sideBySide ? 'unified' : 'side-by-side'),
                };
            }
        }
    };
    return (
        <ContextPanelHeaderToolbar>
            <div ref={toolbarRef} className={cn('flex min-w-0 items-center gap-2', inPanelHeader ? 'flex-1 py-1 pe-1' : 'px-3 py-2 bg-background')}>
                {children}
                {hasFiles && (
                    <DropdownMenu onOpenChange={handleToolbarMenuOpenChange}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <span className="diff-toolbar__more flex-shrink-0">
                                    <DropdownMenuTrigger asChild>
                                        <ToolbarButton label={t('diffView.actions.moreActions')} icon="more" />
                                    </DropdownMenuTrigger>
                                </span>
                            </TooltipTrigger>
                            <TooltipContent side="bottom" sideOffset={6}>{t('diffView.actions.moreActions')}</TooltipContent>
                        </Tooltip>
                        <DropdownMenuContent align="end" className="min-w-56">
                            {toolbarMenuOptions.map((option) => {
                                const item = toolbarMenuItem(option);
                                if (!item) return null;
                                return (
                                    <DropdownMenuItem key={option} className="flex items-center gap-2" onClick={item.select}>
                                        {item.icon}
                                        <span className="min-w-0 truncate typography-ui-label text-foreground">{item.label}</span>
                                        {item.on ? <Icon name="check" className="ms-auto size-4 text-foreground" /> : null}
                                    </DropdownMenuItem>
                                );
                            })}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>
        </ContextPanelHeaderToolbar>
    );
}
