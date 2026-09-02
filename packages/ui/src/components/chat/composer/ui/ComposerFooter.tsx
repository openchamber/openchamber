/**
 * The composer's footer row.
 *
 * Desktop lays it out as attachments and toggles on the left, model controls
 * and send on the right. Mobile keeps everything on one line and swaps the
 * model controls for the compact buttons above the text, because the footer
 * has to stay reachable with one thumb.
 *
 * The dictation component is rendered here on desktop only: on mobile it lives
 * at the composer wrapper level so a recording started from the collapsed pill
 * survives the expand.
 */

import React from 'react';

import { SessionGoalButton, SessionGoalObjectiveCounter } from '@/components/chat/SessionGoalButton';
import { ComposerDictation } from '@/components/dictation/ComposerDictation';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ModelControls } from '../../ModelControls';
import { ComposerActionButtons } from './ComposerActionButtons';
import { ComposerAttachmentControls } from './ComposerAttachmentControls';
import { FocusModeButton } from './FocusModeButton';
import { PermissionAutoAcceptButton } from './PermissionAutoAcceptButton';

const MemoModelControls = React.memo(ModelControls);
const MemoComposerDictation = React.memo(ComposerDictation);

export interface ComposerFooterProps {
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
    isExpandedInput: boolean;
    permissionAutoAcceptEnabled: boolean;
    isPermissionAutoAcceptInteractive: boolean;
    dictationActive: boolean;

    onOpenSettings?: () => void;
    onPickLocalFiles: () => void;
    onOpenIssuePicker: () => void;
    onOpenPrPicker: () => void;
    showLinearPicker?: boolean;
    onOpenLinearPicker?: () => void;
    onOpenAttachSheet: () => void;
    onToggleExpandedInput: () => void;
    onTogglePermissionAutoAccept: () => void;
    onPrimaryAction: () => void;
    onQueueMessage: () => void;
    onAbort: () => void;
    onStartDictation: () => void;
    onDictationInsert: (text: string) => void;
    onDictationInsertAndSend: (text: string) => void;
    onDictationContentHeightChange: (height: number | null) => void;
}

export function ComposerFooter(props: ComposerFooterProps) {
    const { t } = useI18n();
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
        isExpandedInput,
        permissionAutoAcceptEnabled,
        isPermissionAutoAcceptInteractive,
        dictationActive,
        onOpenSettings,
        onPickLocalFiles,
        onOpenIssuePicker,
        onOpenPrPicker,
        showLinearPicker,
        onOpenLinearPicker,
        onOpenAttachSheet,
        onToggleExpandedInput,
        onTogglePermissionAutoAccept,
        onPrimaryAction,
        onQueueMessage,
        onAbort,
        onStartDictation,
        onDictationInsert,
        onDictationInsertAndSend,
        onDictationContentHeightChange,
    } = props;

    return (
        <div
            className={cn(
                'bg-transparent flex-shrink-0',
                footerPaddingClass,
                isMobile ? 'flex items-center gap-x-1.5' : cn('flex items-center justify-between', footerGapClass)
            )}
            style={{
                borderBottomLeftRadius: chatInputRadius,
                borderBottomRightRadius: chatInputRadius,
            }}
            data-chat-input-footer="true"
        >
            {isMobile ? (
                <>
                    <div className="flex w-full items-center justify-between gap-x-1.5">
                        <div className="composer-mobile-actions flex items-center gap-x-2 pl-1">
                            <ComposerAttachmentControls
                                isVSCode={isVSCode}
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                                handlePickLocalFiles={onPickLocalFiles}
                                openIssuePicker={onOpenIssuePicker}
                                openPrPicker={onOpenPrPicker}
                                showLinearPicker={showLinearPicker}
                                openLinearPicker={onOpenLinearPicker}
                                onOpenSettings={onOpenSettings}
                                onOpenMobileSheet={onOpenAttachSheet}
                            />
                            <PermissionAutoAcceptButton
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                                isInteractive={isPermissionAutoAcceptInteractive}
                                permissionAutoAcceptEnabled={permissionAutoAcceptEnabled}
                                handlePermissionAutoAcceptToggle={onTogglePermissionAutoAccept}
                            />
                            <SessionGoalButton
                                sessionId={currentSessionId}
                                directory={directory}
                                draftOpen={newSessionDraftOpen}
                                footerIconButtonClass={footerIconButtonClass}
                                iconSizeClass={iconSizeClass}
                            />
                            <SessionGoalObjectiveCounter length={messageLength} />
                        </div>
                        <div className="flex items-center min-w-0 gap-x-1 justify-end">
                            <div className="flex items-center gap-x-1 flex-shrink-0">
                                <button
                                    type="button"
                                    className={footerIconButtonClass}
                                    // Keep the soft keyboard open (same guard as
                                    // PermissionAutoAcceptButton); the recording
                                    // engine lives in the wrapper-level
                                    // ComposerDictation instance.
                                    onMouseDown={(event) => event.preventDefault()}
                                    onPointerDownCapture={(event) => {
                                        if (event.pointerType === 'touch') {
                                            event.preventDefault();
                                        }
                                    }}
                                    onClick={onStartDictation}
                                    disabled={dictationActive}
                                    title={t('chat.dictation.start')}
                                    aria-label={t('chat.dictation.start')}
                                >
                                    <Icon name="mic" className={cn(iconSizeClass, 'text-current')} />
                                </button>
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
                                    onQueueMessage={onQueueMessage}
                                    onAbort={onAbort}
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
                            openIssuePicker={onOpenIssuePicker}
                            openPrPicker={onOpenPrPicker}
                            showLinearPicker={showLinearPicker}
                            openLinearPicker={onOpenLinearPicker}
                            onOpenSettings={onOpenSettings}
                        />
                        <FocusModeButton
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            isExpandedInput={isExpandedInput}
                            onToggle={onToggleExpandedInput}
                        />
                        <PermissionAutoAcceptButton
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            isInteractive={isPermissionAutoAcceptInteractive}
                            permissionAutoAcceptEnabled={permissionAutoAcceptEnabled}
                            handlePermissionAutoAcceptToggle={onTogglePermissionAutoAccept}
                            withTooltip
                        />
                        <SessionGoalButton
                            sessionId={currentSessionId}
                            directory={directory}
                            draftOpen={newSessionDraftOpen}
                            footerIconButtonClass={footerIconButtonClass}
                            iconSizeClass={iconSizeClass}
                            withTooltip
                        />
                        <SessionGoalObjectiveCounter length={messageLength} />
                    </div>
                    <div className={cn('flex items-center flex-1 justify-end', footerGapClass, 'md:gap-x-3')}>
                        <MemoModelControls className={cn('flex-1 min-w-0 justify-end')} />
                        <MemoComposerDictation
                            radius={chatInputRadius}
                            isMobile={isMobile}
                            footerIconButtonClass={footerIconButtonClass}
                            footerPaddingClass={footerPaddingClass}
                            iconSizeClass={iconSizeClass}
                            sendIconSizeClass={sendIconSizeClass}
                            onInsert={onDictationInsert}
                            onInsertAndSend={onDictationInsertAndSend}
                            onContentHeightChange={onDictationContentHeightChange}
                        />
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
                            onQueueMessage={onQueueMessage}
                            onAbort={onAbort}
                        />
                    </div>
                </>
            )}
        </div>
    );
}
