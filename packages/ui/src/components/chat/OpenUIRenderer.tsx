import React from 'react';
import { Renderer, type ActionEvent, type RendererProps } from '@openuidev/react-lang';
import { z } from 'zod';
import type { JsonValue } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { sendOpenUIResponse } from '@/sync/session-ui-store';
import { isExternalHttpUrl } from '@/lib/url';
import { chamberLibrary } from './openui/openuiCatalog';
import { deriveOpenUIComponentSlots, inspectOpenUIProgram, walkRenderedOpenUINodes } from '../../../../web/shared/openui/program.js';
import { renderPageImageSources } from './message/parts/renderPageImages';
import { OpenUITheme } from './openui/openuiTheme';
import {
  OpenUIHostContext,
  type OpenUIHost,
  type OpenUIOwner,
  type OpenUISubmission,
  type OpenUISubmissionState,
  type OpenUIAccess,
} from './openui/openuiHost';
import type { OpenUIFenceMount } from './markdown/openuiMarkdownContext';
import { useOpenUIDraft } from './openuiSession';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { useOpenChatLink } from './useOpenChatLink';
import { isAmbiguousSendFailure } from '@/sync/send-failure-classification';
import { nativeOpenUIImageSources } from '../../../../web/shared/openui/media.js';
import { OpenUIMediaPreview } from './openui/openuiMedia';

type Snapshot = NonNullable<RendererProps['initialState']>;
const json = z.json();
const schema = chamberLibrary.toJSONSchema();
const componentSlots = deriveOpenUIComponentSlots(schema);
const fieldEnvelope = z.object({ value: json, componentType: z.string() });
const formFields = z.record(z.string(), json);
type NativeAnswerData = { params: JsonValue; formName?: string; formValues?: JsonValue };

/** Only known field positions contain vendor envelopes; nested user data does not. */
function submittedFields(value: JsonValue): JsonValue {
  const fields = formFields.safeParse(value);
  if (!fields.success) return value;
  return Object.fromEntries(Object.entries(fields.data).map(([name, child]) => {
    const field = fieldEnvelope.safeParse(child);
    return [name, field.success ? field.data.value : child];
  }));
}

function nativeSubmission(event: ActionEvent): OpenUISubmission {
  // Dates and other vendor field values use the same JSON representation as
  // the eventual tool result; the live restoration snapshot stays untouched.
  let values = json.parse(JSON.parse(JSON.stringify(event.formState ?? null)));
  const data: NativeAnswerData = {
    params: json.parse(JSON.parse(JSON.stringify(event.params))),
  };
  if (event.formName) data.formName = event.formName;
  const fields = formFields.safeParse(values);
  if (fields.success) {
    if (event.formName && event.formName in fields.data) values = fields.data[event.formName];
    else if (!event.formName) {
      values = Object.fromEntries(Object.entries(fields.data).filter(([name, value]) => (
        name.startsWith('$') || fieldEnvelope.safeParse(value).success
      )));
    }
  }
  if (values !== null) data.formValues = submittedFields(values);
  return { summary: event.humanFriendlyMessage ?? '', data };
}

export interface OpenUIProgramProps {
  source: string;
  isStreaming?: boolean;
  owner: OpenUIOwner;
  renderKey: string;
  canInteract: () => boolean;
  submit: (submission: OpenUISubmission, isCurrent: () => boolean) => Promise<void>;
  repeatable: boolean;
  terminal?: boolean;
  answer?: JsonValue;
  initialState?: Snapshot;
  onStateUpdate?: RendererProps['onStateUpdate'];
}

export function OpenUIProgram({
  source,
  isStreaming = false,
  owner,
  renderKey,
  canInteract,
  submit: deliver,
  repeatable,
  terminal = false,
  answer,
  initialState,
  onStateUpdate,
}: OpenUIProgramProps) {
  const { t } = useI18n();
  const openLink = useOpenChatLink(owner.directory);
  const instanceId = React.useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const program = React.useMemo(() => isStreaming ? null : inspectOpenUIProgram(source, schema, componentSlots), [source, isStreaming]);
  const initialMediaSources = React.useMemo(() => program?.valid
    ? walkRenderedOpenUINodes(program.root, componentSlots).flatMap((node) => {
      if (node.typeName === 'HtmlView') {
        const html = z.string().safeParse(node.props.html);
        return html.success ? renderPageImageSources(html.data) : [];
      }
      return nativeOpenUIImageSources(node);
    }) : [], [program]);
  const [submission, renderSubmission] = React.useState<OpenUISubmissionState>({ kind: 'ready', answer: null });
  // Events read the same transition synchronously, before React can render it.
  const submissionRef = React.useRef(submission);
  const setSubmission = React.useCallback((next: OpenUISubmissionState, render = true) => {
    submissionRef.current = next;
    if (render) renderSubmission(next);
  }, []);
  const active = React.useRef(true);
  const [, refreshInteraction] = React.useReducer((version: number) => version + 1, 0);
  React.useLayoutEffect(() => {
    const reconnecting = !active.current;
    active.current = true;
    // Activity keeps the controls but disconnects this effect. Their first
    // restored render still sees the revoked mount; refresh the gate before
    // paint after reconnecting, while stale callbacks stay blocked when hidden.
    if (reconnecting) {
      renderSubmission(submissionRef.current);
      refreshInteraction();
    }
    return () => { active.current = false; };
  }, []);
  const enabled = useUIStore((state) => state.agentRenderToolEnabled);
  const [failedSource, setFailedSource] = React.useState<string | null>(null);
  const renderError = failedSource === source;
  const valid = program?.valid === true && !renderError;
  const latest = React.useRef({ renderKey, canInteract, terminal, deliver, repeatable, valid });
  latest.current = { renderKey, canInteract, terminal, deliver, repeatable, valid };

  const isCurrentMount = React.useCallback(() => (
    active.current && latest.current.renderKey === renderKey
    && getRuntimeKey() === owner.runtimeKey
  ), [renderKey, owner.runtimeKey]);
  const current = React.useCallback(() => (
    isCurrentMount() && latest.current.valid && latest.current.canInteract()
    && useUIStore.getState().agentRenderToolEnabled
  ), [isCurrentMount]);

  const submit = React.useCallback(async (payload: OpenUISubmission) => {
    if (!current() || latest.current.terminal || (!latest.current.repeatable && submissionRef.current.kind === 'accepted')) {
      throw new Error(t('chat.openui.cancelled'));
    }
    if (submissionRef.current.kind === 'pending') throw new Error(t('chat.openui.sending'));
    if (!payload.summary.trim() || payload.summary.length > 500 || JSON.stringify(payload.data).length > 16000) {
      throw new Error(t('chat.openui.submissionFailed'));
    }
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      throw new Error(t('chat.openui.submissionFailed'));
    }
    setSubmission({ kind: 'pending', answer: answer ?? null });
    try {
      await latest.current.deliver(payload, current);
      // The authoritative wait can settle before its HTTP answer arrives. That
      // expected transition must not discard this client's accepted receipt.
      if (latest.current.renderKey === renderKey) {
        setSubmission({ kind: 'accepted', answer: payload.data }, isCurrentMount());
      }
    } catch (error) {
      const uncertain = isAmbiguousSendFailure(error);
      if (latest.current.renderKey === renderKey) setSubmission({
        kind: 'error',
        message: t(uncertain ? 'chat.openui.deliveryUncertain' : 'chat.openui.submissionFailed'),
        answer: answer ?? null,
      }, isCurrentMount());
      throw error;
    }
  }, [current, isCurrentMount, t, answer, setSubmission, renderKey]);

  const access: OpenUIAccess = isStreaming ? { kind: 'preview' }
    : !enabled || !valid ? { kind: 'revoked' }
    : terminal || (!repeatable && submission.kind === 'accepted')
      ? { kind: 'readonly', reason: t('chat.openui.cancelled') }
      : !canInteract() ? { kind: 'revoked' } : { kind: 'interactive' };
  const host: OpenUIHost = {
    owner,
    renderKey,
    initialMediaSources,
    canInteract: () => current() && !latest.current.terminal
      && submissionRef.current.kind !== 'pending'
      && (latest.current.repeatable || submissionRef.current.kind !== 'accepted'),
    submit,
    submission,
    access,
    answer: answer ?? submission.answer,
  };
  const mount = { host, occurrence: 'root' };
  const handleAction = (event: ActionEvent) => {
    if (!current()) return;
    if (event.type === 'open_url') {
      if (navigator.userActivation && !navigator.userActivation.isActive) return;
      const url = z.object({ url: z.string() }).safeParse(event.params);
      if (url.success && isExternalHttpUrl(url.data.url)) openLink(url.data.url);
      return;
    }
    if (event.type !== 'continue_conversation') return;
    try {
      void submit(nativeSubmission(event)).catch(() => {});
    } catch {
      setSubmission({ kind: 'error', message: t('chat.openui.submissionFailed'), answer: null });
    }
  };

  const sourcePreview = (invalid: boolean) => (
    <div>
      {invalid && <p className="text-muted-foreground">{t('chat.openui.invalid')}</p>}
      <pre dir="ltr"><code className="language-openui-lang">{source}</code></pre>
    </div>
  );
  if (!enabled || access.kind === 'revoked') {
    return sourcePreview(!isStreaming && !valid);
  }
  return (
    <OpenUIHostContext.Provider value={mount}>
      <div id={`oc-openui-${instanceId}`}>
        <ErrorBoundary key={renderKey} fallback={sourcePreview(true)}>
          <OpenUITheme cssSelector={`#oc-openui-${instanceId}`}>
            <OpenUIMediaPreview renderKey={renderKey} owner={owner}>
              <div className="openui-scope">
                <Renderer
                  response={source}
                  library={chamberLibrary}
                  isStreaming={isStreaming}
                  publishObservability={false}
                  initialState={initialState}
                  onStateUpdate={onStateUpdate}
                  onAction={handleAction}
                  onError={(errors) => {
                    if (!isStreaming && errors.some((error) => error.severity !== 'warning')) setFailedSource(source);
                  }}
                />
              </div>
            </OpenUIMediaPreview>
          </OpenUITheme>
        </ErrorBoundary>
      </div>
      <div className="min-h-5 text-muted-foreground typography-meta" aria-live="polite" data-export-ignore>
        {submission.kind === 'pending' ? t('chat.openui.sending')
          : submission.kind === 'accepted' ? t('chat.openui.sent')
            : submission.kind === 'error' ? submission.message : null}
      </div>
    </OpenUIHostContext.Provider>
  );
}

export function OpenUIRenderer({ mount }: { mount: OpenUIFenceMount }) {
  const { t } = useI18n();
  const draft = useOpenUIDraft(mount.owner, mount.canonical, mount.fence.start);
  return (
    <>
      <OpenUIProgram
        key={draft.key}
        source={mount.fence.code}
        isStreaming={mount.isStreaming}
        owner={mount.owner}
        renderKey={draft.key}
        canInteract={() => mount.canInteract() && draft.isCurrent()}
        submit={(payload, isCurrent) => sendOpenUIResponse({ ...mount.owner, ...payload, isCurrent })}
        repeatable
        initialState={draft.initialState}
        onStateUpdate={draft.onStateUpdate}
      />
      {draft.notRetained && <p className="typography-meta text-muted-foreground" data-export-ignore>{t('chat.openui.draftNotRetained')}</p>}
    </>
  );
}
