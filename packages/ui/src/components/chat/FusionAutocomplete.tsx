import React from 'react';
import { cn, fuzzyMatch } from '@/lib/utils';
import { useUIStore } from '@/stores/useUIStore';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useI18n } from '@/lib/i18n';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';

export interface FusionPreset {
  name: string;
  description?: string;
  models: string[];
}

export interface FusionAutocompleteHandle {
  handleKeyDown: (key: string) => void;
}

interface FusionAutocompleteProps {
  searchQuery: string;
  onFusionSelect: (preset: FusionPreset) => void;
  onClose: () => void;
  style?: React.CSSProperties;
}

export const FusionAutocomplete = React.forwardRef<FusionAutocompleteHandle, FusionAutocompleteProps>(({
  searchQuery,
  onFusionSelect,
  onClose,
  style,
}, ref) => {
  const { t } = useI18n();
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const isMobile = useUIStore((state) => state.isMobile);
  const mobileMaxHeight = useMobileAutocompleteMaxHeight(containerRef, isMobile);
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const selectedIndexRef = React.useRef(0);
  const [presets, setPresets] = React.useState<FusionPreset[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const itemRefs = React.useRef<(HTMLDivElement | null)[]>([]);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await runtimeFetch('/api/openchamber/fusion/presets');
        if (!response.ok) {
          if (!cancelled) setLoadError(response.statusText || String(response.status));
          return;
        }
        const body: { presets?: FusionPreset[] } = await response.json();
        if (!cancelled) setPresets(Array.isArray(body?.presets) ? body.presets : []);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredPresets = React.useMemo(() => {
    const normalizedQuery = searchQuery.trim();
    const matches = normalizedQuery.length
      ? presets.filter((preset) => fuzzyMatch(preset.name, normalizedQuery))
      : presets;
    return [...matches].sort((a, b) => a.name.localeCompare(b.name));
  }, [presets, searchQuery]);

  React.useEffect(() => {
    setSelectedIndex(0);
  }, [filteredPresets.length, searchQuery]);

  React.useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  React.useEffect(() => {
    itemRefs.current[selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  React.useEffect(() => {
    const handlePointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target || !containerRef.current) return;
      if (!containerRef.current.contains(target)) {
        onClose();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
    };
  }, [onClose]);

  React.useImperativeHandle(ref, () => ({
    handleKeyDown: (key: string) => {
      if (key === 'Escape') {
        onClose();
        return;
      }
      if (!filteredPresets.length) return;
      if (key === 'ArrowDown') {
        setSelectedIndex((prev) => (prev + 1) % filteredPresets.length);
        return;
      }
      if (key === 'ArrowUp') {
        setSelectedIndex((prev) => (prev - 1 + filteredPresets.length) % filteredPresets.length);
        return;
      }
      if (key === 'Enter' || key === 'Tab') {
        const safeIndex = ((selectedIndexRef.current % filteredPresets.length) + filteredPresets.length) % filteredPresets.length;
        const preset = filteredPresets[safeIndex];
        if (preset) {
          onFusionSelect(preset);
        }
      }
    },
  }), [filteredPresets, onFusionSelect, onClose]);

  return (
    <div
      ref={containerRef}
      className="absolute z-[100] min-w-0 w-full max-w-[450px] max-h-60 bg-background border-2 border-border/60 rounded-xl shadow-none bottom-full mb-2 left-0 flex flex-col"
      style={mobileMaxHeight !== undefined ? { ...style, maxHeight: mobileMaxHeight } : style}
    >
      <ScrollableOverlay preventOverscroll outerClassName="flex-1 min-h-0" className="px-0 pb-2">
        {loadError ? (
          <div className="px-3 py-2 typography-ui-label text-muted-foreground">
            {t('chat.agentCapabilities.fusion.pickerLoadError')}
          </div>
        ) : filteredPresets.length ? (
          <div>
            {filteredPresets.map((preset, index) => (
              <div
                key={preset.name}
                ref={(el) => {
                  itemRefs.current[index] = el;
                }}
                className={cn(
                  'flex gap-2 px-3 py-1.5 cursor-pointer rounded-lg typography-ui-label',
                  isMobile ? 'items-center' : 'items-start',
                  index === selectedIndex && 'bg-interactive-selection',
                )}
                onClick={() => onFusionSelect(preset)}
                onMouseMove={() => {
                  setSelectedIndex(index);
                }}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold truncate">{preset.name}</span>
                    <span className="text-[10px] leading-none uppercase font-bold tracking-tight px-1.5 py-1 rounded border flex-shrink-0 bg-[var(--surface-muted)] text-muted-foreground border-[var(--interactive-border)]/60">
                      {preset.models.length}
                    </span>
                  </div>
                  {preset.description && !isMobile ? (
                    <div className="typography-meta text-muted-foreground mt-0.5 truncate">
                      {preset.description}
                    </div>
                  ) : null}
                  {!isMobile ? (
                    <div className="typography-meta text-muted-foreground mt-0.5 truncate">
                      {preset.models.join(' · ')}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="px-3 py-2 typography-ui-label text-muted-foreground">
            {t('chat.agentCapabilities.fusion.pickerEmpty')}
          </div>
        )}
      </ScrollableOverlay>
      {!isMobile ? (
        <div className="px-3 pt-1 pb-1.5 border-t typography-meta text-muted-foreground">
          ↑↓ navigate • Enter select • Esc close
        </div>
      ) : null}
    </div>
  );
});

FusionAutocomplete.displayName = 'FusionAutocomplete';
