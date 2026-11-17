
import type { SourceControlProvider } from '@/lib/api/types';
import React from 'react';

import { SessionGoalButton, SessionGoalObjectiveCounter } from '@/components/chat/SessionGoalButton';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import { Icon } from '@/components/icon/Icon';
import type { GuestAttachItem } from '@/hooks/useGuestSurfaces';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isDictationCaptureSupported } from '@/lib/dictation/use-dictation-audio-source';
import { ModelControls } from '../../ModelControls';
import { ComposerActionButtons } from './ComposerActionButtons';
import { ComposerAttachmentControls, type ComposerTrackerPicker } from './ComposerAttachmentControls';
import { PermissionAutoAcceptButton } from './PermissionAutoAcceptButton';
import type { PermissionMode } from '@/stores/utils/permissionAutoAccept';
import type { BtwSelection } from '@/stores/useBtwStore';

const MemoModelControls = React.memo(ModelControls);
const MemoComposerDictation = React.memo(ComposerDictation);

interface ComposerFooterProps {
    isMobile: boolean;
    isVSCode: boolean;
    sessionId: string | null;
    directory?: string;
    newSessionDraftOpen: boolean;
    messageLength: number;

    radius: string;
    footerPaddingClass: string;
    footerGapClass: string;
    footerIconButtonClass: string;
    iconSizeClass: string;
    sendIconSizeClass: string;
    stopIconSizeClass: string;

    canSend: boolean;
    canAbort: boolean;
    hasContent: boolean;
    permissionMode: PermissionMode;
    isPermissionAutoAcceptInteractive: boolean;
    dictationActive: boolean;

    onOpenSettings?: () => void;
    onPickLocalFiles: () => void;
    onOpenGitHubPicker: () => void;
    repositoryProvider?: SourceControlProvider | null;
    trackerPickers?: readonly ComposerTrackerPicker[];
    attachGuests?: readonly GuestAttachItem[];
    onOpenGuestAttach?: (guestId: string) => void;
    onOpenAttachSheet: () => void;
    onCyclePermissionMode: () => void;
    onPrimaryAction: () => void;
    onAbort: () => void;
    onStartDictation: () => void;
    onDictationInsert: (text: string) => void;
    onDictationInsertAndSend: (text: string) => void;
    onDictationSendStart: () => void;
    onDictationStart: () => void;
    onDictationContentHeightChange: (height: number | null) => void;
    onDictationActiveChange?: (active: boolean) => void;
    isBtw?: boolean;
    escapeStops?: boolean;
    modelSessionId?: string | null;
    btwSelection: BtwSelection;
    btwModelSelectorOpen?: boolean;
    onBtwModelSelectorOpenChange?: (open: boolean) => void;
    pinnedSelection?: BtwSelection | null;
    onRunInParallel?: () => void;
    parallelRun?: { runCount: number; launching: boolean; onLaunch: () => void } | null;
    waitingForOpenCode: boolean;
}

function OpenCodeStartupNote({ className }: { className?: string }) {
    const { t } = useI18n();
    return (
        <span
            role="status"
            className={cn('min-w-0 truncate self-center typography-micro text-muted-foreground', className)}
            title={t('chat.chatInput.waitingForOpenCodeHint')}
        >
            {t('chat.chatInput.waitingForOpenCode')}
        </span>
    );
}

function ComposerFooterView(props: ComposerFooterProps) {
    const { t } = useI18n();
    const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
    const {
        isMobile,
        isVSCode,
        sessionId: currentSessionId,
        directory,
        newSessionDraftOpen,
        messageLength,
        radius: chatInputRadius,
        footerPaddingClass,
        footerGapClass,
        footerIconButtonClass,
        iconSizeClass,
        sendIconSizeClass,
        stopIconSizeClass,
        canSend,
        canAbort,
        hasContent,
        permissionMode,
        isPermissionAutoAcceptInteractive,
        dictationActive,
        onOpenSettings,
        onPickLocalFiles,
        onOpenGitHubPicker,
        repositoryProvider,
        trackerPickers,
        attachGuests,
        onOpenGuestAttach,
        onOpenAttachSheet,
        onCyclePermissionMode,
        onPrimaryAction,
        onAbort,
        onStartDictation,
        onDictationInsert,
        onDictationInsertAndSend,
        onDictationSendStart,
        onDictationStart,
        onDictationContentHeightChange,
        onDictationActiveChange,
        isBtw = false,
        escapeStops = false,
        modelSessionId,
        btwSelection,
        btwModelSelectorOpen,
        onBtwModelSelectorOpenChange,
        pinnedSelection = null,
        onRunInParallel,
        parallelRun = null,
        waitingForOpenCode,
    } = props;

    const dictationEnabled = useConfigStore((state) => state.dictationEnabled);
    const [dictationSupported] = React.useState(() => !isVSCodeRuntime() && isDictationCaptureSupported());
    const showDictation = dictationEnabled && dictationSupported;

    return (
        <div
            className={cn(
                'bg-transparent flex-shrink-0',
                footerPaddingClass,
                !isMobile && !isVSCode && 'pe-2',
                isMobile && 'h-12 pe-3.5',
                isMobile ? 'flex items-center gap-x-1.5' : cn('flex items-center justify-between', footerGapClass)
            )}
            style={{
                borderBottomLeftRadius: chatInputRadius,
                borderBottomRightRadius: chatInputRadius,
            }}
            data-chat-input-footer="true"
            data-dictation-chain={isMobile ? undefined : 'true'}
        >
            {isMobile ? (
                <>
                    <div className="flex w-full items-center justify-between gap-x-1.5">
                        <div className="composer-mobile-actions flex items-center gap-x-2 ps-1">
                            <ComposerAttachmentControls
                                isVSCode={isVSCode}
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                                handlePickLocalFiles={onPickLocalFiles}
                                openGitHubPicker={onOpenGitHubPicker}
                                repositoryProvider={repositoryProvider}
                                trackerPickers={trackerPickers}
                                onOpenSettings={isBtw ? undefined : onOpenSettings}
                                onOpenMobileSheet={onOpenAttachSheet}
                                attachGuests={attachGuests}
                                onOpenGuestAttach={onOpenGuestAttach}
                                filesOnly={isBtw}
                            />
                            <PermissionAutoAcceptButton
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                                isInteractive={isPermissionAutoAcceptInteractive}
                                permissionMode={permissionMode}
                                handlePermissionModeCycle={onCyclePermissionMode}
                            />
                            {!isBtw ? <SessionGoalButton
                                sessionId={currentSessionId}
                                directory={directory}
                                draftOpen={newSessionDraftOpen}
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                            /> : null}
                            {!isBtw ? <SessionGoalObjectiveCounter length={messageLength} /> : null}
                        </div>
                        <div className="flex items-center min-w-0 gap-x-1 justify-end">
                            {waitingForOpenCode ? <OpenCodeStartupNote /> : null}
                            <div className="flex items-center gap-x-1 flex-shrink-0">
                                {!isBtw && showDictation ? <Tooltip><TooltipTrigger asChild><button
                                    type="button"
                                    className={footerIconButtonClass}
                                    onMouseDown={(event) => event.preventDefault()}
                                    onPointerDownCapture={(event) => {
                                        if (event.pointerType === 'touch') {
                                            event.preventDefault();
                                        }
                                    }}
                                    onClick={onStartDictation}
                                    disabled={dictationActive}
                                    aria-label={t('chat.dictation.start')}
                                >
                                    <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                                </button></TooltipTrigger><TooltipContent side="top"><TooltipLabelWithShortcut label={t('chat.dictation.start')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_dictation', shortcutOverrides), '')} /></TooltipContent></Tooltip> : null}
                                <ComposerActionButtons
                                    isMobile={isMobile}
                                    footerIconButtonClass={footerIconButtonClass}
                                    sendIconSizeClass={sendIconSizeClass}
                                    stopIconSizeClass={stopIconSizeClass}
                                    canSend={canSend}
                                    canAbort={canAbort}
                                    hasContent={hasContent}
                                    currentSessionId={currentSessionId}
                                    newSessionDraftOpen={newSessionDraftOpen}
                                    onPrimaryAction={onPrimaryAction}
                                    onAbort={onAbort}
                                    escapeStops={escapeStops}
                                />
                            </div>
                        </div>
                    </div>
                </>
            ) : (
                <>
                    <div className={cn("flex items-center flex-shrink-0", footerGapClass)}>
                        <ComposerAttachmentControls
                            isVSCode={isVSCode}
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            handlePickLocalFiles={onPickLocalFiles}
                            openGitHubPicker={onOpenGitHubPicker}
                            repositoryProvider={repositoryProvider}
                            trackerPickers={trackerPickers}
                            onOpenSettings={isBtw ? undefined : onOpenSettings}
                            attachGuests={attachGuests}
                            onOpenGuestAttach={onOpenGuestAttach}
                            filesOnly={isBtw}
                        />
                        <PermissionAutoAcceptButton
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            isInteractive={isPermissionAutoAcceptInteractive}
                            permissionMode={permissionMode}
                            handlePermissionModeCycle={onCyclePermissionMode}
                            withTooltip
                        />
                        {!isBtw ? <SessionGoalButton
                            sessionId={currentSessionId}
                            directory={directory}
                            draftOpen={newSessionDraftOpen}
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            withTooltip
                        /> : null}
                        {!isBtw ? <SessionGoalObjectiveCounter length={messageLength} /> : null}
                    </div>
                    <div className={cn('flex items-center flex-1 justify-end', isVSCode ? cn(footerGapClass, 'md:gap-x-3') : 'gap-x-2')} data-dictation-chain="true">
                        {waitingForOpenCode ? <OpenCodeStartupNote className="flex-shrink-0" /> : null}
                        {parallelRun ? <MemoModelControls className={cn('flex-1 min-w-0')} agentOnly /> : isBtw ? <ModelControls className={cn('flex-1 min-w-0 justify-end')} sessionId={modelSessionId ?? null} selection={btwSelection} rememberVariantPicks={false} modelSelectorOpen={btwModelSelectorOpen} onModelSelectorOpenChange={onBtwModelSelectorOpenChange} /> : pinnedSelection ? <ModelControls className={cn('flex-1 min-w-0 justify-end')} sessionId={currentSessionId} selection={pinnedSelection} rememberVariantPicks /> : <MemoModelControls className={cn('flex-1 min-w-0 justify-end')} onRunInParallel={onRunInParallel} />}
                        {!isBtw ? <MemoComposerDictation
                            radius={chatInputRadius}
                            isMobile={isMobile}
                            footerIconButtonClass={footerIconButtonClass}
                            footerPaddingClass={footerPaddingClass}
                            iconSizeClass={iconSizeClass}
                            sendIconSizeClass={sendIconSizeClass}
                            onInsert={onDictationInsert}
                            onInsertAndSend={onDictationInsertAndSend}
                            onSendStart={onDictationSendStart}
                            onStart={onDictationStart}
                            onContentHeightChange={onDictationContentHeightChange}
                            onActiveChange={onDictationActiveChange}
                        /> : null}
                        {parallelRun ? (
                            <ComposerActionButtons
                                isMobile={isMobile}
                                footerIconButtonClass={footerIconButtonClass}
                                sendIconSizeClass={sendIconSizeClass}
                                stopIconSizeClass={stopIconSizeClass}
                                canSend={canSend && parallelRun.runCount >= 2 && !parallelRun.launching}
                                canAbort={false}
                                hasContent={hasContent}
                                currentSessionId={currentSessionId}
                                newSessionDraftOpen={newSessionDraftOpen}
                                onPrimaryAction={parallelRun.onLaunch}
                                onAbort={onAbort}
                                sendLabel={t('chat.parallel.runAria', { count: parallelRun.runCount })}
                            />
                        ) : <ComposerActionButtons
                            isMobile={isMobile}
                            footerIconButtonClass={footerIconButtonClass}
                            sendIconSizeClass={sendIconSizeClass}
                            stopIconSizeClass={stopIconSizeClass}
                            canSend={canSend}
                            canAbort={canAbort}
                            hasContent={hasContent}
                            currentSessionId={currentSessionId}
                            newSessionDraftOpen={newSessionDraftOpen}
                            onPrimaryAction={onPrimaryAction}
                            onAbort={onAbort}
                            escapeStops={escapeStops}
                        />}
                    </div>
                </>
            )}
        </div>
    );
}

export const ComposerFooter = React.memo(ComposerFooterView);
