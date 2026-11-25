import React from 'react';

import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Button } from '@/components/ui/button';
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
    ANNOTATION_INK_COLORS,
    ANNOTATION_MAX_SCALE,
    ANNOTATION_MIN_SCALE,
    type AnnotationTool,
} from '@/lib/imageAnnotation';

type ToolDefinition = {
    tool: AnnotationTool;
    icon: IconName;
    labelKey: I18nKey;
};

const TOOLS: readonly ToolDefinition[] = [
    { tool: 'select', icon: 'cursor', labelKey: 'chat.image.annotate.tool.select' },
    { tool: 'pen', icon: 'pencil', labelKey: 'chat.image.annotate.tool.pen' },
    { tool: 'text', icon: 'text', labelKey: 'chat.image.annotate.tool.text' },
    { tool: 'rectangle', icon: 'checkbox-blank', labelKey: 'chat.image.annotate.tool.rectangle' },
    { tool: 'ellipse', icon: 'checkbox-blank-circle', labelKey: 'chat.image.annotate.tool.ellipse' },
    { tool: 'arrow', icon: 'arrow-right-up', labelKey: 'chat.image.annotate.tool.arrow' },
    { tool: 'eraser', icon: 'eraser', labelKey: 'chat.image.annotate.tool.eraser' },
];

const INK_COLORS: ReadonlyArray<{ value: string; labelKey: I18nKey }> = [
    { value: ANNOTATION_INK_COLORS[0], labelKey: 'chat.image.annotate.color.red' },
    { value: ANNOTATION_INK_COLORS[1], labelKey: 'chat.image.annotate.color.amber' },
    { value: ANNOTATION_INK_COLORS[2], labelKey: 'chat.image.annotate.color.green' },
    { value: ANNOTATION_INK_COLORS[3], labelKey: 'chat.image.annotate.color.blue' },
    { value: ANNOTATION_INK_COLORS[4], labelKey: 'chat.image.annotate.color.black' },
    { value: ANNOTATION_INK_COLORS[5], labelKey: 'chat.image.annotate.color.white' },
];

const PRESSED_CLASS = 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground';

type ImageAnnotationToolbarProps = {
    tool: AnnotationTool;
    color: string;
    scale: number;
    canUndo: boolean;
    canRedo: boolean;
    canApply: boolean;
    saving: boolean;
    ready: boolean;
    isMobile: boolean;
    onToolChange: (tool: AnnotationTool) => void;
    onColorChange: (color: string) => void;
    onUndo: () => void;
    onRedo: () => void;
    onZoomIn: () => void;
    onZoomOut: () => void;
    onApply: () => void;
};

const ToolButton: React.FC<{
    icon: IconName;
    label: string;
    pressed?: boolean;
    disabled?: boolean;
    isMobile: boolean;
    onClick: () => void;
}> = ({ icon, label, pressed, disabled, isMobile, onClick }) => (
    <Tooltip>
        <TooltipTrigger asChild>
            <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(isMobile ? 'size-9' : 'size-8', pressed && PRESSED_CLASS)}
                aria-label={label}
                aria-pressed={pressed}
                disabled={disabled}
                onClick={onClick}
            >
                <Icon name={icon} className="size-4" />
            </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={6}>{label}</TooltipContent>
    </Tooltip>
);

const ColorPicker: React.FC<{
    color: string;
    disabled: boolean;
    isMobile: boolean;
    onColorChange: (color: string) => void;
}> = ({ color, disabled, isMobile, onColorChange }) => {
    const { t } = useI18n();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={cn(isMobile ? 'size-9' : 'size-8')}
                    aria-label={t('chat.image.annotate.color')}
                    disabled={disabled}
                >
                    <span
                        aria-hidden="true"
                        className="size-4 rounded-full border border-edge-strong"
                        style={{ backgroundColor: color }}
                    />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side={isMobile ? 'top' : 'left'} align="center" className="min-w-36">
                {INK_COLORS.map((entry) => (
                    <DropdownMenuItem key={entry.value} onSelect={() => onColorChange(entry.value)}>
                        <span
                            aria-hidden="true"
                            className="size-3.5 shrink-0 rounded-full border border-edge-strong"
                            style={{ backgroundColor: entry.value }}
                        />
                        <span className="flex-1">{t(entry.labelKey)}</span>
                        {color === entry.value ? <Icon name="check" className="size-3.5 shrink-0" /> : null}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

const Divider: React.FC<{ isMobile: boolean }> = ({ isMobile }) => (
    <span
        aria-hidden="true"
        className={cn('shrink-0 bg-edge-muted', isMobile ? 'mx-0.5 h-6 w-px' : 'my-0.5 h-px w-6')}
    />
);

export const ImageAnnotationToolbar: React.FC<ImageAnnotationToolbarProps> = ({
    tool,
    color,
    scale,
    canUndo,
    canRedo,
    canApply,
    saving,
    ready,
    isMobile,
    onToolChange,
    onColorChange,
    onUndo,
    onRedo,
    onZoomIn,
    onZoomOut,
    onApply,
}) => {
    const { t } = useI18n();
    const toolButtons = TOOLS.map((entry) => (
        <ToolButton
            key={entry.tool}
            icon={entry.icon}
            label={t(entry.labelKey)}
            pressed={tool === entry.tool}
            disabled={saving || !ready}
            isMobile={isMobile}
            onClick={() => onToolChange(entry.tool)}
        />
    ));

    const commonActions = (
        <>
            <ColorPicker color={color} disabled={saving || !ready} isMobile={isMobile} onColorChange={onColorChange} />
            <Divider isMobile={isMobile} />
            <ToolButton
                icon="arrow-go-back"
                label={t('chat.image.annotate.undo')}
                disabled={saving || !ready || !canUndo}
                isMobile={isMobile}
                onClick={onUndo}
            />
            <ToolButton
                icon="arrow-go-forward"
                label={t('chat.image.annotate.redo')}
                disabled={saving || !ready || !canRedo}
                isMobile={isMobile}
                onClick={onRedo}
            />
            <Divider isMobile={isMobile} />
            <ToolButton
                icon="zoom-out"
                label={t('chat.image.annotate.zoomOut')}
                disabled={saving || !ready || scale <= ANNOTATION_MIN_SCALE}
                isMobile={isMobile}
                onClick={onZoomOut}
            />
            <ToolButton
                icon="zoom-in"
                label={t('chat.image.annotate.zoomIn')}
                disabled={saving || !ready || scale >= ANNOTATION_MAX_SCALE}
                isMobile={isMobile}
                onClick={onZoomIn}
            />
        </>
    );

    if (isMobile) {
        return (
            <div className="absolute inset-x-1 bottom-1 z-20 flex items-center gap-1">
                <div
                    role="toolbar"
                    aria-label={t('chat.image.annotate.tools')}
                    className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto scrollbar-none rounded-xl p-1 oc-glass-popover oc-glass-floating"
                >
                    {toolButtons}
                    <Divider isMobile />
                    {commonActions}
                </div>
                <Button
                    type="button"
                    size="default"
                    className="h-9 shrink-0"
                    onClick={onApply}
                    disabled={saving || !ready || !canApply}
                >
                    {saving ? <Spinner className="size-4" aria-label={t('chat.image.annotate.applying')} /> : null}
                    {saving ? t('chat.image.annotate.applying') : t('chat.image.annotate.apply')}
                </Button>
            </div>
        );
    }

    return (
        <div
            role="toolbar"
            aria-label={t('chat.image.annotate.tools')}
            className="absolute inset-e-2 top-1/2 z-20 flex max-h-[calc(100%-0.5rem)] -translate-y-1/2 flex-col items-center gap-0.5 overflow-y-auto scrollbar-none rounded-xl p-1 oc-glass-popover oc-glass-floating"
        >
            {toolButtons}
            <Divider isMobile={false} />
            {commonActions}
            <Divider isMobile={false} />
            <Tooltip>
                <TooltipTrigger asChild>
                    <Button
                        type="button"
                        size="icon"
                        className="size-8"
                        aria-label={t('chat.image.annotate.apply')}
                        aria-busy={saving}
                        onClick={onApply}
                        disabled={saving || !ready || !canApply}
                    >
                        {saving
                            ? <Spinner className="size-4" aria-label={t('chat.image.annotate.applying')} />
                            : <Icon name="check" className="size-4" />}
                    </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{t('chat.image.annotate.apply')}</TooltipContent>
            </Tooltip>
        </div>
    );
};