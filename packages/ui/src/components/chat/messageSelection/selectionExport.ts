import type { VSCodeAPI } from '@/lib/api/types';
import type { Theme } from '@/types/theme';
import { copyMarkdownToClipboard } from '@/lib/clipboard';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import type { ChatMessageEntry } from '../lib/turns/types';
import { saveMessageImageExport, type MessageImageSaveResult } from '../message/imageExport';
import { listSelectableUnits, type SelectableAnswer, type SelectableUnit } from './selectableUnits';
import { formatSelectionMarkdown } from './selectionMarkdown';

type SelectedUnits = { units: SelectableUnit[]; complete: boolean };

export const pickSelectedUnits = (records: ChatMessageEntry[], keys: ReadonlySet<string>): SelectedUnits => {
    const units = listSelectableUnits(records).filter((unit) => keys.has(unit.key));
    return { units, complete: units.length === keys.size };
};

type ImageRenderOptions = { syntaxStyle: string | null; width: number; theme: Theme | undefined };

const renderMarkdown = async (text: string, options: ImageRenderOptions): Promise<HTMLElement> => {
    const { renderMarkdownForExport } = await import('../markdown/renderMarkdownForExport');
    return renderMarkdownForExport(text, { ...options, purpose: 'image' });
};

const answerModelLabel = (unit: SelectableAnswer): string | null => {
    if (!unit.modelID) return null;
    const provider = useConfigStore.getState().providers.find((entry) => entry.id === unit.providerID);
    return getProviderModelDisplayName(provider, unit.modelID) || unit.modelID;
};

const promptElement = async (text: string, options: ImageRenderOptions): Promise<HTMLElement> => {
    const row = document.createElement('div');
    row.className = 'flex justify-end';
    const bubble = document.createElement('div');
    bubble.className = 'max-w-[85%] px-5 py-3 border border-primary/5 leading-relaxed text-base text-foreground/90 break-words font-sans typography-markdown-body';
    bubble.style.backgroundColor = 'var(--chat-user-message-bg)';
    bubble.style.borderRadius = 'var(--radius-xl)';
    bubble.style.borderBottomRightRadius = 'var(--radius-sm)';
    if (useUIStore.getState().userMessageRenderingMode === 'markdown') {
        bubble.appendChild(await renderMarkdown(text, options));
    } else {
        bubble.classList.add('whitespace-pre-wrap', '[unicode-bidi:plaintext]', 'text-start');
        bubble.textContent = text;
    }
    row.appendChild(bubble);
    return row;
};

const answerElement = async (unit: SelectableAnswer, options: ImageRenderOptions): Promise<HTMLElement> => {
    const answer = document.createElement('div');
    for (const text of unit.segments) {
        const segment = document.createElement('div');
        segment.className = 'relative break-words my-1';
        segment.appendChild(await renderMarkdown(text, options));
        answer.appendChild(segment);
    }
    const model = answerModelLabel(unit);
    if (model) {
        const caption = document.createElement('div');
        caption.className = 'mt-2 typography-meta text-muted-foreground';
        caption.textContent = model;
        answer.appendChild(caption);
    }
    return answer;
};

const buildSelectionImageSource = async (units: readonly SelectableUnit[], options: ImageRenderOptions): Promise<HTMLElement> => {
    const source = document.createElement('div');
    source.className = 'message-content-text leading-relaxed text-foreground/90';
    for (const [index, unit] of units.entries()) {
        const element = unit.kind === 'prompt' ? await promptElement(unit.text, options) : await answerElement(unit, options);
        if (index > 0) element.style.marginTop = unit.kind === 'prompt' ? '2rem' : '1.25rem';
        source.appendChild(element);
    }
    return source;
};

export const saveSelectionImage = async ({ units, width, syntaxStyle, theme, vscode }: {
    units: readonly SelectableUnit[];
    width: number;
    syntaxStyle: string | null;
    theme: Theme | undefined;
    vscode: VSCodeAPI | undefined;
}): Promise<MessageImageSaveResult> => saveMessageImageExport({
    source: await buildSelectionImageSource(units, { syntaxStyle, width, theme }),
    width,
    fileName: `messages-${units[0]?.messageId ?? 'selection'}.png`,
    vscode,
});

export const copySelectionMarkdown = async (units: readonly SelectableUnit[]): Promise<boolean> => {
    const markdown = formatSelectionMarkdown(units);
    const { renderMarkdownForExport } = await import('../markdown/renderMarkdownForExport');
    const root = await renderMarkdownForExport(markdown, { purpose: 'copy' });
    const result = await copyMarkdownToClipboard(markdown, root.innerHTML);
    return result.ok;
};
