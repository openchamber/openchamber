import React from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConfigStore } from '@/stores/useConfigStore';
import {
  buildConnectionStatusViewModel,
  type ConnectionTone,
  type ConnectionStatusViewModel,
} from '@/lib/connection-status/connectionStatus';

/**
 * Compact header-grade button styles. Mirrors the icon-button visual rhythm of
 * `HeaderIconActionButton` in `Header.tsx` (no drag, hover highlight, focus
 * ring) but uses a slightly smaller `h-7 w-7` footprint so the dot can sit
 * alongside the existing icon cluster without pushing other controls.
 */
const CONNECTION_INDICATOR_BUTTON_CLASS =
  'app-region-no-drag inline-flex h-7 w-7 items-center justify-center rounded-md hover:bg-interactive-hover transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

/** The dot itself — a small status pill. Color is supplied via the tone token. */
const CONNECTION_DOT_CLASS = 'h-2 w-2 rounded-full';

/**
 * Map a view-model tone to a Tailwind theme-token class. This matches the
 * pattern in `DesktopHostSwitcher.tsx` (lines 84-93): `bg-status-*` for the
 * meaningful states, `bg-muted-foreground/40` for the muted / unknown state.
 * No hardcoded colors and no Tailwind palette classes — the values are
 * project theme tokens.
 */
const toneToDotClass = (tone: ConnectionTone): string => {
  switch (tone) {
    case 'ok':
      return 'bg-status-success';
    case 'warn':
      return 'bg-status-warning';
    case 'error':
      return 'bg-status-error';
    case 'muted':
      return 'bg-muted-foreground/40';
    default: {
      // Defensive: `ConnectionTone` is a closed union, but TypeScript cannot
      // prove exhaustiveness without `never`. Fall through to muted.
      const _exhaustive: never = tone;
      void _exhaustive;
      return 'bg-muted-foreground/40';
    }
  }
};

const hop1LabelKeyToTone = (labelKey: ConnectionStatusViewModel['hop1']['labelKey']): ConnectionTone => {
  switch (labelKey) {
    case 'connectionStatus.hop1.connected':
      return 'ok';
    case 'connectionStatus.hop1.connecting':
    case 'connectionStatus.hop1.reconnecting':
      return 'muted';
    case 'connectionStatus.hop1.disconnected':
      return 'error';
    default:
      return 'muted';
  }
};

const hop2LabelKeyToTone = (labelKey: ConnectionStatusViewModel['hop2']['labelKey']): ConnectionTone => {
  switch (labelKey) {
    case 'connectionStatus.hop2.healthy':
      return 'ok';
    case 'connectionStatus.hop2.unhealthy':
      return 'warn';
    case 'connectionStatus.hop2.unknown':
      return 'muted';
    default:
      return 'muted';
  }
};

type ConnectionStatusIndicatorBodyProps = {
  viewModel: ConnectionStatusViewModel;
};

/**
 * Inner renderer for the connection status indicator. Split out from the
 * public component so that the narrow `useConfigStore` selectors live in
 * exactly one place and the dot itself can be `React.memo`'d on
 * `viewModel` only. This keeps the dot from re-rendering when unrelated
 * state (sessions, streaming deltas, etc.) changes upstream.
 */
const ConnectionStatusIndicatorBody = React.memo(function ConnectionStatusIndicatorBody({
  viewModel,
}: ConnectionStatusIndicatorBodyProps) {
  const { t } = useI18n();
  const dotClass = toneToDotClass(viewModel.tone);
  const stateLabel = t(viewModel.overallLabelKey as I18nKey);
  const ariaLabel = t('connectionStatus.aria.indicator', { state: stateLabel });

  // Translate each tooltip line. The view model always emits exactly three
  // lines: title + hop1 + hop2. When a line carries a `reasonKey` param,
  // resolve the reason separately and compose it as
  // "<line> — <reason>". The separator is a non-translated presenter
  // concern (per the i18n mapping note in the plan: the reason is itself a
  // complete message, not a grammar fragment).
  const translatedLines = viewModel.tooltipLines.map((line) => {
    const text = t(line.key as I18nKey);
    const reasonKey = line.params && typeof line.params.reasonKey === 'string'
      ? line.params.reasonKey
      : null;
    if (reasonKey !== null) {
      const reason = t(reasonKey as I18nKey);
      return `${text} — ${reason}`;
    }
    return text;
  });

  const hopLineDotClasses = [
    toneToDotClass(hop1LabelKeyToTone(viewModel.hop1.labelKey)),
    toneToDotClass(hop2LabelKeyToTone(viewModel.hop2.labelKey)),
  ];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          className={CONNECTION_INDICATOR_BUTTON_CLASS}
        >
          <span aria-hidden="true" className={cn(CONNECTION_DOT_CLASS, dotClass)} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <div className="grid grid-cols-[0.5rem_1fr] items-center gap-x-2 gap-y-0.5">
          <p className="col-span-2 typography-micro font-medium text-foreground">
            {translatedLines[0]}
          </p>
          {translatedLines.slice(1).map((line, index) => (
            <React.Fragment key={index}>
              <span
                aria-hidden="true"
                className={cn(CONNECTION_DOT_CLASS, 'shrink-0', hopLineDotClasses[index])}
              />
              <p className="typography-micro">{line}</p>
            </React.Fragment>
          ))}
        </div>
      </TooltipContent>
    </Tooltip>
  );
});

/**
 * Compact header-grade dot that summarizes connection health across two hops:
 *   1. Frontend ↔ OpenChamber runtime
 *   2. OpenChamber runtime ↔ OpenCode
 *
 * Default UI is the dot only. The hover / focus tooltip shows 2-3 short
 * lines (title + one per hop). The dot is keyboard-reachable (renders as
 * a `<button type="button">`) and exposes a non-color cue via `aria-label`
 * for screen readers; the same content is reachable by keyboard focus
 * through the tooltip.
 *
 * Performance:
 *   - subscribes to two narrow fields on `useConfigStore`
 *     (`runtimeTransportState`, `openCodeRuntimeState`) via leaf selectors
 *   - does NOT subscribe to session list, streaming deltas, or message
 *     state — the source of truth is updated by the existing event
 *     pipeline and health-check paths
 *   - reads `navigator.onLine` on each render; the existing sync-context
 *     browser online/offline listener already updates
 *     `runtimeTransportState` when the browser reports a change, so this
 *     stays in sync without installing a second listener here
 *
 * No new polling loop is introduced.
 */
export const ConnectionStatusIndicator: React.FC = React.memo(function ConnectionStatusIndicator() {
  // Narrow leaf selectors. Each call returns the same reference when the
  // corresponding field is unchanged (Zustand uses Object.is on the
  // selector return value), so this component does not re-render on
  // session list / streaming events.
  const runtimeTransport = useConfigStore((s) => s.runtimeTransportState);
  const openCodeRuntime = useConfigStore((s) => s.openCodeRuntimeState);

  // Read `navigator.onLine` dynamically on every render. The browser's
  // online/offline transitions are mirrored into `runtimeTransportState`
  // by the existing sync-context listener, so this component re-renders
  // exactly when the value could have changed — the snapshot stays
  // fresh and a mount-while-offline app correctly transitions to a
  // non-offline state once the network is restored. We intentionally do
  // not install a separate `navigator.onLine` listener here; sync-context
  // owns that.
  const navigatorOffline =
    typeof navigator === 'object' && navigator !== null && navigator.onLine === false;

  const viewModel = React.useMemo(
    () => buildConnectionStatusViewModel({ runtimeTransport, openCodeRuntime, navigatorOffline }),
    [runtimeTransport, openCodeRuntime, navigatorOffline],
  );

  return <ConnectionStatusIndicatorBody viewModel={viewModel} />;
});
