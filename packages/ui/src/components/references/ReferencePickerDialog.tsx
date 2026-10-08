/**
 * The picker for GitHub issues and pull requests, and Linear issues.
 *
 * Desktop shows the list and a preview of the highlighted item side by side,
 * so the user sees what they are about to attach. Mobile shows the list, and
 * a tap on a row opens its preview in place.
 *
 * `selection: 'multiple'` (the composer) checks any number of items, across
 * tabs, and attaches them together. `selection: 'single'` (New Worktree)
 * chooses one. Lists come from the shared reference cache, so switching tabs
 * or reopening the picker shows the last answer at once.
 */

import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import type { GitHubReferenceKind } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';

import { ReferenceBrowserList, ReferenceBrowserSearch, ReferenceBrowserTabs } from './ReferenceBrowser';
import { IDLE_PULL_STATUS, useReferenceBrowser } from './useReferenceBrowser';
import { ReferencePreview, type ReferencePreviewPurpose } from './ReferencePreview';
import {
    referencePickerItemKey,
    type ReferencePickerItem,
    type ReferencePickerSelection,
    type ReferencePickerSource,
} from './referencePickerItems';

/** A failed confirm: the keys that did not go through stay checked. */
export type ReferencePickerConfirmFailure = { failedKeys: string[]; message: string };

type ReferencePickerDialogProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    source: ReferencePickerSource;
    purpose: ReferencePreviewPurpose;
    selection: 'multiple' | 'single';
    /** The project GitHub items come from. */
    directory: string | null;
    /** Tab to open GitHub on; the last used one otherwise. */
    initialGitHubKind?: GitHubReferenceKind;
    /** Null closes the picker; a failure keeps it open with the message. */
    onConfirm: (selections: ReferencePickerSelection[]) => Promise<ReferencePickerConfirmFailure | null>;
};

export function ReferencePickerDialog(props: ReferencePickerDialogProps) {
    const isMobile = useUIStore((state) => state.isMobile);
    if (!props.open) return null;
    // Remounted per open, so every open starts from the remembered tab and an
    // empty search without effects resetting state after the first paint.
    return <ReferencePickerSurface {...props} isMobile={isMobile} />;
}

function ReferencePickerSurface({
    onOpenChange,
    source,
    purpose,
    selection,
    directory,
    initialGitHubKind,
    onConfirm,
    isMobile,
}: ReferencePickerDialogProps & { isMobile: boolean }) {
    const { t } = useI18n();
    const [checked, setChecked] = React.useState<ReadonlyMap<string, ReferencePickerItem>>(new Map());
    const [diffIncluded, setDiffIncluded] = React.useState<ReadonlySet<string>>(new Set());
    const [confirming, setConfirming] = React.useState(false);
    const [confirmError, setConfirmError] = React.useState<string | null>(null);

    const browser = useReferenceBrowser({ source, directory, isMobile, initialGitHubKind, retainedItems: checked });
    const { highlightedItem, previewItem, previewKey, isGitLab } = browser;

    const toggleChecked = React.useCallback((item: ReferencePickerItem) => {
        const key = referencePickerItemKey(item);
        setChecked((current) => {
            const next = new Map(current);
            if (next.has(key)) next.delete(key);
            else next.set(key, item);
            return next;
        });
        setConfirmError(null);
    }, []);

    const setIncludeDiff = React.useCallback((key: string, include: boolean) => {
        setDiffIncluded((current) => {
            const next = new Set(current);
            if (include) next.add(key);
            else next.delete(key);
            return next;
        });
    }, []);

    const toSelection = React.useCallback((item: ReferencePickerItem): ReferencePickerSelection => (
        item.source === 'linear'
            ? item
            : { source: 'github', reference: item.reference, includeDiff: diffIncluded.has(referencePickerItemKey(item)) }
    ), [diffIncluded]);

    /** Confirm the checked items plus `extra`, or just `extra` in single mode. */
    const confirm = React.useCallback(async (extra: ReferencePickerItem | null) => {
        if (confirming) return;
        const chosen = new Map(selection === 'multiple' ? checked : []);
        if (extra) chosen.set(referencePickerItemKey(extra), extra);
        if (chosen.size === 0) return;
        setConfirming(true);
        setConfirmError(null);
        try {
            const failure = await onConfirm([...chosen.values()].map(toSelection));
            if (!failure) {
                onOpenChange(false);
                return;
            }
            setConfirmError(failure.message);
            setChecked(new Map([...chosen].filter(([key]) => failure.failedKeys.includes(key))));
        } finally {
            setConfirming(false);
        }
    }, [checked, confirming, onConfirm, onOpenChange, selection, toSelection]);

    const handleSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (browser.handleNavigationKey(event)) return;
        if (event.key !== 'Enter' || !highlightedItem) return;
        event.preventDefault();
        if (selection === 'multiple' && event.shiftKey) {
            toggleChecked(highlightedItem);
            return;
        }
        void confirm(selection === 'multiple' && checked.size > 0 ? null : highlightedItem);
    };

    const title = t(source === 'github'
        ? (isGitLab
            ? (purpose === 'worktree' ? 'references.picker.title.gitlab.worktree' : 'references.picker.title.gitlab.attach')
            : (purpose === 'worktree' ? 'references.picker.title.github.worktree' : 'references.picker.title.github.attach'))
        : (purpose === 'worktree' ? 'references.picker.title.linear.worktree' : 'references.picker.title.linear.attach'));

    const openSettings = () => {
        const ui = useUIStore.getState();
        ui.setSettingsPage('integrations');
        ui.setSettingsDialogOpen(true);
        onOpenChange(false);
    };

    const tabs = <ReferenceBrowserTabs browser={browser} />;
    const searchAndFilters = <ReferenceBrowserSearch browser={browser} onKeyDown={handleSearchKeyDown} />;
    const listBody = (
        <ReferenceBrowserList
            browser={browser}
            label={title}
            multiselectable={selection === 'multiple'}
            onOpenSettings={openSettings}
            rowSelection={(item, key) => ({
                checked: selection === 'multiple' ? checked.has(key) : null,
                diffIncluded: diffIncluded.has(key),
                onToggle: () => toggleChecked(item),
            })}
            onActivate={(item) => void confirm(item)}
        />
    );

    const preview = (
        <ReferencePreview
            item={previewItem}
            pullStatus={previewItem?.source === 'github' ? browser.pullStatusOf(previewItem.reference) : IDLE_PULL_STATUS}
            linearDetail={browser.linearDetail}
            githubDetail={browser.githubDetail}
            purpose={purpose}
            pinned={!isMobile}
            includeDiff={previewKey ? diffIncluded.has(previewKey) : false}
            onIncludeDiffChange={(include) => {
                if (previewKey) setIncludeDiff(previewKey, include);
            }}
            now={browser.now}
            onOpenLinearIssue={(issue) => browser.openItem({ source: 'linear', issue })}
        />
    );

    const checkedCount = checked.size;
    const confirmLabel = selection === 'single'
        ? t('references.picker.actions.choose')
        : checkedCount > 1
            ? t('references.picker.actions.attachCount', { count: checkedCount })
            : t('references.picker.actions.attach');

    // In multiple mode the button attaches what is checked, or the
    // highlighted item when nothing is; single mode always takes the highlight.
    const confirmTarget = isMobile ? previewItem : highlightedItem;
    const canConfirm = !confirming && (selection === 'multiple' ? checkedCount > 0 || Boolean(confirmTarget) : Boolean(confirmTarget));
    const runConfirm = () => void confirm(selection === 'multiple' && checkedCount > 0 && !(isMobile && previewItem) ? null : confirmTarget);

    const footerStatus = confirmError ? (
        <span className="min-w-0 break-words typography-meta text-[var(--status-error-text)]">{confirmError}</span>
    ) : (
        <span className="min-w-0 truncate typography-meta text-muted-foreground">
            {selection === 'multiple' && checkedCount > 0
                ? t('references.picker.footer.selected', { count: checkedCount })
                : isMobile ? null : t(selection === 'multiple' ? 'references.picker.footer.hint.multiple' : 'references.picker.footer.hint.single')}
        </span>
    );

    const confirmButton = (
        <Button size="sm" onClick={runConfirm} disabled={!canConfirm} className={cn(isMobile && 'flex-1')}>
            {confirming ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {confirmLabel}
        </Button>
    );

    if (isMobile) {
        const inPreview = Boolean(browser.mobilePreviewKey && previewItem);
        return (
            <MobileOverlayPanel
                open
                title={title}
                onClose={() => onOpenChange(false)}
                contentMaxHeightClassName="max-h-[calc(100dvh-12rem)]"
                renderHeader={(closeButton) => (
                    <div className="flex flex-col gap-2 border-b border-border/40 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                            {inPreview ? (
                                <Button variant="ghost" size="sm" onClick={browser.closeMobilePreview} className="-ml-1">
                                    <Icon name="arrow-left-s" className="size-4" />
                                    {t('references.picker.actions.back')}
                                </Button>
                            ) : (
                                <h2 className="typography-ui-label font-semibold text-foreground">{title}</h2>
                            )}
                            {closeButton}
                        </div>
                        {inPreview ? null : (
                            <>
                                {tabs}
                                {searchAndFilters}
                            </>
                        )}
                    </div>
                )}
                footer={(
                    <div className="flex flex-col gap-2">
                        {confirmError || checkedCount > 0 ? footerStatus : null}
                        <div className="flex items-center gap-2">
                            {inPreview && selection === 'multiple' && previewItem ? (
                                <Button variant="outline" size="sm" className="flex-1" onClick={() => toggleChecked(previewItem)}>
                                    {checked.has(referencePickerItemKey(previewItem))
                                        ? t('references.picker.actions.unselect')
                                        : t('references.picker.actions.select')}
                                </Button>
                            ) : null}
                            {confirmButton}
                        </div>
                    </div>
                )}
            >
                {inPreview ? <div className="px-2 py-1">{preview}</div> : listBody}
            </MobileOverlayPanel>
        );
    }

    return (
        <Dialog open onOpenChange={onOpenChange}>
            <DialogContent className="h-[min(90vh,58rem)] w-[min(72rem,calc(100vw-1.5rem))] max-w-6xl gap-0 overflow-hidden p-0">
                <div className="flex shrink-0 flex-col gap-3 border-b border-border/60 px-5 pb-3 pt-4">
                    <div className="flex flex-wrap items-center gap-3 pr-8">
                        <DialogTitle className="flex shrink-0 items-center gap-2 typography-ui-header">
                            <Icon name={source === 'linear' ? 'linear' : isGitLab ? 'gitlab' : 'github'} className="size-5" />
                            {title}
                        </DialogTitle>
                        <DialogDescription className="sr-only">
                            {t(selection === 'multiple' ? 'references.picker.footer.hint.multiple' : 'references.picker.footer.hint.single')}
                        </DialogDescription>
                        {tabs}
                        {searchAndFilters}
                    </div>
                </div>
                <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
                    <ScrollableOverlay outerClassName="min-h-0 border-r border-border/60" disableHorizontal>
                        {listBody}
                    </ScrollableOverlay>
                    <div className="min-h-0">{preview}</div>
                </div>
                <div className="flex shrink-0 items-center gap-3 border-t border-border/60 px-5 py-3">
                    <div className="min-w-0 flex-1">{footerStatus}</div>
                    <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                        {t('references.picker.actions.cancel')}
                    </Button>
                    {confirmButton}
                </div>
            </DialogContent>
        </Dialog>
    );
}
