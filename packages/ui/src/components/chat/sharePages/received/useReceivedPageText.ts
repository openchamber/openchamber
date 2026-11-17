import React from 'react';

import { fetchReceivedPageDocument, type ReceivedPage } from '@/lib/received-pages/api';

import { openedPageAgentText, receivedPageOutline } from './pageText';

export type ReceivedPageText = { outline: string[]; agentText: string };

export function useReceivedPageText(page: ReceivedPage | null): ReceivedPageText | null {
  const [text, setText] = React.useState<{ key: string; value: ReceivedPageText } | null>(null);
  const opened = page?.opened ? page : null;
  const key = opened ? `${opened.receivedId}\n${opened.title}\n${opened.answer?.submittedAt ?? ''}\n${opened.status}` : '';

  React.useEffect(() => {
    if (!opened) return;
    let live = true;
    void (async () => {
      const html = opened.source ? null : await fetchReceivedPageDocument(opened.receivedId).catch(() => '');
      const outline = await receivedPageOutline(opened, html).catch(() => []);
      if (live) setText({ key, value: { outline, agentText: openedPageAgentText(opened, html) } });
    })();
    return () => { live = false; };
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return text && text.key === key ? text.value : null;
}
