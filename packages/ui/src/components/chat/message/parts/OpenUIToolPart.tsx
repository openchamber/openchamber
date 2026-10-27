import React from 'react';
import type { ToolPart } from '@/lib/opencode/model';
import { openuiPrompt } from '@/lib/opencode/tools';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { answerOpenUI } from '@/lib/openuiAnswer';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useUIStore } from '@/stores/useUIStore';
import { useI18n } from '@/lib/i18n';
import { useOpenUIDraft } from '../../openuiSession';
import { getLoadedOpenUIModule, loadOpenUIProgram } from '../../openuiRendererLoader';
import type { OpenUIProgramProps } from '../../OpenUIRenderer';

const EMPTY_PAGES: readonly { id: string; sessionID: string; title: string; kind?: 'openui'; sourceRevision?: string }[] = [];

const digestSource = async (source: string): Promise<string | null> => {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};

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
  const pages = useGlobalBlockingRequestsStore((state) => state.bySession.get(part.sessionID)?.pages ?? EMPTY_PAGES);
  const [revision, setRevision] = React.useState<{ source: string; value: string | null } | null>(null);
  const [failed, setFailed] = React.useState(false);
  const sourceRevision = revision?.source === prompt.source ? revision.value : null;
  const loaded = getLoadedOpenUIModule()?.OpenUIProgram;
  const requested = useOnDemandComponent(Boolean(sourceRevision) && !failed && !loaded, loadOpenUIProgram, () => setFailed(true));
  const Program = loaded ?? requested;

  React.useEffect(() => {
    setFailed(false);
  }, [prompt.source]);

  React.useEffect(() => {
    let cancelled = false;
    void digestSource(prompt.source).then((value) => {
      if (!cancelled) setRevision({ source: prompt.source, value });
    });
    return () => {
      cancelled = true;
    };
  }, [prompt.source]);

  const isLiveWait = React.useCallback(() => {
    if (!sourceRevision || part.state.status !== 'running') return false;
    const page = useGlobalBlockingRequestsStore.getState().bySession.get(part.sessionID)?.pages
      .find((entry) => entry.id === part.callID);
    return getRuntimeKey() === owner.runtimeKey
      && isDraftCurrent()
      && useUIStore.getState().agentRenderToolEnabled
      && page?.sessionID === part.sessionID
      && page.kind === 'openui'
      && page.sourceRevision === sourceRevision;
  }, [owner.runtimeKey, part.callID, part.sessionID, part.state.status, isDraftCurrent, sourceRevision]);
  const active = part.state.status === 'running' && pages.some((page) => (
    page.id === part.callID && page.sessionID === part.sessionID
    && page.kind === 'openui' && page.sourceRevision === sourceRevision
  ));
  const submit = React.useCallback<OpenUIProgramProps['submit']>(async (submission) => {
    if (!isLiveWait() || !sourceRevision) throw new Error();
    await answerOpenUI({
      sessionId: part.sessionID,
      callId: part.callID,
      sourceRevision,
      ...submission,
    }, owner.directory);
  }, [isLiveWait, owner.directory, part.callID, part.sessionID, sourceRevision]);

  const status = prompt.ask.kind === 'answered'
    ? t('chat.htmlRender.answered', { summary: prompt.ask.summary })
    : prompt.ask.kind === 'answered-in-chat'
      ? t('chat.htmlRender.answeredInChat')
      : prompt.ask.kind === 'unanswered'
        ? t('chat.htmlRender.unanswered')
        : null;

  if (!sourceRevision || !Program || failed) {
    return (
      <>
        <div data-oc-openui-source={prompt.source} data-oc-code-source={prompt.source}>
          <pre dir="ltr"><code className="language-openui-lang">{prompt.source}</code></pre>
        </div>
        {status ? <div className="text-muted-foreground typography-meta" data-export-ignore>{status}</div> : null}
      </>
    );
  }

  return (
    <>
      <div data-oc-openui-source={prompt.source} data-oc-code-source={prompt.source}>
        <Program
          key={`${draft.key}\0${sourceRevision}`}
          source={prompt.source}
          owner={owner}
          renderKey={sourceRevision}
          canInteract={isLiveWait}
          submit={submit}
          repeatable={false}
          terminal={!active}
          answer={prompt.ask.kind === 'answered' ? prompt.ask.data : undefined}
          initialState={draft.initialState}
          onStateUpdate={draft.onStateUpdate}
        />
      </div>
      {status ? <div className="text-muted-foreground typography-meta" data-export-ignore>{status}</div> : null}
      {draft.notRetained && <p className="typography-meta text-muted-foreground" data-export-ignore>{t('chat.openui.draftNotRetained')}</p>}
    </>
  );
}

/** Renders the direct OpenUI prompt represented by this tool call. */
export function ShownInterface({ part }: { part: ToolPart }) {
  const prompt = openuiPrompt(part.tool, part.state);
  return prompt ? <OpenUIToolPart part={part} prompt={prompt} /> : null;
}
