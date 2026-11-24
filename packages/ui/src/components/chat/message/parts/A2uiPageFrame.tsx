import React from 'react';
import { toast } from '@/components/ui';
import { dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { useI18n } from '@/lib/i18n';
import type { ToolPart } from '@/lib/opencode/model';
import type { RenderedPageAsk } from '@/lib/opencode/tools';
import { answerRenderedPage } from '@/lib/renderPageAnswer';
import { a2uiAnswerDataSchema, type A2uiPageSubmission } from '../../a2ui/answer';
import type { A2uiHost } from '../../a2ui/A2uiSurface';
import { useA2uiSurfaceComponent } from '../../a2ui/useA2uiComponent';
import { DeclinePageButton } from './DeclinePageButton';
import { usePageDecline } from './usePageDecline';
import { PageAskStatus } from './PageAskStatus';
import { pageBlocksTurn } from './usePageAsk';

export function A2uiPageFrame({ part, source, ask }: { part: ToolPart; source: string; ask: RenderedPageAsk }) {
  const { t } = useI18n();
  const A2uiSurface = useA2uiSurfaceComponent();
  const [sentSummary, setSentSummary] = React.useState<string | null>(null);
  const { sessionID, callID } = part;
  const [decline, sendDecline] = usePageDecline(sessionID, callID);
  const waiting = ask.kind === 'waiting' && sentSummary === null && decline !== 'declined';
  const blocking = waiting && pageBlocksTurn(ask);

  const submit = React.useCallback(
    async (submission: A2uiPageSubmission) => {
      try {
        await answerRenderedPage({
          sessionId: sessionID,
          callId: callID,
          summary: submission.summary,
          data: submission.data,
        });
        setSentSummary(submission.summary);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        toast.error(t('chat.htmlRender.answerFailed'), { description: message });
        throw error;
      }
    },
    [callID, sessionID, t],
  );

  const host = React.useMemo<A2uiHost>(() => {
    const answered = ask.kind === 'answered' ? a2uiAnswerDataSchema.safeParse(ask.data) : null;
    return {
      kind: 'page',
      submit: waiting && decline === 'idle' ? submit : null,
      answered: answered?.success ? answered.data : null,
    };
  }, [ask, waiting, decline, submit]);

  const reported = React.useRef(false);
  const reportNotDrawn = React.useCallback(
    (errors: string[]) => {
      if (!waiting || reported.current) return;
      reported.current = true;
      void answerRenderedPage({ sessionId: sessionID, callId: callID, notDrawn: errors }).catch(() => {});
    },
    [waiting, sessionID, callID],
  );

  const blockRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (blocking) dispatchPageWaiting(blockRef.current);
  }, [blocking]);

  return (
    <div
      ref={blockRef}
      className="my-2"
      data-a2ui-render-part={part.id}
      data-a2ui-render-message={part.messageID}
      data-waiting-page={blocking ? part.id : undefined}
    >
      {A2uiSurface ? (
        <A2uiSurface
          source={source}
          complete
          host={host}
          onNotDrawn={reportNotDrawn}
          actions={waiting ? <DeclinePageButton onDecline={sendDecline} disabled={decline === 'sending'} /> : null}
        />
      ) : (
        <pre dir="ltr" data-chat-quote-pending="true">
          <code>{source}</code>
        </pre>
      )}
      <PageAskStatus
        ask={decline === 'declined' && ask.kind === 'waiting' ? { kind: 'declined' } : ask}
        answeredSummary={ask.kind === 'answered' ? ask.summary : sentSummary ?? undefined}
      />
    </div>
  );
}
