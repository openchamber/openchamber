import React from 'react';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

const LOADING_STATE_DELAY_MS = 200;

export const ContentState: React.FC<{
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
}> = ({ icon, title, description, actions, className }) => (
  <div className={cn('flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center', className)}>
    {icon}
    <div className="flex max-w-md flex-col items-center gap-1">
      <div className="max-w-full break-words typography-ui-header text-foreground">{title}</div>
      {description ? <div className="max-w-full break-words typography-ui text-muted-foreground">{description}</div> : null}
    </div>
    {actions ? <div className="flex flex-wrap items-center justify-center gap-2">{actions}</div> : null}
  </div>
);

export const ContentLoadingState: React.FC<{ label: string; className?: string }> = ({ label, className }) => {
  const [shown, setShown] = React.useState(false);
  React.useEffect(() => {
    const timer = window.setTimeout(() => setShown(true), LOADING_STATE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      role="status"
      aria-label={label}
      className={cn('flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-muted-foreground', className)}
    >
      {shown ? (
        <>
          <Spinner className="size-5" aria-hidden />
          <span className="typography-ui">{label}</span>
        </>
      ) : null}
    </div>
  );
};
