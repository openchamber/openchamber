import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { ButtonTooltip, ToolbarTooltipButton } from '@/components/ui/action-toolbar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  FILL_VIEWPORT,
  VIEWPORT_PRESETS,
  clampViewportSize,
  presetViewport,
  rotateViewport,
  viewportSize,
  type BrowserViewport,
} from '@/lib/browser/viewport';

export type BrowserColorScheme = 'system' | 'light' | 'dark';

/** The preset list's value for "fill the panel". */
const RESPONSIVE = 'responsive';

const SCHEMES: ReadonlyArray<{ value: BrowserColorScheme; icon: IconName }> = [
  { value: 'system', icon: 'contrast-2' },
  { value: 'light', icon: 'sun' },
  { value: 'dark', icon: 'moon' },
];

/**
 * Size and appearance controls for the previewed page.
 *
 * Shown only when asked for. The width and height boxes are the source of
 * truth; the preset list is a shortcut into them, which is why choosing a
 * preset and then typing a size are the same action from here on. While the
 * page fills the panel, the boxes show the panel's size, muted: typing there
 * starts from what the page has now.
 */
export const BrowserDeviceBar: React.FC<{
  viewport: BrowserViewport;
  onViewportChange: (viewport: BrowserViewport) => void;
  colorScheme: BrowserColorScheme;
  onColorSchemeChange: (scheme: BrowserColorScheme) => void;
  scale: number;
  /** The size the page gets while it fills the panel. */
  panelSize: { width: number; height: number };
}> = ({ viewport, onViewportChange, colorScheme, onColorSchemeChange, scale, panelSize }) => {
  const { t } = useI18n();
  const size = viewportSize(viewport);
  const presetId = viewport.kind === 'preset' ? viewport.id : RESPONSIVE;
  const presetLabel = (id: string) => (
    id === RESPONSIVE ? t('contextPanel.browser.device.responsive') : VIEWPORT_PRESETS.find((preset) => preset.id === id)?.label ?? id
  );
  const shownPanelSize = { width: Math.round(panelSize.width), height: Math.round(panelSize.height) };

  const commitSize = (side: 'width' | 'height', raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    const current = size ?? shownPanelSize;
    onViewportChange({
      kind: 'custom',
      width: clampViewportSize(side === 'width' ? parsed : current.width),
      height: clampViewportSize(side === 'height' ? parsed : current.height),
    });
  };

  // The two sizes share one field, as one value: a box each read as two separate controls.
  const sizeInputClass = cn(
    'w-11 min-w-0 bg-transparent text-center typography-meta tabular-nums text-foreground outline-none',
    'placeholder:text-muted-foreground',
  );

  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 pb-1.5">
      <Select<string>
        value={presetId}
        onValueChange={(value) => onViewportChange(value === RESPONSIVE ? FILL_VIEWPORT : presetViewport(value) ?? FILL_VIEWPORT)}
      >
        <SelectTrigger className="min-w-0 max-w-[12rem]" aria-label={t('contextPanel.browser.device.preset')}>
          <SelectValue>{(value) => presetLabel(String(value))}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={RESPONSIVE}>{t('contextPanel.browser.device.responsive')}</SelectItem>
          {VIEWPORT_PRESETS.map((preset) => (
            <SelectItem key={preset.id} value={preset.id}>{preset.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="oc-raised oc-field flex h-7 shrink-0 items-center rounded-md bg-[var(--surface-elevated)] px-1">
        <input
          value={size ? String(size.width) : ''}
          onChange={(event) => commitSize('width', event.target.value)}
          placeholder={shownPanelSize.width > 0 ? String(shownPanelSize.width) : ''}
          inputMode="numeric"
          aria-label={t('contextPanel.browser.device.width')}
          className={sizeInputClass}
        />
        <span className="typography-meta text-muted-foreground" aria-hidden="true">×</span>
        <input
          value={size ? String(size.height) : ''}
          onChange={(event) => commitSize('height', event.target.value)}
          placeholder={shownPanelSize.height > 0 ? String(shownPanelSize.height) : ''}
          inputMode="numeric"
          aria-label={t('contextPanel.browser.device.height')}
          className={sizeInputClass}
        />
      </div>
      <ToolbarTooltipButton
        icon="anticlockwise-2"
        label={t('contextPanel.browser.device.rotate')}
        onClick={() => onViewportChange(rotateViewport(viewport))}
        disabled={!size}
      />

      {/* Only worth saying when the page is not shown at its real size. */}
      {size && scale < 1 ? (
        <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
      ) : null}

      <div
        role="group"
        aria-label={t('contextPanel.browser.device.scheme')}
        className="oc-recessed ms-auto inline-flex h-7 shrink-0 items-center gap-0.5 rounded-lg bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)] p-0.5"
      >
        {SCHEMES.map(({ value, icon }) => {
          const selected = colorScheme === value;
          return (
            <ButtonTooltip
              key={value}
              side="bottom"
              label={t(value === 'system'
                ? 'contextTooltips.terminalBrowser.device.schemeSystem'
                : value === 'light'
                  ? 'contextTooltips.terminalBrowser.device.schemeLight'
                  : 'contextTooltips.terminalBrowser.device.schemeDark')}
            >
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-pressed={selected}
                onClick={() => onColorSchemeChange(value)}
                className={cn(
                  'h-6 gap-1.5 rounded-md px-2 typography-meta !font-normal',
                  selected
                    // As the settings chips: the chosen option is raised out of the track.
                    ? 'oc-raised bg-[var(--surface-background)] text-foreground hover:bg-[var(--surface-background)] dark:bg-[var(--surface-elevated)] dark:hover:bg-[var(--surface-elevated)]'
                    : 'text-muted-foreground hover:bg-transparent hover:text-foreground',
                )}
              >
                <Icon name={icon} className="size-3.5" aria-hidden="true" />
                {t(value === 'system'
                  ? 'contextPanel.browser.device.schemeSystem'
                  : value === 'light'
                    ? 'contextPanel.browser.device.schemeLight'
                    : 'contextPanel.browser.device.schemeDark')}
              </Button>
            </ButtonTooltip>
          );
        })}
      </div>
    </div>
  );
};
