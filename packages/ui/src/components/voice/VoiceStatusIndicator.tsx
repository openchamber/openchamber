/**
 * VoiceStatusIndicator Component
 *
 * Reusable visual indicator for voice mode states with icons, animations,
 * and optional status text labels.
 *
 * @example
 * ```tsx
 * // Basic usage - icon only
 * <VoiceStatusIndicator status="listening" />
 *
 * // With label
 * <VoiceStatusIndicator status="listening" showLabel />
 *
 * // Different size
 * <VoiceStatusIndicator status="processing" size="lg" />
 * ```
 */

import React from 'react';
import {
    RiMicLine,
    RiMicOffLine,
    RiLoader4Line,
    RiVolumeUpLine,
    RiAlertLine,
} from '@remixicon/react';
import type { BrowserVoiceStatus } from '@/hooks/useBrowserVoice';
import { useI18n } from '@/lib/i18n';

export interface VoiceStatusIndicatorProps {
    /** Current voice status */
    status: BrowserVoiceStatus;
    /** Show text label next to icon */
    showLabel?: boolean;
    /** Size of the indicator */
    size?: 'sm' | 'md' | 'lg';
    /** Optional className for styling */
    className?: string;
    /** Whether conversation mode is active (shows indicator dot when idle) */
    conversationMode?: boolean;
}

const sizeClasses = {
    sm: {
        icon: 'w-4 h-4',
        container: 'gap-1.5',
    },
    md: {
        icon: 'w-5 h-5',
        container: 'gap-2',
    },
    lg: {
        icon: 'w-6 h-6',
        container: 'gap-2.5',
    },
};

const statusConfig: Record<
    BrowserVoiceStatus,
    {
        icon: typeof RiMicLine;
        color: string;
        labelKey:
          | 'voice.status.idle'
          | 'voice.status.listening'
          | 'voice.status.processing'
          | 'voice.status.speaking'
          | 'voice.status.error';
        animation?: string;
    }
> = {
    idle: {
        icon: RiMicOffLine,
        color: 'text-muted-foreground',
        labelKey: 'voice.status.idle',
    },
    listening: {
        icon: RiMicLine,
        color: 'text-primary',
        labelKey: 'voice.status.listening',
        animation: 'animate-pulse',
    },
    processing: {
        icon: RiLoader4Line,
        color: 'text-primary',
        labelKey: 'voice.status.processing',
        animation: 'animate-spin',
    },
    speaking: {
        icon: RiVolumeUpLine,
        color: 'text-green-500',
        labelKey: 'voice.status.speaking',
    },
    error: {
        icon: RiAlertLine,
        color: 'text-destructive',
        labelKey: 'voice.status.error',
    },
};

/**
 * VoiceStatusIndicator - Visual indicator for voice mode states
 */
export function VoiceStatusIndicator({
    status,
    showLabel = false,
    size = 'md',
    className = '',
    conversationMode = false,
}: VoiceStatusIndicatorProps) {
    const { t } = useI18n();
    const config = statusConfig[status];
    const Icon = config.icon;
    const sizeClass = sizeClasses[size];
    const containerClass = showLabel ? sizeClass.container : '';

    return (
        <div className={`flex items-center ${containerClass} ${className}`}>
            <div className="relative">
                <Icon
                    className={`
                        ${sizeClass.icon}
                        ${config.color}
                        ${config.animation || ''}
                    `}
                    aria-hidden="true"
                />
                {/* Conversation mode indicator dot - only when idle and conversation mode is on */}
                {conversationMode && status === 'idle' && (
                    <span
                        className="absolute -top-0.5 -right-0.5 w-2 h-2 bg-green-500 rounded-full"
                        aria-label={t('voice.status.conversationModeActiveAria')}
                    />
                )}
            </div>
            {showLabel && (
                <span className={`typography-meta ${config.color}`}>
                    {t(config.labelKey)}
                </span>
            )}
        </div>
    );
}

export default VoiceStatusIndicator;
