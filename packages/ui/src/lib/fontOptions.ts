export type UiFontOption = 'ibm-plex-sans' | 'inter' | 'geist-sans' | 'atkinson-hyperlegible' | 'source-sans-3' | 'roboto' | 'noto-sans' | 'dm-sans' | 'manrope' | 'system';

export type MonoFontOption = 'ibm-plex-mono' | 'jetbrains-mono' | 'fira-code' | 'geist-mono' | 'commit-mono' | 'source-code-pro' | 'cascadia-code' | 'roboto-mono' | 'iosevka' | 'system-mono';

export interface FontFaceSource {
    family: string;
    packageName: string;
    filePrefix: string;
    weights: number[];
}

export interface FontOptionDefinition<T extends string> {
    id: T;
    label: string;
    description: string;
    stack: string;
    notes?: string;
    source?: FontFaceSource;
}

export const UI_FONT_OPTIONS: FontOptionDefinition<UiFontOption>[] = [
    {
        id: 'ibm-plex-sans',
        label: 'IBM Plex Sans',
        description: 'Humanist sans-serif for optimal readability in the interface.',
        stack: '"IBM Plex Sans", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    },
    {
        id: 'inter',
        label: 'Inter',
        description: 'Modern UI sans with excellent readability at small sizes.',
        stack: '"Inter", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Inter', packageName: '@fontsource/inter', filePrefix: 'inter', weights: [400, 500, 600] }
    },
    {
        id: 'geist-sans',
        label: 'Geist Sans',
        description: 'Crisp sans-serif with a technical interface feel.',
        stack: '"Geist Sans", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Geist Sans', packageName: '@fontsource/geist-sans', filePrefix: 'geist-sans', weights: [400, 500, 600] }
    },
    {
        id: 'atkinson-hyperlegible',
        label: 'Atkinson Hyperlegible',
        description: 'Accessibility-focused sans-serif optimized for character distinction.',
        stack: '"Atkinson Hyperlegible", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Atkinson Hyperlegible', packageName: '@fontsource/atkinson-hyperlegible', filePrefix: 'atkinson-hyperlegible', weights: [400, 700] }
    },
    {
        id: 'source-sans-3',
        label: 'Source Sans 3',
        description: 'Adobe sans-serif tuned for clean, readable interfaces.',
        stack: '"Source Sans 3", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Source Sans 3', packageName: '@fontsource/source-sans-3', filePrefix: 'source-sans-3', weights: [400, 500, 600] }
    },
    {
        id: 'roboto',
        label: 'Roboto',
        description: 'Familiar Material-style sans-serif with broad UI usage.',
        stack: '"Roboto", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Roboto', packageName: '@fontsource/roboto', filePrefix: 'roboto', weights: [400, 500, 600] }
    },
    {
        id: 'noto-sans',
        label: 'Noto Sans',
        description: 'Readable sans-serif with strong international coverage.',
        stack: '"Noto Sans", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Noto Sans', packageName: '@fontsource/noto-sans', filePrefix: 'noto-sans', weights: [400, 500, 600] }
    },
    {
        id: 'dm-sans',
        label: 'DM Sans',
        description: 'Modern product UI sans-serif with friendly proportions.',
        stack: '"DM Sans", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'DM Sans', packageName: '@fontsource/dm-sans', filePrefix: 'dm-sans', weights: [400, 500, 600] }
    },
    {
        id: 'manrope',
        label: 'Manrope',
        description: 'Polished geometric sans-serif for modern app interfaces.',
        stack: '"Manrope", "SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        source: { family: 'Manrope', packageName: '@fontsource/manrope', filePrefix: 'manrope', weights: [400, 500, 600] }
    },
    {
        id: 'system',
        label: 'System',
        description: 'Native operating system interface font.',
        stack: '"SF Pro Text", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
    }
];

export const CODE_FONT_OPTIONS: FontOptionDefinition<MonoFontOption>[] = [
    {
        id: 'ibm-plex-mono',
        label: 'IBM Plex Mono',
        description: 'Balanced monospace for code blocks and technical content.',
        stack: '"IBM Plex Mono", "SFMono-Regular", "Menlo", monospace'
    },
    {
        id: 'jetbrains-mono',
        label: 'JetBrains Mono',
        description: 'Developer-focused monospace with strong punctuation clarity.',
        stack: '"JetBrains Mono", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'JetBrains Mono', packageName: '@fontsource/jetbrains-mono', filePrefix: 'jetbrains-mono', weights: [400, 500, 600] }
    },
    {
        id: 'fira-code',
        label: 'Fira Code',
        description: 'Readable coding font with ligature support.',
        stack: '"Fira Code", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Fira Code', packageName: '@fontsource/fira-code', filePrefix: 'fira-code', weights: [400, 500, 600] }
    },
    {
        id: 'geist-mono',
        label: 'Geist Mono',
        description: 'Sharp monospace pair for Geist Sans.',
        stack: '"Geist Mono", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Geist Mono', packageName: '@fontsource/geist-mono', filePrefix: 'geist-mono', weights: [400, 500, 600] }
    },
    {
        id: 'commit-mono',
        label: 'Commit Mono',
        description: 'Code-oriented monospace with polished editor ergonomics.',
        stack: '"Commit Mono", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Commit Mono', packageName: '@fontsource/commit-mono', filePrefix: 'commit-mono', weights: [400, 500, 600] }
    },
    {
        id: 'source-code-pro',
        label: 'Source Code Pro',
        description: 'Adobe monospace designed for source code readability.',
        stack: '"Source Code Pro", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Source Code Pro', packageName: '@fontsource/source-code-pro', filePrefix: 'source-code-pro', weights: [400, 500, 600] }
    },
    {
        id: 'cascadia-code',
        label: 'Cascadia Code',
        description: 'Microsoft coding font popular in terminals and editors.',
        stack: '"Cascadia Code", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Cascadia Code', packageName: '@fontsource/cascadia-code', filePrefix: 'cascadia-code', weights: [400, 500, 600] }
    },
    {
        id: 'roboto-mono',
        label: 'Roboto Mono',
        description: 'Neutral monospace companion to Roboto.',
        stack: '"Roboto Mono", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Roboto Mono', packageName: '@fontsource/roboto-mono', filePrefix: 'roboto-mono', weights: [400, 500, 600] }
    },
    {
        id: 'iosevka',
        label: 'Iosevka',
        description: 'Compact monospace for dense code and terminal layouts.',
        stack: '"Iosevka", "SFMono-Regular", "Menlo", monospace',
        source: { family: 'Iosevka', packageName: '@fontsource/iosevka', filePrefix: 'iosevka', weights: [400, 500, 600] }
    },
    {
        id: 'system-mono',
        label: 'System Mono',
        description: 'Native operating system monospace font.',
        stack: 'ui-monospace, "SFMono-Regular", "Menlo", "Cascadia Mono", "Segoe UI Mono", monospace'
    }
];

const buildFontMap = <T extends string>(options: FontOptionDefinition<T>[]) =>
    Object.fromEntries(options.map((option) => [option.id, option])) as Record<T, FontOptionDefinition<T>>;

export const UI_FONT_OPTION_MAP = buildFontMap(UI_FONT_OPTIONS);
export const CODE_FONT_OPTION_MAP = buildFontMap(CODE_FONT_OPTIONS);

export const DEFAULT_UI_FONT: UiFontOption = 'ibm-plex-sans';
export const DEFAULT_MONO_FONT: MonoFontOption = 'ibm-plex-mono';

export const isUiFontOption = (value: unknown): value is UiFontOption =>
    typeof value === 'string' && value in UI_FONT_OPTION_MAP;

export const isMonoFontOption = (value: unknown): value is MonoFontOption =>
    typeof value === 'string' && value in CODE_FONT_OPTION_MAP;
