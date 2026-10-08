import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { isAgentHexColor } from '@/lib/agentColors';
import { cn } from '@/lib/utils';

/**
 * Preset agent colours. These are user data written into the agent's config,
 * not interface styling: the config holds hex only, so presets cannot follow
 * the theme. One distinct mid-tone per hue, readable on dark and light themes.
 */
const AGENT_COLOR_PRESETS = ['#e5484d', '#f76b15', '#d6a312', '#30a46c', '#12a594', '#3e63dd', '#8e4ec6', '#d6409f'] as const;

const SWATCH_CLASS = 'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-shadow focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const SELECTED_CLASS = 'ring-2 ring-foreground ring-offset-2 ring-offset-background';

/**
 * Colour picker for an agent's `color` config: automatic (OpenChamber picks a
 * theme colour), one of the presets, or a custom colour from the system picker
 * with its hex editable next to it. An empty value means automatic.
 */
export const AgentColorField: React.FC<{
  value: string;
  onChange: (value: string) => void;
}> = ({ value, onChange }) => {
  const { t } = useI18n();
  const selected = value.toLowerCase();
  const isPreset = AGENT_COLOR_PRESETS.some((color) => color === selected);
  const isCustom = selected !== '' && !isPreset;
  const pickerRef = React.useRef<HTMLInputElement>(null);
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);

  const draftInvalid = draft.trim() !== '' && !isAgentHexColor(draft.trim());
  const commitDraft = () => {
    const next = draft.trim();
    if (next === '' || isAgentHexColor(next)) onChange(next.toLowerCase());
  };

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <button
        type="button"
        onClick={() => onChange('')}
        aria-pressed={selected === ''}
        className={cn(SWATCH_CLASS, 'border border-border text-muted-foreground', selected === '' && SELECTED_CLASS)}
        title={t('settings.agents.page.field.colorAutomatic')}
        aria-label={t('settings.agents.page.field.colorAutomatic')}
      >
        <Icon name="close" className="h-3.5 w-3.5" />
      </button>
      {AGENT_COLOR_PRESETS.map((color) => (
        <button
          key={color}
          type="button"
          onClick={() => onChange(color)}
          aria-pressed={selected === color}
          className={cn(SWATCH_CLASS, selected === color && SELECTED_CLASS)}
          style={{ backgroundColor: color }}
          title={color}
          aria-label={t('settings.agents.page.field.colorSwatchAria', { color })}
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
        title={t('settings.agents.page.field.colorCustomAria')}
        aria-label={t('settings.agents.page.field.colorCustomAria')}
      >
        {isCustom ? null : <Icon name="add" className="h-3.5 w-3.5" />}
      </button>
      {/* The system picker, opened by the custom swatch. */}
      <input
        ref={pickerRef}
        type="color"
        tabIndex={-1}
        aria-hidden="true"
        value={isAgentHexColor(selected) ? selected : '#808080'}
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
          aria-label={t('settings.agents.page.field.colorHexAria')}
          className="h-7 w-24 rounded-md px-2 font-mono typography-meta"
        />
      ) : null}
    </div>
  );
};
