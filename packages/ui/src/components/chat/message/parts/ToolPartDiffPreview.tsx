import React from 'react';
import { PatchDiff } from '@pierre/diffs/react';

import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { ensurePierreThemeRegistered } from '@/lib/shiki/appThemeRegistry';
import { DIFFS_HIGHLIGHTER } from '@/lib/shiki/diffsHighlighter';
import { getDefaultTheme } from '@/lib/theme/themes';
import type { DiffViewMode } from '../DiffViewToggle';
import { PlainDiffFallback } from './PlainDiffFallback';
import { PIERRE_DIFF_TINT_CSS, PIERRE_SEPARATOR_CSS } from '@/lib/shiki/pierreDiffTint';
import { useEditorCodeMetrics } from '@/lib/editorCodeMetrics';

// Loaded lazily from ToolPart: this is the only part of the tool card that
// needs @pierre/diffs' rendering stack (its highlighters), so the
// eager chat graph stays free of it and the chunk downloads on the first
// rendered tool diff.

// In the chat a diff is one flat surface: a tile's tone step off the page
// (`oc-tile`'s), in both themes, inside the block's radius.
// On the bare canvas the unchanged lines vanished into the page and only the
// tinted changed lines showed, ragged stripes with no body; the syntax
// background drew a paler panel in light themes only.
const TOOL_DIFF_UNSAFE_CSS = `
  ${PIERRE_DIFF_TINT_CSS}
  ${PIERRE_SEPARATOR_CSS}

  :host, pre, [data-diff], [data-file] {
    --diffs-light-bg: color-mix(in srgb, var(--surface-foreground) var(--oc-tile-tone), var(--oc-chat-background)) !important;
    --diffs-dark-bg: color-mix(in srgb, var(--surface-foreground) var(--oc-tile-tone), var(--oc-chat-background)) !important;
  }
`;

const TOOL_DIFF_METRICS = {
    hunkLineCount: 50,
    lineHeight: 24,
    diffHeaderHeight: 44,
    hunkSeparatorHeight: 24,
    spacing: 0,
};

/** The Changes panel's metrics where the code follows the Editor font size, so a diff reads the same in both. */
const useToolDiffMetrics = () => {
    const editorCode = useEditorCodeMetrics();
    const metrics = React.useMemo(
        () => (editorCode ? { ...TOOL_DIFF_METRICS, lineHeight: editorCode.lineHeight } : TOOL_DIFF_METRICS),
        [editorCode],
    );
    return { metrics, style: editorCode?.style };
};

const usePierreThemeConfig = () => {
    const themeSystem = useOptionalThemeSystem();
    const fallbackLightTheme = React.useMemo(() => getDefaultTheme(false), []);
    const fallbackDarkTheme = React.useMemo(() => getDefaultTheme(true), []);

    const availableThemes = React.useMemo(
        () => themeSystem?.availableThemes ?? [fallbackLightTheme, fallbackDarkTheme],
        [fallbackDarkTheme, fallbackLightTheme, themeSystem?.availableThemes],
    );
    const lightThemeId = themeSystem?.lightThemeId ?? fallbackLightTheme.metadata.id;
    const darkThemeId = themeSystem?.darkThemeId ?? fallbackDarkTheme.metadata.id;

    const lightTheme = React.useMemo(
        () => availableThemes.find((theme) => theme.metadata.id === lightThemeId) ?? fallbackLightTheme,
        [availableThemes, fallbackLightTheme, lightThemeId],
    );
    const darkTheme = React.useMemo(
        () => availableThemes.find((theme) => theme.metadata.id === darkThemeId) ?? fallbackDarkTheme,
        [availableThemes, darkThemeId, fallbackDarkTheme],
    );

    // Registration is synchronous module state inside @pierre/diffs; rendering
    // a PatchDiff with these theme ids requires it to have happened first, so
    // register during render rather than in an effect.
    const lightThemeName = ensurePierreThemeRegistered(lightTheme);
    const darkThemeName = ensurePierreThemeRegistered(darkTheme);

    const currentVariant = themeSystem?.currentTheme.metadata.variant ?? 'light';

    return {
        pierreTheme: { light: lightThemeName, dark: darkThemeName },
        pierreThemeType: currentVariant === 'dark' ? ('dark' as const) : ('light' as const),
    };
};

class DiffPreviewErrorBoundary extends React.Component<{
    resetKey: string;
    fallback: React.ReactNode;
    children: React.ReactNode;
}, { hasError: boolean }> {
    state = { hasError: false };

    static getDerivedStateFromError(): { hasError: boolean } {
        return { hasError: true };
    }

    componentDidUpdate(prevProps: { resetKey: string }) {
        if (prevProps.resetKey !== this.props.resetKey && this.state.hasError) {
            this.setState({ hasError: false });
        }
    }

    componentDidCatch(error: Error) {
        if (process.env.NODE_ENV === 'development') {
            console.warn('Tool diff preview failed; rendering raw patch instead.', error);
        }
    }

    render() {
        if (this.state.hasError) {
            return this.props.fallback;
        }
        return this.props.children;
    }
}

export interface ToolPartDiffPreviewProps {
    diff: string;
    diffViewMode: DiffViewMode;
}

const ToolPartDiffPreview: React.FC<ToolPartDiffPreviewProps> = React.memo(({ diff, diffViewMode }) => {
    const { pierreTheme, pierreThemeType } = usePierreThemeConfig();
    const { metrics, style } = useToolDiffMetrics();
    const options = React.useMemo(
        () => ({
            diffStyle: diffViewMode === 'side-by-side' ? 'split' as const : 'unified' as const,
            diffIndicators: 'none' as const,
            hunkSeparators: 'line-info-basic' as const,
            lineDiffType: 'none' as const,
            disableFileHeader: true,
            maxLineDiffLength: 1000,
            expansionLineCount: 20,
            overflow: 'wrap' as const,
            theme: pierreTheme,
            themeType: pierreThemeType,
            preferredHighlighter: DIFFS_HIGHLIGHTER,
            unsafeCSS: TOOL_DIFF_UNSAFE_CSS,
        }),
        [diffViewMode, pierreTheme, pierreThemeType]
    );

    const fallback = <PlainDiffFallback diff={diff} />;

    return (
        // No side padding: the diff starts at the tool body's edge, under nothing
        // else. The small radius of the scale, clipped, like the blocks around it.
        <div className="typography-code overflow-clip rounded-md" style={style}>
            <DiffPreviewErrorBoundary resetKey={diff} fallback={fallback}>
                <PatchDiff
                    patch={diff}
                    metrics={metrics}
                    options={options}
                    className="block w-full"
                />
            </DiffPreviewErrorBoundary>
        </div>
    );
});

ToolPartDiffPreview.displayName = 'ToolPartDiffPreview';

export default ToolPartDiffPreview;
