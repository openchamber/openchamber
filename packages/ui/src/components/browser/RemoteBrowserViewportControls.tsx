import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { VIEWPORT_PRESETS } from '@/lib/browser/viewport';
import type { RemoteSurfaceViewport, RemoteSurfaceViewportSelection } from '@/lib/browser/remoteSurfaceViewport';

type RemoteBrowserViewportControlsProps = {
  readonly viewport: RemoteSurfaceViewport;
  readonly enabled: boolean;
  readonly stage: { readonly width: number; readonly height: number };
  readonly displayScale: number | null;
};

type DraftSize = {
  readonly width: string;
  readonly height: string;
};

const MAX_VIEWPORT_DIMENSION = 3_840;
const DESKTOP_PRESET_IDS = new Set(['laptop', 'desktop']);

const parseDimension = (value: string): number | null => {
  if (!/^\d+$/.test(value)) return null;
  const dimension = Number(value);
  return Number.isSafeInteger(dimension) && dimension >= 1 && dimension <= MAX_VIEWPORT_DIMENSION
    ? dimension
    : null;
};

const isPresetMobile = (id: string): boolean => !DESKTOP_PRESET_IDS.has(id);

const selectedPresetId = (selection: RemoteSurfaceViewportSelection | null): string | null => {
  if (!selection || selection.mode === 'auto') return null;
  return VIEWPORT_PRESETS.find((preset) => (
    preset.width === selection.width && preset.height === selection.height
  ))?.id ?? null;
};

const selectionFromState = (state: ReturnType<RemoteSurfaceViewport['getSnapshot']>): RemoteSurfaceViewportSelection | null => {
  const confirmed = state.viewport;
  if (!confirmed || confirmed.mode === 'external' || confirmed.source === 'external') return null;
  return {
    width: confirmed.width,
    height: confirmed.height,
    mode: confirmed.mode,
    mobile: confirmed.mobile,
  };
};

export const RemoteBrowserViewportControls: React.FC<RemoteBrowserViewportControlsProps> = ({
  viewport,
  enabled,
  stage,
  displayScale,
}) => {
  const { t } = useI18n();
  const state = React.useSyncExternalStore(viewport.subscribe, viewport.getSnapshot, viewport.getSnapshot);
  const confirmedSelection = selectionFromState(state);
  const confirmedWidth = confirmedSelection?.width;
  const confirmedHeight = confirmedSelection?.height;
  const confirmedMobile = confirmedSelection?.mobile;
  const confirmedPresetId = selectedPresetId(confirmedSelection);
  const initialSize = confirmedSelection ?? { width: stage.width, height: stage.height };
  const [draftSize, setDraftSize] = React.useState<DraftSize>(() => ({
    width: String(initialSize.width),
    height: String(initialSize.height),
  }));
  const [editing, setEditing] = React.useState(false);
  const [customMobile, setCustomMobile] = React.useState(false);

  React.useEffect(() => {
    viewport.updateStage(stage.width, stage.height);
  }, [stage.height, stage.width, viewport]);

  React.useEffect(() => {
    if (editing || confirmedWidth === undefined || confirmedHeight === undefined || confirmedMobile === undefined) return;
    setDraftSize({
      width: String(confirmedWidth),
      height: String(confirmedHeight),
    });
    setCustomMobile(confirmedMobile);
  }, [confirmedHeight, confirmedMobile, confirmedWidth, editing]);

  const selectViewport = React.useCallback((selection: RemoteSurfaceViewportSelection) => {
    if (!enabled || state.pending) return;
    viewport.selectViewport(selection);
  }, [enabled, state.pending, viewport]);

  const commitDraft = React.useCallback(() => {
    const width = parseDimension(draftSize.width);
    const height = parseDimension(draftSize.height);
    setEditing(false);
    if (!width || !height) return;
    selectViewport({ width, height, mode: 'fixed', mobile: customMobile });
  }, [customMobile, draftSize.height, draftSize.width, selectViewport]);

  const chooseAuto = React.useCallback(() => {
    selectViewport({ width: stage.width, height: stage.height, mode: 'auto', mobile: false });
  }, [selectViewport, stage.height, stage.width]);

  const choosePreset = React.useCallback((id: string) => {
    const preset = VIEWPORT_PRESETS.find((entry) => entry.id === id);
    if (!preset) return;
    setDraftSize({ width: String(preset.width), height: String(preset.height) });
    setCustomMobile(isPresetMobile(preset.id));
    selectViewport({
      width: preset.width,
      height: preset.height,
      mode: 'fixed',
      mobile: isPresetMobile(preset.id),
    });
  }, [selectViewport]);

  const rotate = React.useCallback(() => {
    const width = parseDimension(draftSize.width);
    const height = parseDimension(draftSize.height);
    if (!width || !height) return;
    const next = { width: String(height), height: String(width) };
    setDraftSize(next);
    selectViewport({ width: height, height: width, mode: 'fixed', mobile: customMobile });
  }, [customMobile, draftSize.height, draftSize.width, selectViewport]);

  const isDisabled = !enabled || state.pending !== null;
  const confirmed = state.viewport;
  const external = confirmed?.source === 'external';
  const presetLabel = confirmed?.mode === 'auto'
    ? t('contextPanel.browser.remote.viewport.auto')
    : external
      ? t('contextPanel.browser.remote.viewport.external')
      : confirmedPresetId
        ? VIEWPORT_PRESETS.find((preset) => preset.id === confirmedPresetId)?.label ?? t('contextPanel.browser.remote.viewport.custom')
        : t('contextPanel.browser.remote.viewport.custom');

  return (
    <section className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-background px-2 py-1.5" aria-label={t('contextPanel.browser.remote.viewport.preset')}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={isDisabled}
            aria-label={t('contextPanel.browser.remote.viewport.preset')}
            className={cn(dropdownTriggerVariants({ size: 'sm' }), 'min-w-0 max-w-full')}
          >
            <span className="min-w-0 truncate">{presetLabel}</span>
            <Icon name="arrow-down-s" className="size-3.5" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-52">
          <DropdownMenuRadioGroup
            value={confirmed?.mode === 'auto' ? 'auto' : confirmedPresetId ?? 'custom'}
            onValueChange={(value) => {
              if (value === 'auto') chooseAuto();
              else if (value === 'custom') commitDraft();
              else choosePreset(value);
            }}
          >
            <DropdownMenuRadioItem value="auto">{t('contextPanel.browser.remote.viewport.auto')}</DropdownMenuRadioItem>
            {VIEWPORT_PRESETS.map((preset) => (
              <DropdownMenuRadioItem key={preset.id} value={preset.id}>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
                  <span className="truncate">{preset.label}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">{preset.width} × {preset.height}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
            <DropdownMenuRadioItem value="custom">{t('contextPanel.browser.remote.viewport.custom')}</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Input
          value={draftSize.width}
          onChange={(event) => setDraftSize((current) => ({ ...current, width: event.target.value }))}
          onFocus={() => setEditing(true)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          aria-label={t('contextPanel.browser.remote.viewport.width')}
          aria-invalid={parseDimension(draftSize.width) === null}
          disabled={isDisabled}
          inputMode="numeric"
          pattern="[0-9]*"
          className="h-6 w-16 px-2 text-center typography-micro tabular-nums"
        />
        <span className="typography-micro text-muted-foreground" aria-hidden="true">×</span>
        <Input
          value={draftSize.height}
          onChange={(event) => setDraftSize((current) => ({ ...current, height: event.target.value }))}
          onFocus={() => setEditing(true)}
          onBlur={commitDraft}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.currentTarget.blur();
            }
          }}
          aria-label={t('contextPanel.browser.remote.viewport.height')}
          aria-invalid={parseDimension(draftSize.height) === null}
          disabled={isDisabled}
          inputMode="numeric"
          pattern="[0-9]*"
          className="h-6 w-16 px-2 text-center typography-micro tabular-nums"
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={isDisabled || parseDimension(draftSize.width) === null || parseDimension(draftSize.height) === null}
              onClick={rotate}
              aria-label={t('contextPanel.browser.remote.viewport.rotate')}
            >
              <Icon name="refresh" className="size-3.5" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent sideOffset={6}>{t('contextPanel.browser.remote.viewport.rotate')}</TooltipContent>
        </Tooltip>
      </div>

      {!external ? (
        <label className="flex min-w-0 items-center gap-1.5 typography-micro text-muted-foreground">
          <Checkbox
            checked={customMobile}
            onChange={(mobile) => {
              setCustomMobile(mobile);
              const width = parseDimension(draftSize.width);
              const height = parseDimension(draftSize.height);
              if (width && height) selectViewport({ width, height, mode: 'fixed', mobile });
            }}
            disabled={isDisabled}
            ariaLabel={t('contextPanel.browser.remote.viewport.mobile')}
          />
          <span className="min-w-0 truncate">{t('contextPanel.browser.remote.viewport.mobile')}</span>
        </label>
      ) : null}

      <div className="ml-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 typography-micro tabular-nums text-muted-foreground">
        {confirmed ? (
          <span>{t('contextPanel.browser.remote.viewport.dimensionsConfirmed', { width: confirmed.width, height: confirmed.height })}</span>
        ) : null}
        {displayScale ? <span>{t('contextPanel.browser.remote.viewport.scale')}: {Math.round(displayScale * 100)}%</span> : null}
        {state.pending ? <span role="status">{t('contextPanel.browser.remote.viewport.pending')}</span> : null}
        {state.errorCode ? <span className="text-[var(--status-error)]">{t('contextPanel.browser.remote.viewport.error', { code: state.errorCode })}</span> : null}
        {state.agentControlling ? <span>{t('contextPanel.browser.remote.viewport.agentControlled')}</span> : null}
        {external ? <span>{t('contextPanel.browser.remote.viewport.external')}</span> : null}
      </div>
    </section>
  );
};
