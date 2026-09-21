/**
 * Scrolling microphone level history for the dictation overlay.
 *
 * Newest sample is at the right edge and the history scrolls left, so the row
 * reads as a live recording trace rather than a single level bar. Silence
 * renders as a dot, speech as a rounded bar.
 *
 * Drawn on a canvas fed by a level subscription: the level updates ~12 times a
 * second, and routing that through React state would re-render the whole
 * dictation overlay at the same rate.
 */

import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import type { DictationLevelListener } from '@/lib/dictation/use-dictation-audio-source';

interface DictationWaveformProps {
    subscribeLevel: (listener: DictationLevelListener) => () => void;
    className?: string;
}

const BAR_WIDTH = 2;
const BAR_GAP = 3;
const BAR_PITCH = BAR_WIDTH + BAR_GAP;
/** One sample per bar; ~16 bars/s scrolls at a readable speed. */
const SAMPLE_INTERVAL_MS = 60;
/** Raise quiet speech so normal talking uses most of the height. */
const LEVEL_CURVE = 0.65;

export const DictationWaveform: React.FC<DictationWaveformProps> = ({ subscribeLevel, className }) => {
    const { currentTheme } = useThemeSystem();
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
    const barColor = currentTheme.colors.surface.mutedForeground;

    React.useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            return;
        }
        const context = canvas.getContext('2d');
        if (!context) {
            return;
        }

        // Peak-hold between samples: a short loud syllable must not be missed
        // just because it landed between two frames.
        let peakSinceSample = 0;
        const unsubscribe = subscribeLevel((level) => {
            peakSinceSample = Math.max(peakSinceSample, level);
        });

        const bars: number[] = [];
        let cssWidth = 0;
        let cssHeight = 0;

        const resize = () => {
            const rect = canvas.getBoundingClientRect();
            const dpr = window.devicePixelRatio || 1;
            cssWidth = rect.width;
            cssHeight = rect.height;
            canvas.width = Math.max(1, Math.round(cssWidth * dpr));
            canvas.height = Math.max(1, Math.round(cssHeight * dpr));
            context.setTransform(dpr, 0, 0, dpr, 0, 0);
        };
        resize();
        const observer = new ResizeObserver(resize);
        observer.observe(canvas);

        const draw = () => {
            const capacity = Math.max(1, Math.floor(cssWidth / BAR_PITCH));
            while (bars.length > capacity) {
                bars.shift();
            }

            context.clearRect(0, 0, cssWidth, cssHeight);
            context.strokeStyle = barColor;
            context.fillStyle = barColor;
            context.lineWidth = BAR_WIDTH;
            context.lineCap = 'round';

            const centerY = cssHeight / 2;
            const maxHeight = Math.max(BAR_WIDTH, cssHeight);
            // Anchor the newest bar to the right edge; older bars trail left.
            const rightX = cssWidth - BAR_WIDTH / 2;

            for (let i = 0; i < bars.length; i++) {
                const x = rightX - (bars.length - 1 - i) * BAR_PITCH;
                if (x < BAR_WIDTH / 2) {
                    continue;
                }
                const height = BAR_WIDTH + (maxHeight - BAR_WIDTH) * Math.pow(bars[i], LEVEL_CURVE);
                // Round caps add BAR_WIDTH/2 past each end of the stroke, so the
                // stroke itself is the height minus one cap diameter.
                const half = (height - BAR_WIDTH) / 2;
                context.beginPath();
                if (half < 0.25) {
                    context.arc(x, centerY, BAR_WIDTH / 2, 0, Math.PI * 2);
                    context.fill();
                } else {
                    context.moveTo(x, centerY - half);
                    context.lineTo(x, centerY + half);
                    context.stroke();
                }
            }
        };

        let frame = 0;
        let lastSampleAt = 0;
        const tick = (now: number) => {
            frame = requestAnimationFrame(tick);
            if (now - lastSampleAt < SAMPLE_INTERVAL_MS) {
                return;
            }
            lastSampleAt = now;
            bars.push(peakSinceSample);
            peakSinceSample = 0;
            draw();
        };
        frame = requestAnimationFrame(tick);

        return () => {
            cancelAnimationFrame(frame);
            observer.disconnect();
            unsubscribe();
        };
    }, [subscribeLevel, barColor]);

    return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
};
