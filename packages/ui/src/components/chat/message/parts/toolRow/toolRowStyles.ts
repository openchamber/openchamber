import React from 'react';
import { toolDisplayStyles } from '@/lib/typography';
import { cn } from '@/lib/utils';

const TOOL_ROW_TEXT_CLASS = '!text-[length:var(--text-meta)] !leading-5 sm:!leading-6 tracking-normal';
// A tool's name is the row's label: muted, regular weight. What it acted on
// (a file name, an argument) reads in the foreground, quieter than prose.
export const TOOL_ROW_TITLE_CLASS = cn('typography-meta font-normal', TOOL_ROW_TEXT_CLASS);
export const TOOL_ROW_DESCRIPTION_CLASS = cn('typography-meta', TOOL_ROW_TEXT_CLASS);

export const TOOL_COLLAPSED_CUSTOM_STYLE: React.CSSProperties = {
    ...toolDisplayStyles.getCollapsedStyles(),
    padding: 0,
    overflow: 'visible',
};

export const CODE_TAG_PROPS = { style: { background: 'transparent', backgroundColor: 'transparent' } };

export const TOOL_ERROR_ICON_STYLE: React.CSSProperties = { color: 'var(--status-error)' };
export const TOOL_NORMAL_ICON_STYLE: React.CSSProperties = { color: 'var(--tools-icon)' };
export const TOOL_ERROR_TITLE_STYLE: React.CSSProperties = { color: 'var(--status-error)' };
export const TOOL_NORMAL_TITLE_STYLE: React.CSSProperties = { color: 'var(--tools-description)' };
