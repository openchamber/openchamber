import React from 'react';

import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { BrowserAddressSuggestions } from './BrowserAddressSuggestions';
import type { BrowserHistoryEntry } from '@/lib/browser/history';
import { cn } from '@/lib/utils';
import type { IconName } from '@/components/icon/icons';

type ToolbarButtonProps = {
  icon: IconName;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
};

const ToolbarButton: React.FC<ToolbarButtonProps> = ({ icon, label, onClick, disabled, pressed }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        type="button"
        variant={pressed ? 'secondary' : 'ghost'}
        size="xs"
        className={cn(
          'w-6 shrink-0 rounded-full px-0 text-muted-foreground',
          'hover:text-foreground',
          pressed && 'text-foreground',
        )}
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={pressed}
      >
        <Icon name={icon} className="size-3.5" aria-hidden="true" />
      </Button>
    </TooltipTrigger>
    <TooltipContent sideOffset={6}>{label}</TooltipContent>
  </Tooltip>
);

export type BrowserToolbarProps = {
  address: string;
  /** Addresses already visited in this project, offered while typing. */
  suggestions?: readonly BrowserHistoryEntry[];
  onForgetSuggestion?: (url: string) => void;
  onAddressChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onOpenExternal: () => void;
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
  suggestions = [],
  onForgetSuggestion,
  onAddressChange,
  onSubmit,
  onBack,
  onForward,
  onReload,
  onOpenExternal,
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

  return (
    <div className="flex items-center gap-1 border-b border-border bg-[var(--surface-background)] px-2 py-1">
      <ToolbarButton icon="arrow-left" label={t('contextPanel.browser.back')} onClick={onBack} disabled={!canGoBack} />
      <ToolbarButton icon="arrow-right" label={t('contextPanel.browser.forward')} onClick={onForward} disabled={!canGoForward} />
      <ToolbarButton
        icon="refresh"
        label={isLoading ? t('contextPanel.browser.stop') : t('contextPanel.browser.reload')}
        onClick={onReload}
      />
      {onHardReload ? (
        <ToolbarButton icon="restart" label={t('contextPanel.browser.hardReload')} onClick={onHardReload} />
      ) : null}
      <form
        className="relative min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          submitAddress(address);
        }}
      >
        <input
          value={address}
          onChange={(event) => onAddressChange(event.target.value)}
          onFocus={() => setIsAddressFocused(true)}
          onBlur={() => setIsAddressFocused(false)}
          onKeyDown={onAddressKeyDown}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-expanded={visibleSuggestions.length > 0}
          aria-controls="openchamber-browser-address-suggestions"
          className={cn(
            'h-6 w-full rounded-full border border-border/50 bg-[var(--surface-elevated)] px-3',
            'typography-micro text-foreground outline-none focus:border-[var(--interactive-focus-ring)]',
          )}
          aria-label={t('contextPanel.browser.addressAria')}
        />
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
      {onZoomOut && onZoomIn ? (
        <div className="flex shrink-0 items-center">
          <ToolbarButton icon="subtract" label={t('contextPanel.browser.zoomOut')} onClick={onZoomOut} />
          {zoomPercent !== 100 && onZoomReset ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="shrink-0 rounded-full px-1.5 typography-micro tabular-nums text-muted-foreground"
                  onClick={onZoomReset}
                  aria-label={t('contextPanel.browser.zoomReset')}
                >
                  {zoomPercent}%
                </Button>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{t('contextPanel.browser.zoomReset')}</TooltipContent>
            </Tooltip>
          ) : null}
          <ToolbarButton icon="add" label={t('contextPanel.browser.zoomIn')} onClick={onZoomIn} />
        </div>
      ) : null}
      {onClearCookies ? (
        <ToolbarButton icon="delete-bin" label={t('contextPanel.browser.clearCookies')} onClick={onClearCookies} />
      ) : null}
      {onClearCache ? (
        <ToolbarButton icon="database-2" label={t('contextPanel.browser.clearCache')} onClick={onClearCache} />
      ) : null}
      {onToggleDeviceBar ? (
        <ToolbarButton
          icon="smartphone"
          label={t('contextPanel.browser.deviceToolbar')}
          onClick={onToggleDeviceBar}
          pressed={isDeviceBarOpen}
        />
      ) : null}
      {onAnnotate ? (
        <ToolbarButton
          icon="cursor"
          label={t('contextPanel.browser.annotate.toggle')}
          onClick={onAnnotate}
          pressed={isAnnotating}
        />
      ) : null}
      {onOpenDevTools ? (
        <ToolbarButton icon="terminal-box" label={t('contextPanel.browser.devTools')} onClick={onOpenDevTools} />
      ) : null}
      <ToolbarButton icon="external-link" label={t('contextPanel.browser.openExternal')} onClick={onOpenExternal} />
    </div>
  );
};
