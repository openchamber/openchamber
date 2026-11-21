import React from 'react';

import { EditorSelection } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { readDocumentSymbols, type DocumentSymbol, type DocumentSymbolKind } from '@/lib/codemirror/documentSymbols';

const KIND_ICON = {
    function: 'braces',
    method: 'braces',
    class: 'box-3',
    type: 'code-box',
    module: 'folder-3',
    heading: 'text',
} satisfies Record<DocumentSymbolKind, IconName>;

const DOCUMENT_SYMBOLS_TOGGLE_ATTRIBUTE = 'data-document-symbols-toggle';

type DocumentSymbolsPanelProps = {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    // external: https://github.com/facebook/react/issues/34840 Editor refs keep dev profiling from traversing cross-origin frames.
    viewRef: React.RefObject<EditorView | null>;
};

export function DocumentSymbolsPanel({ open, onOpenChange, viewRef }: DocumentSymbolsPanelProps) {
    const { t } = useI18n();
    const view = viewRef.current;
    const panelRef = React.useRef<HTMLDivElement | null>(null);
    const [symbols, setSymbols] = React.useState<DocumentSymbol[]>([]);
    const [query, setQuery] = React.useState('');

    React.useEffect(() => {
        if (!open) return;
        setQuery('');
        setSymbols(view ? readDocumentSymbols(view.state) : []);
    }, [open, view]);

    const close = React.useCallback(() => {
        onOpenChange(false);
        view?.focus();
    }, [onOpenChange, view]);

    React.useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Element) || !panelRef.current || panelRef.current.contains(target)) return;
            if (target.closest(`[${DOCUMENT_SYMBOLS_TOGGLE_ATTRIBUTE}]`)) return;
            onOpenChange(false);
        };
        document.addEventListener('pointerdown', handlePointerDown, true);
        return () => document.removeEventListener('pointerdown', handlePointerDown, true);
    }, [onOpenChange, open]);

    const select = React.useCallback((symbol: DocumentSymbol) => {
        if (view) {
            view.dispatch({
                selection: EditorSelection.cursor(symbol.from),
                effects: EditorView.scrollIntoView(symbol.from, { y: 'center' }),
            });
        }
        close();
    }, [close, view]);

    if (!open) return null;

    return (
        <div
            ref={panelRef}
            data-editor-overlay
            className="absolute inset-s-3 top-3 z-40 w-[min(28rem,calc(100%-1.5rem))] overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)] shadow-lg"
            onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                close();
            }}
        >
            <Command
                loop
                filter={(value, search) => (value.split('\u0000')[0].toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0)}
                className="[&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-1 [&_[cmdk-item]]:typography-meta"
            >
                <CommandInput
                    autoFocus
                    value={query}
                    onValueChange={setQuery}
                    placeholder={t('filesView.symbols.placeholder')}
                    aria-label={t('filesView.symbols.placeholder')}
                />
                <CommandList className="max-h-[min(20rem,calc(100vh-16rem))]">
                    <CommandEmpty className="px-3 py-4 typography-meta text-muted-foreground">
                        {symbols.length === 0 ? t('filesView.symbols.noneInFile') : t('filesView.symbols.noMatches')}
                    </CommandEmpty>
                    {symbols.map((symbol) => (
                        <CommandItem
                            key={`${symbol.from}:${symbol.name}`}
                            value={`${symbol.name}\u0000${symbol.from}`}
                            onSelect={() => select(symbol)}
                            className="gap-2"
                        >
                            <span className="flex min-w-0 flex-1 items-center gap-2" style={{ paddingInlineStart: `${symbol.depth * 12}px` }}>
                                <Icon name={KIND_ICON[symbol.kind]} className="size-3.5 shrink-0 text-muted-foreground" />
                                <span className="min-w-0 truncate text-foreground">{symbol.name}</span>
                            </span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">{symbol.line}</span>
                        </CommandItem>
                    ))}
                </CommandList>
            </Command>
        </div>
    );
}
