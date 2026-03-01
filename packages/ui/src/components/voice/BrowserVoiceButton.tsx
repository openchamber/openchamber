/**
 * BrowserVoiceButton Component
 *
 * Voice toggle button for browser-based voice chat with language selection.
 * Shows visual state indicators for different voice modes.
 *
 * @example
 * ```tsx
 * <BrowserVoiceButton />
 * ```
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useBrowserVoice } from '@/hooks/useBrowserVoice';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { browserVoiceService } from '@/lib/voice/browserVoiceService';
import { isVSCodeRuntime, runHapticFeedback } from '@/lib/desktop';
import { Button } from '@/components/ui/button';
import {
    Tooltip,
    TooltipContent,
    TooltipProvider,
    TooltipTrigger,
} from '@/components/ui/tooltip';
import {
    RiMicOffLine,
    RiStopCircleLine,
    RiVoiceRecognitionLine,
    RiVolumeUpLine,
} from '@remixicon/react';
import { VoiceStatusIndicator } from './VoiceStatusIndicator';
import { toast } from '@/components/ui/toast';

// Status text for accessibility and labels
const statusLabels: Record<string, string> = {
    idle: 'Start Voice',
    listening: 'Listening',
    processing: 'Processing',
    speaking: 'AI Speaking',
    error: 'Voice Error',
};

// iOS Safari detection utility
const isIOSSafari = (): boolean => {
    if (typeof navigator === 'undefined') return false;
    const userAgent = navigator.userAgent.toLowerCase();
    const isIOS = /iphone|ipad|ipod/i.test(userAgent);
    const isSafari = /safari/i.test(userAgent) && !/chrome|crios|crmo/i.test(userAgent);
    return isIOS && isSafari;
};

const normalizeVoiceErrorMessage = (error: string): string => {
    const isMediaDevicesError =
        error.includes('getUserMedia') ||
        error.includes('mediaDevices') ||
        error.includes('Cannot read properties of undefined');

    if (!isMediaDevicesError) {
        return error;
    }

    if (typeof window !== 'undefined' && !window.isSecureContext) {
        return 'Voice requires a secure connection (HTTPS) or localhost. Please use HTTPS or access via localhost.';
    }

    return 'Microphone access is unavailable in this runtime. On desktop, check System Settings -> Privacy & Security -> Microphone for OpenChamber.';
};

/**
 * Browser Voice Button with language selection
 */
export function BrowserVoiceButton() {
    const voiceModeEnabled = useConfigStore((s) => s.voiceModeEnabled);
    const mobileHapticsEnabled = useUIStore((s) => s.mobileHapticsEnabled);
    
    const {
        status,
        isSupported,
        error,

        startVoice,
        stopVoice,
        conversationMode,
        toggleConversationMode,
        isMobile,
    } = useBrowserVoice();
    
    const [isPressing, setIsPressing] = useState(false);
    const isVSCode = isVSCodeRuntime();
    const buttonSizeClass = isMobile ? 'h-8 w-8 min-h-[32px] min-w-[32px]' : (isVSCode ? 'h-5 w-5' : 'h-6 w-6');
    const iconSizeClass = isMobile ? 'h-[18px] w-[18px]' : (isVSCode ? 'h-4 w-4' : 'h-[18px] w-[18px]');
    const continuousIconSizeClass = 'size-[18px]';
    const clearHoverBackgroundClass = 'bg-transparent hover:!bg-transparent active:!bg-transparent focus-visible:!bg-transparent';
    
    // Refs for touch handling
    const touchHandledRef = useRef(false);
    const isIOSSafariRef = useRef(false);
    const longPressTimerRef = useRef<NodeJS.Timeout | null>(null);
    const longPressTriggeredRef = useRef(false);
    const lastToastedErrorRef = useRef<string | null>(null);
    
    // Initialize iOS detection on mount
    useEffect(() => {
        isIOSSafariRef.current = isIOSSafari();
    }, []);

    // NOTE: Do NOT pre-request microphone permission on mount.
    // Permission is requested when the user explicitly taps the mic button.
    // Pre-requesting causes an unwanted permission prompt on mobile page load.

    // Determine active states
    const isActive = status === 'listening' || status === 'speaking' || status === 'processing';
    const isError = status === 'error';
    const isIdle = status === 'idle';

    const isSpeaking = status === 'speaking';

    // Show toast notification when voice error occurs
    useEffect(() => {
        if (isError && error) {
            if (lastToastedErrorRef.current === error) {
                return;
            }
            lastToastedErrorRef.current = error;
            const displayError = normalizeVoiceErrorMessage(error);
            
            toast.error(displayError, {
                duration: 5000,
            });
        }

        if (!isError) {
            lastToastedErrorRef.current = null;
        }
    }, [isError, error]);

    // Status text for accessibility
    const statusText = isError
        ? error || 'Voice Error'
        : conversationMode && status === 'idle'
          ? 'Start Voice (Continuous mode on)'
          : statusLabels[status] || 'Start Voice';

    // Tooltip content based on state
    const getTooltipContent = () => {
        if (isError && error) {
            return normalizeVoiceErrorMessage(error);
        }
        if (isActive) {
            return 'Stop voice conversation';
        }
        if (isMobile) {
            return 'Start voice conversation';
        }
        return `Start voice conversation (Shift+Click for continuous mode) • Cmd/Ctrl+Shift+V to toggle`;
    };

    // Handle voice activation (used by both click and touch)
    const activateVoice = useCallback(async () => {
        if (isActive) {
            stopVoice();
        } else if (status !== 'error') {
            // On mobile, we must NOT do any async operations before calling startVoice()
            // because iOS Safari requires SpeechRecognition.start() to be called
            // synchronously within the user gesture handler
            if (isMobile) {
                // Start voice immediately - no await before this!
                // Audio unlock is now handled inside startVoice() for mobile
                startVoice();
            } else {
                // Desktop can use async path
                try {
                    await startVoice();
                } catch (err) {
                    console.error('Failed to start voice:', err);
                }
            }
        } else {
            // Reset from error state
            if (isMobile) {
                startVoice();
            } else {
                try {
                    await startVoice();
                } catch (err) {
                    console.error('Failed to start voice:', err);
                }
            }
        }
    }, [isActive, status, startVoice, stopVoice, isMobile]);

    // Handle Shift+Click to toggle conversation mode
    const handleClick = useCallback(async (e: React.MouseEvent) => {
        // Prevent double-firing if touch already handled this
        if (touchHandledRef.current) {
            touchHandledRef.current = false;
            return;
        }

        // Shift+Click toggles conversation mode
        if (e.shiftKey) {
            toggleConversationMode();
            return;
        }

        await activateVoice();
    }, [activateVoice, toggleConversationMode]);

    // Handle touch start for mobile devices
    const handleTouchStart = useCallback((e: React.TouchEvent) => {
        // Prevent default to stop mouse event emulation
        e.preventDefault();

        // Mark that touch handled this interaction
        touchHandledRef.current = true;
        longPressTriggeredRef.current = false;

        // Immediate visual feedback
        setIsPressing(true);

        // Set up long-press timer for toggling conversation mode (500ms)
        longPressTimerRef.current = setTimeout(() => {
            longPressTriggeredRef.current = true;
            toggleConversationMode();
            void runHapticFeedback('impact-medium', mobileHapticsEnabled);
            setIsPressing(false);
        }, 500);
    }, [mobileHapticsEnabled, toggleConversationMode]);

    // Handle touch end
    const handleTouchEnd = useCallback(() => {
        // Clear long-press timer
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }

        // Only activate voice if long-press wasn't triggered
        if (!longPressTriggeredRef.current) {
            activateVoice();
        }

        setIsPressing(false);
    }, [activateVoice]);

    // Handle touch cancel
    const handleTouchCancel = useCallback(() => {
        if (longPressTimerRef.current) {
            clearTimeout(longPressTimerRef.current);
            longPressTimerRef.current = null;
        }
        setIsPressing(false);
    }, []);

    const handleToggleConversationMode = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        toggleConversationMode();
    }, [toggleConversationMode]);



    // If voice mode is disabled, don't render anything
    if (!voiceModeEnabled) {
        return null;
    }

    // If not supported, show disabled button with tooltip
    if (!isSupported) {
        const supportDetails = browserVoiceService.getSupportDetails();
        const tooltipMessage = !supportDetails.secureContext
            ? 'Voice requires HTTPS or localhost. Please use a secure connection.'
            : !supportDetails.recognition
                ? 'Speech recognition not supported in this browser. Try Chrome, Edge, or Safari.'
                : !supportDetails.synthesis
                    ? 'Speech synthesis not supported in this browser.'
                    : 'Voice not supported in this browser';

        return (
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            size="icon"
                            variant="ghost"
                            disabled
                            aria-label={tooltipMessage}
                            className={`${buttonSizeClass} p-0 ${clearHoverBackgroundClass}`}
                        >
                            <RiMicOffLine className={`${iconSizeClass} opacity-50`} />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="center">
                        <p className="max-w-[200px] text-center">{tooltipMessage}</p>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>
        );
    }

    return (
        <div className={`flex items-center ${isMobile ? 'gap-1' : 'gap-1.5'}`}>
            {/* Status indicator with label - show when active, simplified on mobile */}
            {isActive && !isMobile && (
                <VoiceStatusIndicator
                    status={status}
                    showLabel
                    size="sm"
                    className="mr-1"
                />
            )}

            {/* Voice button with tooltip */}
            <TooltipProvider>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            size="icon"
                            variant="ghost"
                            onClick={handleClick}
                            onTouchStart={handleTouchStart}
                            onTouchEnd={handleTouchEnd}
                            onTouchCancel={handleTouchCancel}
                            aria-label={statusText}
                            className={`
                                relative
                                ${buttonSizeClass}
                                p-0
                                ${clearHoverBackgroundClass}
                                touch-manipulation
                                ${isPressing ? 'scale-95 opacity-80' : ''}
                                ${conversationMode && isIdle && isMobile ? 'ring-1 ring-primary/50' : ''}
                            `}
                            style={{
                                WebkitTapHighlightColor: 'transparent',
                                touchAction: 'manipulation',
                            }}
                        >
                            {isActive ? (
                                isSpeaking ? (
                                    // Green speaker icon when AI is speaking
                                    <RiVolumeUpLine className={`${iconSizeClass} text-green-400 animate-pulse`} />
                                ) : (
                                    // Red stop icon for listening/processing (both mobile and desktop)
                                    <RiStopCircleLine className={`${iconSizeClass} text-[var(--status-error)]`} />
                                )
                            ) : (
                                <VoiceStatusIndicator
                                    status={isError ? 'idle' : status}
                                    size={isMobile || isVSCode ? 'sm' : 'md'}
                                />
                            )}
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" align="center">
                        <p className="max-w-[200px] text-center">{getTooltipContent()}</p>
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>

            {/* Conversation mode toggle button */}
            {(status === 'idle' || status === 'error') && (
                <Button
                    size="icon"
                    variant="ghost"
                    onPointerDownCapture={(event) => event.stopPropagation()}
                    onClick={handleToggleConversationMode}
                    aria-label={conversationMode ? 'Continuous mode on' : 'Continuous mode off'}
                    title={conversationMode ? 'Continuous mode on' : 'Continuous mode off'}
                    className={
                        `${buttonSizeClass} p-0 ${clearHoverBackgroundClass} ${conversationMode ? 'text-[var(--status-info)] hover:text-[var(--status-info)]' : 'text-muted-foreground hover:text-foreground'}`
                    }
                >
                    <RiVoiceRecognitionLine className={continuousIconSizeClass} />
                </Button>
            )}
        </div>
    );
}
