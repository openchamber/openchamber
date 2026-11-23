import { ReceivedPagesList } from './ReceivedPagesList';
import { useOpenReceivedPage } from './openReceivedPage';
import { useReceivedPagesStore } from './receivedPagesStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useListScrollMemory } from '@/hooks/useListScrollMemory';

export function ReceivedPagesTab() {
  const openPage = useOpenReceivedPage();
  const pages = useReceivedPagesStore((state) => state.pages);
  const scrollerRef = useListScrollMemory(`received-pages:${getRuntimeKey()}`, { ready: pages !== null });
  return (
    <div ref={scrollerRef} className="h-full min-h-0 overflow-y-auto">
      <ReceivedPagesList onOpen={(page, title) => openPage(page.receivedId, title)} />
    </div>
  );
}
