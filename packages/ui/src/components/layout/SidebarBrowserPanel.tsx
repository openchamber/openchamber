import React from 'react';
import { RiArrowRightLine, RiRefreshLine } from '@remixicon/react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { useUIStore } from '@/stores/useUIStore';

export const SidebarBrowserPanel: React.FC = () => {
  const currentUrl = useUIStore((state) => state.rightSidebarBrowserUrl);
  const setCurrentUrl = useUIStore((state) => state.setRightSidebarBrowserUrl);
  const [inputValue, setInputValue] = React.useState(currentUrl);
  const [isLoading, setIsLoading] = React.useState(false);
  const [iframeReloadKey, setIframeReloadKey] = React.useState(0);

  React.useEffect(() => {
    setInputValue(currentUrl);
  }, [currentUrl]);

  const openUrl = React.useCallback((url: string) => {
    setIsLoading(true);

    if (url === currentUrl) {
      setIframeReloadKey((value) => value + 1);
      return;
    }

    setCurrentUrl(url);
    setIframeReloadKey(0);
  }, [currentUrl, setCurrentUrl]);

  const handleSubmit = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    const trimmed = inputValue.trim();
    if (!trimmed) {
      setIsLoading(false);
      toast.error('Enter a URL.');
      return;
    }

    openUrl(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  }, [inputValue, openUrl]);

  const handleRefresh = React.useCallback(() => {
    if (!currentUrl) {
      return;
    }

    setIsLoading(true);
    setIframeReloadKey((value) => value + 1);
  }, [currentUrl]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-sidebar">
      <form onSubmit={handleSubmit} className="flex items-center gap-1.5 border-b border-border/40 px-2 py-1.5">
        <Input
          value={inputValue}
          onChange={(event) => {
            setInputValue(event.target.value);
          }}
          placeholder="Enter a URL"
          aria-label="Browser address"
          className="h-8 bg-[var(--surface-base)]"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={handleRefresh}
          disabled={!currentUrl}
          aria-label="Refresh page"
          title="Refresh"
        >
          <RiRefreshLine className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
        </Button>
        <Button
          type="submit"
          size="icon"
          className="h-8 w-8"
          aria-label="Open address"
          title="Open"
        >
          <RiArrowRightLine className="h-4 w-4" />
        </Button>
      </form>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--surface-base)]">
        {currentUrl ? (
          <>
            <iframe
              key={`${currentUrl}:${iframeReloadKey}`}
              src={currentUrl}
              title={currentUrl}
              className="h-full w-full border-0 bg-background"
              referrerPolicy="no-referrer"
              onLoad={() => {
                setIsLoading(false);
              }}
            />
            {isLoading ? (
              <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-3">
                <div className="rounded-full border border-border/50 bg-[color-mix(in_srgb,var(--surface-elevated)_92%,transparent)] px-3 py-1 typography-micro text-muted-foreground shadow-sm backdrop-blur-sm">
                  Loading
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
};
