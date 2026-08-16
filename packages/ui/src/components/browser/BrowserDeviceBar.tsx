import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

/**
 * Size and appearance controls for the previewed page.
 *
 * Shown only when asked for. The width and height boxes are the source of
 * truth; the preset list is a shortcut into them, which is why choosing a
 * preset and then typing a size are the same action from here on.
 */
export const BrowserDeviceBar: React.FC<{
  viewport: BrowserViewport;
  onViewportChange: (viewport: BrowserViewport) => void;
  colorScheme: BrowserColorScheme;
  onColorSchemeChange: (scheme: BrowserColorScheme) => void;
  scale: number;
}> = ({ viewport, onViewportChange, colorScheme, onColorSchemeChange, scale }) => {
  const { t } = useI18n();
  const size = viewportSize(viewport);
  const presetId = viewport.kind === 'preset' ? viewport.id : '';

  const commitSize = (side: 'width' | 'height', raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    const current = size ?? { width: 1280, height: 800 };
    onViewportChange({
      kind: 'custom',
      width: clampViewportSize(side === 'width' ? parsed : current.width),
      height: clampViewportSize(side === 'height' ? parsed : current.height),
    });
  };

  const inputClass = cn(
    'h-6 w-14 rounded-full border border-border/50 bg-[var(--surface-elevated)] px-2 text-center',
    'typography-micro tabular-nums text-foreground outline-none focus:border-[var(--interactive-focus-ring)]',
  );

  return (
    <div className="flex items-center gap-1.5 border-b border-border bg-[var(--surface-background)] px-2 py-1">
      <select
        value={presetId}
        onChange={(event) => {
          const next = presetViewport(event.target.value);
          onViewportChange(next ?? FILL_VIEWPORT);
        }}
        aria-label={t('contextPanel.browser.device.preset')}
        className={cn(
          'h-6 shrink-0 rounded-full border border-border/50 bg-[var(--surface-elevated)] px-2',
          'typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]',
        )}
      >
        <option value="">{t('contextPanel.browser.device.responsive')}</option>
        {VIEWPORT_PRESETS.map((preset) => (
          <option key={preset.id} value={preset.id}>{preset.label}</option>
        ))}
      </select>

      <input
        value={size ? String(size.width) : ''}
        onChange={(event) => commitSize('width', event.target.value)}
        placeholder="—"
        inputMode="numeric"
        aria-label={t('contextPanel.browser.device.width')}
        className={inputClass}
      />
      <span className="typography-micro text-muted-foreground">×</span>
      <input
        value={size ? String(size.height) : ''}
        onChange={(event) => commitSize('height', event.target.value)}
        placeholder="—"
        inputMode="numeric"
        aria-label={t('contextPanel.browser.device.height')}
        className={inputClass}
      />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="w-6 shrink-0 rounded-full px-0 text-muted-foreground hover:text-foreground"
            onClick={() => onViewportChange(rotateViewport(viewport))}
            disabled={!size}
            aria-label={t('contextPanel.browser.device.rotate')}
          >
            <Icon name="refresh" className="size-3.5" aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent sideOffset={6}>{t('contextPanel.browser.device.rotate')}</TooltipContent>
      </Tooltip>

      {/* Only worth saying when the page is not shown at its real size. */}
      {size && scale < 1 ? (
        <span className="shrink-0 typography-micro tabular-nums text-muted-foreground">
          {Math.round(scale * 100)}%
        </span>
      ) : null}

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {(['system', 'light', 'dark'] as const).map((scheme) => (
          <Button
            key={scheme}
            type="button"
            variant={colorScheme === scheme ? 'secondary' : 'ghost'}
            size="xs"
            className={cn(
              'shrink-0 rounded-full px-2.5 typography-micro',
              colorScheme === scheme ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => onColorSchemeChange(scheme)}
            aria-pressed={colorScheme === scheme}
          >
            {t(scheme === 'system'
              ? 'contextPanel.browser.device.schemeSystem'
              : scheme === 'light'
                ? 'contextPanel.browser.device.schemeLight'
                : 'contextPanel.browser.device.schemeDark')}
          </Button>
        ))}
      </div>
    </div>
  );
};
