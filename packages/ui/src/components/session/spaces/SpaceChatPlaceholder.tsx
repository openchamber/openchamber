/**
 * What the chat shows for a session of a space that cannot answer now: stopped, its container
 * gone, or its machine out of reach. Its messages live inside the space, so a load would only wait
 * for a timeout and end in a load error. A stopped space offers Start here; the chat loads by
 * itself once the journey list says the space runs, because `ChatContainer` holds the load while
 * this shows. The other states say why, with the repair their status line offers.
 */

import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { spaceIdOfDirectory } from '@/lib/spaces/space-route';
import { runSpaceAction, spaceMenuActionsOf } from '@/lib/spaces/space-repair';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { SpaceStatusLines } from './SpaceStatus';

export const SpaceChatPlaceholder: React.FC<{ directory: string }> = ({ directory }) => {
  const { t } = useI18n();
  const spaceId = spaceIdOfDirectory(directory);
  const entry = useSpacesStore((state) => (spaceId ? state.journey?.get(spaceId) : undefined));
  const action = useSpacesStore((state) => (spaceId ? state.actions.get(spaceId) : undefined));
  if (!spaceId || !entry) return null;
  const stopped = entry.state === 'exited';
  // Start stands as the one button while nothing runs or failed; once it runs, or failed, the
  // status line says so, a failure with the way to try again.
  const offersStart = stopped && action === undefined && spaceMenuActionsOf(entry).includes('start');
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6" data-space-chat-placeholder={spaceId}>
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-3 flex size-9 items-center justify-center rounded-full bg-[color-mix(in_srgb,currentColor_10%,transparent)] text-muted-foreground">
          <Icon name="instance" className="size-4" />
        </div>
        <p className="typography-ui-label font-medium text-foreground">
          {t(stopped ? 'spaces.chat.stopped.title' : 'spaces.chat.unavailable.title')}
        </p>
        {offersStart ? (
          <>
            <p className="typography-meta mt-1 text-muted-foreground">{t('spaces.chat.stopped.description')}</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => void runSpaceAction(spaceId, 'start')}>
              {t('spaces.actions.start')}
            </Button>
          </>
        ) : (
          <SpaceStatusLines spaceId={spaceId} className="mt-3 items-center text-start" hideStopped={stopped && action === undefined} />
        )}
      </div>
    </div>
  );
};
