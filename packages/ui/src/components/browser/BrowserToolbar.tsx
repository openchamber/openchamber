import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { ActionToolbar, ButtonTooltip, ToolbarTooltipButton, type ToolbarGroup } from '@/components/ui/action-toolbar';
import { useI18n } from '@/lib/i18n';
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { BrowserAddressSuggestions } from './BrowserAddressSuggestions';
import type { BrowserHistoryEntry } from '@/lib/browser/history';
import { cn } from '@/lib/utils';
import type { IconName } from '@/components/icon/icons';

/**
 * The address as the bar shows it at rest: the host in full colour, the rest
 * muted, so the site reads first. Anything that is not a plain web address
 * shows as typed.
 */
const splitAddress = (address: string): { host: string; rest: string } | null => {
  const match = /^(https?:\/\/)?([^/?#\s]+)(.*)$/i.exec(address.trim());
  if (!match) return null;
  return { host: match[2], rest: match[3] };
};

type BrowserToolbarProps = {
  address: string;
  /** A mark before the address, with its meaning: the page is inside an isolated space. */
  addressMark?: { icon: IconName; label: string };
  /** Addresses already visited in this project, offered while typing. */
  suggestions?: readonly BrowserHistoryEntry[];
  onForgetSuggestion?: (url: string) => void;
  onAddressChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Return to the running-server list in the mobile preview. */
  onHome?: () => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenExternal: () => void;
  canOpenExternal?: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  /** These need a real Chromium host; hidden without one. */
  onAnnotate?: () => void;
  onOpenDevTools?: () => void;
  isAnnotating?: boolean;
  onHardReload?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onZoomReset?: () => void;
  /** Whole percent, e.g. 110. Controls hide at 100 to keep the bar quiet. */
  zoomPercent?: number;
  onClearCookies?: () => void;
  onClearCache?: () => void;
  onToggleDeviceBar?: () => void;
  isDeviceBarOpen?: boolean;
};

export const BrowserToolbar: React.FC<BrowserToolbarProps> = ({
  address,
  addressMark,
  suggestions = [],
  onForgetSuggestion,
  onAddressChange,
  onSubmit,
  onHome,
  onBack,
  onForward,
  onReload,
  onOpenExternal,
  canOpenExternal = true,
  canGoBack,
  canGoForward,
  isLoading,
  onAnnotate,
  onOpenDevTools,
  isAnnotating,
  onHardReload,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  zoomPercent = 100,
  onClearCookies,
  onClearCache,
  onToggleDeviceBar,
  isDeviceBarOpen,
}) => {
  const { t } = useI18n();
  const [isAddressFocused, setIsAddressFocused] = React.useState(false);
  const [activeSuggestion, setActiveSuggestion] = React.useState(-1);
  const visibleSuggestions = isAddressFocused ? suggestions : [];

  // A new list is a new choice; keeping an old index would highlight whatever
  // happens to sit in that position now.
  React.useEffect(() => {
    setActiveSuggestion(-1);
  }, [address, isAddressFocused]);

  const submitAddress = (value: string) => {
    setIsAddressFocused(false);
    setActiveSuggestion(-1);
    onSubmit(value);
  };

  const onAddressKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (visibleSuggestions.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const count = visibleSuggestions.length;
      // Wraps through "nothing selected", so the typed address stays reachable.
      setActiveSuggestion((current) => {
        const next = current + step;
        if (next < -1) return count - 1;
        if (next >= count) return -1;
        return next;
      });
      return;
    }
    if (event.key === 'Escape' && activeSuggestion >= 0) {
      event.preventDefault();
      setActiveSuggestion(-1);
      return;
    }
    if (event.key === 'Enter' && activeSuggestion >= 0) {
      event.preventDefault();
      const chosen = visibleSuggestions[activeSuggestion];
      if (chosen) submitAddress(chosen.url);
    }
  };

  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const shortcut = (id: string) => formatShortcutForDisplay(getEffectiveShortcutCombo(id, shortcutOverrides), '') || undefined;
  const shownAddress = isAddressFocused ? null : splitAddress(address);

  // Used all the time, on the row; the rest waits in "More actions".
  const rowActions: ToolbarGroup = [
    onToggleDeviceBar ? { id: 'device', icon: 'smartphone', label: t('contextPanel.browser.deviceToolbar'), onSelect: onToggleDeviceBar, pressed: isDeviceBarOpen } : null,
    onAnnotate ? { id: 'annotate', icon: 'markup', label: t('contextPanel.browser.annotate.toggle'), onSelect: onAnnotate, pressed: isAnnotating } : null,
  ];
  const menuActions: ToolbarGroup = [
    { id: 'external', icon: 'external-link', label: t('contextPanel.browser.openExternal'), onSelect: onOpenExternal, disabled: !canOpenExternal },
    onHardReload ? { id: 'hard-reload', icon: 'restart', label: t('contextPanel.browser.hardReload'), onSelect: onHardReload } : null,
    onZoomIn ? { id: 'zoom-in', icon: 'zoom-in', label: t('contextPanel.browser.zoomIn'), onSelect: onZoomIn, shortcut: shortcut('zoom_in') } : null,
    onZoomOut ? { id: 'zoom-out', icon: 'zoom-out', label: t('contextPanel.browser.zoomOut'), onSelect: onZoomOut, shortcut: shortcut('zoom_out') } : null,
    onOpenDevTools ? { id: 'devtools', icon: 'terminal-box', label: t('contextPanel.browser.devTools'), onSelect: onOpenDevTools } : null,
    onClearCache ? { id: 'clear-cache', icon: 'database-2', label: t('contextPanel.browser.clearCache'), onSelect: onClearCache } : null,
    // Signs the page out of everything, so it reads as the destructive one.
    onClearCookies ? { id: 'clear-cookies', icon: 'delete-bin', label: t('contextPanel.browser.clearCookies'), onSelect: onClearCookies, destructive: true } : null,
  ];

  return (
    <div className="flex min-w-0 items-center gap-1.5 px-2 py-1.5">
      <div className="flex shrink-0 items-center gap-0.5">
        {onHome ? <ToolbarTooltipButton icon="home" label={t('contextPanel.browser.devServers.title')} onClick={onHome} /> : null}
        <ToolbarTooltipButton icon="arrow-left" label={t('contextPanel.browser.back')} onClick={onBack} disabled={!canGoBack} />
        <ToolbarTooltipButton icon="arrow-right" label={t('contextPanel.browser.forward')} onClick={onForward} disabled={!canGoForward} />
        <ToolbarTooltipButton
          icon={isLoading ? 'close' : 'refresh'}
          label={isLoading ? t('contextPanel.browser.stop') : t('contextPanel.browser.reload')}
          onClick={onReload}
        />
      </div>
      <form
        className="relative min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          submitAddress(address);
        }}
      >
        {addressMark ? (
          <span
            className="pointer-events-none absolute inset-s-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            title={addressMark.label}
            aria-label={addressMark.label}
            role="img"
          >
            <Icon name={addressMark.icon} className="size-3.5" aria-hidden="true" />
          </span>
        ) : null}
        <input
          value={address}
          onChange={(event) => onAddressChange(event.target.value)}
          onFocus={(event) => {
            setIsAddressFocused(true);
            event.currentTarget.select();
          }}
          onBlur={() => setIsAddressFocused(false)}
          onKeyDown={onAddressKeyDown}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={visibleSuggestions.length > 0}
          aria-controls="openchamber-browser-address-suggestions"
          className={cn(
            'oc-raised oc-field h-7 w-full rounded-full bg-[var(--surface-elevated)] px-3.5',
            addressMark && 'ps-8',
            zoomPercent !== 100 && 'pe-14',
            'typography-meta text-foreground outline-none',
            // At rest the styled copy below shows; the field keeps the caret and selection.
            shownAddress && 'text-transparent',
          )}
          aria-label={t('contextPanel.browser.addressAria')}
        />
        {shownAddress ? (
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute inset-y-0 inset-s-0 flex min-w-0 items-center overflow-hidden px-3.5 typography-meta',
              addressMark && 'ps-8',
              zoomPercent !== 100 ? 'inset-e-14' : 'inset-e-0',
            )}
          >
            <span className="truncate">
              <span className="text-foreground">{shownAddress.host}</span>
              <span className="text-muted-foreground">{shownAddress.rest}</span>
            </span>
          </span>
        ) : null}
        {zoomPercent !== 100 && onZoomReset ? (
          <ButtonTooltip label={t('contextPanel.browser.zoomReset')} side="bottom" className="absolute inset-e-1 top-1/2 -translate-y-1/2">
            <button
              type="button"
              onClick={onZoomReset}
              aria-label={t('contextPanel.browser.zoomReset')}
              className="h-4.5 rounded-full bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)] px-1.5 typography-micro tabular-nums text-muted-foreground hover:text-foreground"
            >
              {zoomPercent}%
            </button>
          </ButtonTooltip>
        ) : null}
        <div id="openchamber-browser-address-suggestions">
          <BrowserAddressSuggestions
            entries={visibleSuggestions}
            activeIndex={activeSuggestion}
            onSelect={submitAddress}
            onForget={(url) => onForgetSuggestion?.(url)}
            onHighlight={setActiveSuggestion}
          />
        </div>
      </form>
      <ActionToolbar
        className="shrink-0"
        groups={[rowActions]}
        menuOnly={menuActions}
        fold
      />
    </div>
  );
};
