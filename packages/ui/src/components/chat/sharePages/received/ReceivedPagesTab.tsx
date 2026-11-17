import { ReceivedPagesList } from './ReceivedPagesList';
import { useOpenReceivedPage } from './openReceivedPage';

export function ReceivedPagesTab() {
  const openPage = useOpenReceivedPage();
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <ReceivedPagesList onOpen={(page, title) => openPage(page.receivedId, title)} />
    </div>
  );
}
