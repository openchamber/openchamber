import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { COLOR_PRESETS, isHexColor } from '@/lib/colorPresets';
import { cn } from '@/lib/utils';

const SWATCH_CLASS = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const SELECTED_CLASS = 'ring-2 ring-foreground ring-offset-2 ring-offset-background';

type SettingsColorFieldLabels = {
  /** What an empty value means for this setting ("Automatic", "No color"). */
  empty: string;
  swatch: (color: string) => string;
  custom: string;
  hex: string;
};

/**
 * A user colour stored as six-digit hex: empty, one of the presets, or a
 * custom colour from the system picker with its hex editable next to it.
 * `legacy` is a stored value the field cannot express as hex (a project
 * colour saved by an older build as a theme key); it shows as a selected
 * swatch painted with `legacyCss` until the user picks something else.
 */
export const SettingsColorField: React.FC<{
  value: string;
  onChange: (value: string) => void;
  labels: SettingsColorFieldLabels;
  legacyCss?: string | null;
}> = ({ value, onChange, labels, legacyCss = null }) => {
  const selected = value.toLowerCase();
  const isPreset = COLOR_PRESETS.some((color) => color === selected);
  const isLegacy = selected !== '' && !isHexColor(selected) && legacyCss !== null;
  const isCustom = selected !== '' && !isPreset && !isLegacy;
  const pickerRef = React.useRef<HTMLInputElement>(null);
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);

  const draftInvalid = draft.trim() !== '' && !isHexColor(draft.trim());
  const commitDraft = () => {
    const next = draft.trim();
    if (next === '' || isHexColor(next)) onChange(next.toLowerCase());
  };

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        onClick={() => onChange('')}
        aria-pressed={selected === ''}
        className={cn(SWATCH_CLASS, 'border border-border text-muted-foreground', selected === '' && SELECTED_CLASS)}
        title={labels.empty}
        aria-label={labels.empty}
      >
        <Icon name="close" className="h-3.5 w-3.5" />
      </button>
      {isLegacy ? (
        <span aria-hidden="true" className={cn(SWATCH_CLASS, SELECTED_CLASS)} style={{ backgroundColor: legacyCss }} />
      ) : null}
      {COLOR_PRESETS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          aria-pressed={selected === color}
          className={cn(SWATCH_CLASS, selected === color && SELECTED_CLASS)}
          style={{ backgroundColor: color }}
          title={color}
          aria-label={labels.swatch(color)}
        />
      ))}
      <button
        type="button"
        onClick={() => pickerRef.current?.click()}
        aria-pressed={isCustom}
        className={cn(
          SWATCH_CLASS,
          isCustom ? SELECTED_CLASS : 'border border-dashed border-border text-muted-foreground hover:text-foreground',
        )}
        style={isCustom ? { backgroundColor: selected } : undefined}
        title={labels.custom}
        aria-label={labels.custom}
      >
        {isCustom ? null : <Icon name="add" className="h-3.5 w-3.5" />}
      </button>
      {/* The system picker, opened by the custom swatch. */}
      <input
        ref={pickerRef}
        type="color"
        tabIndex={-1}
        aria-hidden="true"
        value={isHexColor(selected) ? selected : '#808080'}
        onChange={(event) => onChange(event.target.value.toLowerCase())}
        className="sr-only"
      />
      {isCustom ? (
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') commitDraft();
          }}
          placeholder="#RRGGBB"
          aria-invalid={draftInvalid}
          aria-label={labels.hex}
          className="h-7 w-24 rounded-md px-2 font-mono typography-meta"
        />
      ) : null}
    </div>
  );
};
