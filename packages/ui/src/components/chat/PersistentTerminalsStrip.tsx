import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { AgentTerminalRow } from '@/components/terminal/AgentTerminalRow';
import { useSessionTerminals } from '@/hooks/usePersistentTerminals';
import { useI18n } from '@/lib/i18n';

interface PersistentTerminalsStripProps {
  sessionId: string | null;
  directory?: string;
}

/**
 * Terminals the agent started with the pty tool. Sits in the composer's top rows
 * with the background commands.
 */
export const PersistentTerminalsStrip: React.FC<PersistentTerminalsStripProps> = React.memo(({ sessionId, directory }) => {
  const { t } = useI18n();
  const terminals = useSessionTerminals(sessionId ?? '');
  const [expanded, setExpanded] = React.useState(false);
  const listId = React.useId();

  if (!sessionId || !directory || terminals.length === 0) return null;

  if (terminals.length === 1) {
    return (
      <div role="group" className="border-b border-border/60" aria-label={t('chat.persistentTerminals.aria')}>
        <AgentTerminalRow pty={terminals[0]} />
      </div>
    );
  }

  return (
    <div role="group" className="border-b border-border/60" aria-label={t('chat.persistentTerminals.aria')}>
      <div className="flex h-10 items-center ps-3 pe-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setExpanded((value) => !value)}
          onMouseDown={(event) => event.preventDefault()}
          aria-expanded={expanded}
          aria-controls={expanded ? listId : undefined}
          className="min-w-0 flex-1 shrink justify-start gap-2 px-0 text-sm font-normal normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground has-[>svg]:px-0"
        >
          <Icon name="terminal-box" className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1 truncate text-start">
            {t('chat.persistentTerminals.count', { count: terminals.length })}
          </span>
          <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </div>
      {expanded ? (
        // Rows can open their output, so the list scrolls past half the
        // window instead of pushing the editor off a short screen; each
        // output scrolls inside it without moving the list or the page.
        <div id={listId} className="max-h-[50vh] overflow-y-auto overscroll-contain">
          {terminals.map((pty) => (
            <AgentTerminalRow key={pty.id} pty={pty} />
          ))}
        </div>
      ) : null}
    </div>
  );
});

PersistentTerminalsStrip.displayName = 'PersistentTerminalsStrip';
