import React from 'react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

/** A JSON body pretty-printed; anything else as the provider sent it. */
const formatResponseBody = (body: string): string => {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
};

/**
 * The raw provider response behind a failed turn, collapsed by default. The
 * short message above it is what most people need; the body is there for the
 * cases where that message says too little (an unrecognised error code, a
 * proxy's HTML page).
 */
export const ErrorResponseDetails: React.FC<{ body: string; className?: string }> = ({ body, className }) => {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);

  return (
    <div className={className}>
      <Button
        variant="link"
        size="xs"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="-ml-2 normal-case"
      >
        {open ? t('chat.errorDetails.hide') : t('chat.errorDetails.show')}
      </Button>
      {open ? (
        <pre className="mt-1 max-h-60 overflow-auto rounded-md bg-muted/30 px-2 py-1 typography-meta font-mono text-muted-foreground whitespace-pre-wrap break-all">
          {formatResponseBody(body)}
        </pre>
      ) : null}
    </div>
  );
};
