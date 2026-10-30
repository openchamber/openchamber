import React from 'react';
import type { ToolPart } from '@/lib/opencode/model';
import { openuiPrompt } from '@/lib/opencode/tools';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { answerOpenUI } from '@/lib/openuiAnswer';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { dispatchPageWaiting } from '../../lib/scroll/timelineScrollIntent';
import { useOpenUIDraft } from '../../openuiSession';
import { getLoadedOpenUIModule, loadOpenUIProgram } from '../../openuiRendererLoader';
import type { OpenUIProgramProps } from '../../OpenUIRenderer';

function OpenUIToolPart({ part, prompt }: { part: ToolPart; prompt: NonNullable<ReturnType<typeof openuiPrompt>> }) {
  const { t } = useI18n();
  const directory = useEffectiveDirectory() ?? '';
  const runtimeKey = getRuntimeKey();
  const owner = React.useMemo(() => ({
    runtimeKey,
    directory,
    sessionId: part.sessionID,
    messageId: part.messageID,
    partId: part.id,
  }), [directory, part.id, part.messageID, part.sessionID, runtimeKey]);
  const draft = useOpenUIDraft(owner, prompt.source);
  const isDraftCurrent = draft.isCurrent;
  const [failed, setFailed] = React.useState(false);
  const loaded = getLoadedOpenUIModule()?.OpenUIProgram;
  const requested = useOnDemandComponent(!failed && !loaded, loadOpenUIProgram, () => setFailed(true));
  const Program = loaded ?? requested;

  React.useEffect(() => {
    setFailed(false);
  }, [prompt.source]);

  const waiting = prompt.ask.kind === 'waiting';
  const blockRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const block = blockRef.current;
    if (!waiting || !block) return;
    dispatchPageWaiting(block);
    const observer = new ResizeObserver(() => dispatchPageWaiting(block));
    observer.observe(block);
    return () => observer.disconnect();
  }, [waiting, part.id]);
  const canSubmit = React.useCallback(() => (
    waiting && getRuntimeKey() === owner.runtimeKey
       && isDraftCurrent()
       && useUIStore.getState().agentRenderToolEnabled
  ), [waiting, owner.runtimeKey, isDraftCurrent]);
  const submit = React.useCallback<OpenUIProgramProps['submit']>(async (submission) => {
    if (!canSubmit()) throw new Error();
    await answerOpenUI({
      sessionId: part.sessionID,
      callId: part.callID,
      ...submission,
    }, owner.directory);
  }, [canSubmit, owner.directory, part.callID, part.sessionID]);

  const status = prompt.ask.kind === 'answered'
    ? t('chat.htmlRender.answered', { summary: prompt.ask.summary })
    : prompt.ask.kind === 'answered-in-chat'
      ? t('chat.htmlRender.answeredInChat')
      : prompt.ask.kind === 'chat-sent-earlier'
        ? t('chat.htmlRender.chatSentEarlier')
        : prompt.ask.kind === 'unanswered'
          ? t('chat.htmlRender.unanswered')
          : null;

  if (!Program || failed) {
    return (
      <div ref={blockRef} data-waiting-page={waiting ? part.id : undefined}>
        <div data-oc-openui-source={prompt.source} data-oc-code-source={prompt.source}>
          <pre dir="ltr"><code className="language-openui-lang">{prompt.source}</code></pre>
        </div>
        {status ? <div className="text-muted-foreground typography-meta" data-export-ignore>{status}</div> : null}
      </div>
    );
  }

  return (
    <div ref={blockRef} data-waiting-page={waiting ? part.id : undefined}>
      <div data-oc-openui-source={prompt.source} data-oc-code-source={prompt.source}>
        <Program
          key={draft.key}
          source={prompt.source}
          owner={owner}
          renderKey={draft.key}
          canInteract={canSubmit}
          submit={submit}
          repeatable={false}
          terminal={!waiting}
          answer={prompt.ask.kind === 'answered' ? prompt.ask.data : undefined}
          initialState={draft.initialState}
          onStateUpdate={draft.onStateUpdate}
        />
      </div>
      {status ? <div className="text-muted-foreground typography-meta" data-export-ignore>{status}</div> : null}
      {draft.notRetained && <p className="typography-meta text-muted-foreground" data-export-ignore>{t('chat.openui.draftNotRetained')}</p>}
    </div>
  );
}

/** Renders the direct OpenUI prompt represented by this tool call. */
export function ShownInterface({ part }: { part: ToolPart }) {
  const prompt = openuiPrompt(part.tool, part.state);
  return prompt ? <OpenUIToolPart part={part} prompt={prompt} /> : null;
}
