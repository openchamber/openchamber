import { ReceivedPagesList } from './ReceivedPagesList';
import { useOpenReceivedPage } from './openReceivedPage';

/** The `pages` surface with no page open: the list, each row opening its page's tab beside it. */
export function ReceivedPagesTab() {
  const openPage = useOpenReceivedPage();
  return (
    <div className="h-full min-h-0 overflow-y-auto">
      <ReceivedPagesList onOpen={(page, title) => openPage(page.receivedId, title)} />
    </div>
  );
}
