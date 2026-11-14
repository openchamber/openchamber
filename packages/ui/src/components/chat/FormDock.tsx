import React from 'react';
import { AnimatePresence } from 'motion/react';
import type { FormField } from '@opencode/client';
import { ComposerFloatingPanel } from './composer/ui/ComposerFloatingPanel';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { FormRequest } from '@/lib/opencode/model';
import type { RecoveredQuestion } from '@/sync/recoverable-questions';
import { readWebSearchConsent } from '@/lib/opencode/websearch';
import { useUIStore } from '@/stores/useUIStore';
import { useScopedBlockingForms, useRecoveredQuestions, useSessions } from '@/sync/sync-context';
import { revealWaitingPage, useRequestReveal } from '@/sync/request-reveal';
import { useChatSessionSelection } from './chatColumnSession';
import * as sessionActions from '@/sync/session-actions';
import { agentUnavailableFrom, connectionLostMessage, isFormRequestNotFoundError } from '@/sync/form-request-error';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import { FormFieldControl } from './FormFieldControl';
import { WebSearchConsentDock } from './WebSearchConsent';
import { FormMarkdown } from './FormMarkdown';
import { serializeFormAnswerAsMarkdown, serializeFormAsJson, serializeFormAsMarkdown } from './formSerializers';
import { formDraftScope, loadFormDraft, saveFormDraft, dropFormDraft } from './formDrafts';
import { noteLocalFormCancelled } from '@/sync/recoverable-questions';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import {
    type FormValues,
    buildFormAnswer,
    initialFormValues,
    isFieldAnswered,
    missingRequiredKeys,
    valueOf,
    visibleFields,
} from './formCardState';

/**
 * The agent's question, docked above the composer.
 *
 * A v2 form is one request with several typed fields, and the reply is one
 * answer for all of them. Showing every field at once made a tall card, so
 * the dock walks the fields one at a time — the same shape OpenCode's own
 * clients use — with a segment per step, Back / Next, and Submit in place
 * of Next on the last one. Fields gated by a `when` clause join or leave the
 * steps as their controlling answer changes, so the count is honest at every
 * moment. An `external` field is an information step: a link to open,
 * nothing to type; opening the step acknowledges it, which the reply must
 * carry as `true` for the server to accept it. Enter in a text box moves to the next step (Submit on
 * the last); Cmd/Ctrl+Enter submits from anywhere in the dock.
 *
 * Mounted once per composer, inside the shared floating frame, so it shares
 * the frame's clearance and hides behind an expanded BTW. The BTW
 * sheet keeps the inline `FormCard` for its child session's forms. With
 * questions set to show in the chat (`inChat`), the cards sit at the end of
 * the transcript (`TranscriptForms`) and the dock is a one-line pointer.
 */

interface FormDockProps {
    sessionId: string | null;
    directory?: string;
    hidden: boolean;
    /**
     * The chat shows the questions as cards at its end ("Questions: in the
     * chat"), so the dock is only a line that brings the reader to them.
     */
    inChat?: boolean;
}

const FormDockView: React.FC<FormDockProps> = ({ sessionId, directory, hidden, inChat = false }) => {
    const forms = useScopedBlockingForms(sessionId, directory);
    // The session's own forms come first; a location-scoped form (an MCP
    // elicitation, owned by no session) follows and shows in every session
    // of the directory that raised it.
    const form = forms[0];
    const webSearchConsent = form ? readWebSearchConsent(form) : null;
    // A question whose ask died with its turn waits behind the live requests;
    // answering it starts a new turn instead of replying to a form.
    const recovered = useRecoveredQuestions(sessionId, directory);
    const recoveredFirst = form ? undefined : recovered[0];
    if (inChat) {
        const first = form ?? recoveredFirst?.form;
        return (
            <AnimatePresence>
                {hidden || !first ? null : (
                    <FormDockPointer
                        key="in-chat"
                        sessionId={sessionId}
                        form={first}
                        formIds={[...forms.map((item) => item.id), ...recovered.map((item) => item.form.id)]}
                    />
                )}
            </AnimatePresence>
        );
    }
    // Keyed on the form id so a different request starts from a clean slate
    // (and the panels cross-fade instead of swapping content in place).
    return (
        <AnimatePresence>
            {hidden ? null : form ? (
                webSearchConsent
                    ? <WebSearchConsentDock key={form.id} form={form} consent={webSearchConsent} />
                    : <FormDockPanel key={form.id} form={form} forms={forms} directory={directory} />
            ) : recoveredFirst ? (
                <FormDockPanel
                    key={recoveredFirst.form.id}
                    form={recoveredFirst.form}
                    forms={forms}
                    directory={directory}
                    recovered={recoveredFirst}
                />
            ) : null}
        </AnimatePresence>
    );
};

/**
 * The dock while the questions sit in the chat: one line naming the first
 * question, which brings its card into view. It holds no answers, so it never
 * writes the form's draft. A full dock still shows beside or instead of a card
 * in a chat pinned in the side panel, a session whose transcript is loading and
 * an expanded composer; that dock writes the shared draft from its own state and
 * can overwrite what a card saved, as either of two docks on one form can today.
 */
const FormDockPointer: React.FC<{
    sessionId: string | null;
    form: FormRequest;
    /** Every question shown in the chat, in order; the first is `form`. */
    formIds: string[];
}> = ({ sessionId, form, formIds }) => {
    const { t } = useI18n();
    const reveal = React.useCallback((formId: string) => {
        if (sessionId) revealWaitingPage(sessionId, formId);
    }, [sessionId]);
    // "Open session" on a question's toast lands on that question's card.
    useRequestReveal(formIds, reveal);
    const title = form.title?.trim() || t('chat.formCard.inputNeeded');
    const waiting = formIds.length - 1;
    return (
        <ComposerFloatingPanel
            role="region"
            ariaLabel={title}
            compact
            header={<>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button
                            type="button"
                            onClick={() => reveal(form.id)}
                            aria-label={t('chat.formDock.showInChatAria')}
                            className="flex min-w-0 flex-1 items-center gap-2 text-start text-muted-foreground transition-colors hover:text-foreground"
                        >
                            <Icon name="question" className="size-3.5 shrink-0 text-primary" />
                            <Icon name="arrow-up-s" className="size-4 shrink-0" />
                            <span dir="auto" className="typography-ui-label min-w-0 truncate oc-ui-start-align text-foreground">{title}</span>
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{t('chat.formDock.showInChatAria')}</TooltipContent>
                </Tooltip>
                {waiting > 0 ? (
                    <span className="typography-micro shrink-0 text-muted-foreground">
                        {t('chat.formDock.waiting', { count: String(waiting) })}
                    </span>
                ) : null}
            </>}
        />
    );
};

const FormDockPanel: React.FC<{
    form: FormRequest;
    forms: FormRequest[];
    directory?: string;
    /** Set when this card re-asks a question whose turn died before it was answered. */
    recovered?: RecoveredQuestion;
}> = ({ form, forms, directory, recovered }) => {
    const { t } = useI18n();
    const isMobile = useUIStore((state) => state.isMobile);
    // The sessions of the chat this dock belongs to, which may be a chat of
    // another project pinned in the side panel.
    const sessions = useSessions(useChatSessionSelection().directory ?? undefined);
    const bodyRef = React.useRef<HTMLDivElement | null>(null);

    const fields = form.fields;
    // A rebuilt pending list hands over a new object with the same content;
    // only fields that actually changed start the answers over.
    const fieldsSignature = fields.map((field) => `${field.key}:${field.type}`).join('|');
    const draftScope = React.useMemo(() => formDraftScope(form, recovered?.directory ?? directory), [directory, form, recovered?.directory]);
    const [restored] = React.useState(() => {
        const draft = loadFormDraft(draftScope);
        return draft?.fieldsSignature === fieldsSignature ? draft : null;
    });
    const [values, setValues] = React.useState<FormValues>(() => restored?.values ?? initialFormValues(fields));
    const [step, setStep] = React.useState(restored?.step ?? 0);
    const [collapsed, setCollapsed] = React.useState(false);
    const [isResponding, setIsResponding] = React.useState(false);
    const respondingRef = React.useRef(false);
    const [showErrors, setShowErrors] = React.useState(false);
    const waiting = forms.length - 1;
    // "Open session" on a question's toast expands the dock, including for a
    // question queued behind the one shown.
    const formIds = React.useMemo(() => forms.map((item) => item.id), [forms]);
    useRequestReveal(formIds, React.useCallback(() => setCollapsed(false), []));

    const appliedSignatureRef = React.useRef(fieldsSignature);
    React.useEffect(() => {
        if (appliedSignatureRef.current === fieldsSignature) return;
        appliedSignatureRef.current = fieldsSignature;
        setValues(initialFormValues(fields));
        setStep(0);
        setShowErrors(false);
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [fieldsSignature]);

    React.useEffect(() => {
        if (appliedSignatureRef.current !== fieldsSignature) return;
        saveFormDraft(draftScope, { fieldsSignature, values, step });
    }, [draftScope, fieldsSignature, step, values]);

    const isFromSubagent = React.useMemo(() => {
        const source = sessions.find((session) => session.id === form.sessionID);
        return Boolean(source?.parentID);
    }, [form.sessionID, sessions]);

    const shown = React.useMemo(() => visibleFields(fields, values), [fields, values]);
    const missing = React.useMemo(() => missingRequiredKeys(fields, values), [fields, values]);
    const canSubmit = missing.length === 0;
    const lastStep = Math.max(0, shown.length - 1);
    const currentStep = Math.min(step, lastStep);
    const currentField = shown[currentStep];
    const answered = React.useMemo(() => shown.map((field) => isFieldAnswered(field, values)), [shown, values]);
    // Submit stays off while any question is still open, optional or not:
    // the agent asked, so every question gets an answer or the form is
    // dismissed.
    const allAnswered = answered.every(Boolean);
    const submitEnabled = !isResponding && allAnswered;

    const availableMaxHeight = useMobileAutocompleteMaxHeight(bodyRef, !collapsed, 320);

    // The phone's keyboard rises after the answer box takes focus and shrinks
    // the body under it, which leaves the box below the part still shown.
    React.useLayoutEffect(() => {
        const focused = document.activeElement;
        if (!focused || !bodyRef.current?.contains(focused)) return;
        focused.scrollIntoView({ block: 'nearest' });
    }, [availableMaxHeight]);

    const updateValue = React.useCallback((key: string, patch: Partial<FormValues[string]>) => {
        setValues((previous) => ({ ...previous, [key]: { ...valueOf(previous, key), ...patch } }));
    }, []);

    // Opening an external step is the acknowledgement OpenCode requires for
    // it (`true` in the reply); Submit stays off until every link step has
    // been opened, and a keyboard submit jumps to the first one that has not.
    const currentFieldKey = currentField?.key;
    const currentFieldIsExternal = currentField?.type === 'external';
    React.useEffect(() => {
        if (!currentFieldKey || !currentFieldIsExternal) return;
        setValues((previous) => {
            const value = valueOf(previous, currentFieldKey);
            if (value.acknowledged) return previous;
            return { ...previous, [currentFieldKey]: { ...value, acknowledged: true } };
        });
    }, [currentFieldIsExternal, currentFieldKey]);

    const handleSubmit = React.useCallback(async () => {
        if (respondingRef.current) return;
        if (!canSubmit) {
            // Jump to the first question that still needs an answer.
            setShowErrors(true);
            const firstMissing = shown.findIndex((field) => missing.includes(field.key));
            if (firstMissing >= 0) setStep(firstMissing);
            return;
        }
        respondingRef.current = true;
        setIsResponding(true);
        try {
            const answer = buildFormAnswer(fields, values);
            if (recovered) {
                await sessionActions.sendRecoveredFormAnswer(recovered, serializeFormAnswerAsMarkdown(form, answer));
            } else {
                await sessionActions.replyToForm(form.sessionID, form.id, answer);
            }
            dropFormDraft(draftScope);
        } catch (error) {
            if (!recovered && isFormRequestNotFoundError(error)) {
                dropFormDraft(draftScope);
                return;
            }
            const unavailableAgent = agentUnavailableFrom(error instanceof Error ? error : null);
            if (unavailableAgent) {
                toast.error(t('chat.chatInput.toast.agentUnavailable', { agent: unavailableAgent }));
                return;
            }
            // The reply gate refused before anything was sent, so say that
            // instead of implying the server rejected the answer. The
            // answer stays in the draft, so the retry sends it as picked.
            const connectionLost = connectionLostMessage(error instanceof Error ? error : null, t);
            if (connectionLost) {
                toast.error(connectionLost);
                return;
            }
            toast.error(t('chat.formCard.submitFailed'), { description: t('chat.formCard.tryAgain') });
        } finally {
            respondingRef.current = false;
            setIsResponding(false);
        }
    }, [canSubmit, draftScope, fields, form, missing, recovered, shown, t, values]);

    const handleDismiss = React.useCallback(async () => {
        if (respondingRef.current) return;
        respondingRef.current = true;
        setIsResponding(true);
        try {
            if (recovered) {
                noteLocalFormCancelled(recovered.form.id);
            } else {
                await sessionActions.cancelForm(form.sessionID, form.id);
            }
            dropFormDraft(draftScope);
        } catch (error) {
            if (!recovered && isFormRequestNotFoundError(error)) {
                dropFormDraft(draftScope);
                return;
            }
            const connectionLost = connectionLostMessage(error instanceof Error ? error : null, t);
            if (connectionLost) {
                toast.error(connectionLost);
                return;
            }
            toast.error(t('chat.formCard.cancelFailed'), { description: t('chat.formCard.tryAgain') });
        } finally {
            respondingRef.current = false;
            setIsResponding(false);
        }
    }, [draftScope, form.id, form.sessionID, recovered, t]);

    const goNext = React.useCallback(() => {
        setStep(Math.min(currentStep + 1, lastStep));
    }, [currentStep, lastStep]);

    const handleTextKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (isIMECompositionEvent(event)) return;
            if (event.key !== 'Enter' || event.shiftKey) return;
            if (event.ctrlKey || event.metaKey) {
                event.preventDefault();
                void handleSubmit();
                return;
            }
            if (isMobile) return;
            event.preventDefault();
            if (currentStep >= lastStep) void handleSubmit();
            else goNext();
        },
        [currentStep, goNext, handleSubmit, isMobile, lastStep],
    );

    const handlePanelKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !isIMECompositionEvent(event)) {
            event.preventDefault();
            void handleSubmit();
        }
    }, [handleSubmit]);

    const handleCopy = React.useCallback(async (format: 'markdown' | 'json') => {
        const text = format === 'markdown' ? serializeFormAsMarkdown(form) : serializeFormAsJson(form);
        const result = await copyTextToClipboard(text);
        if (result.ok) {
            toast.success(t(format === 'markdown' ? 'chat.questionCard.copiedMarkdown' : 'chat.questionCard.copiedJson'));
            return;
        }
        toast.error(t('chat.questionCard.copyFailed'));
    }, [form, t]);

    const title = form.title?.trim() || t('chat.formCard.inputNeeded');
    const stepLabel = (field: FormField, index: number) => field.title?.trim() || t('chat.questionCard.questionFallback', { index: String(index + 1) });
    const iconButtonClass = 'rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/30 hover:text-foreground';

    return (
        <ComposerFloatingPanel
            role="dialog"
            ariaLabel={title}
            compact={collapsed}
            header={<>
                <Tooltip>
                <TooltipTrigger asChild>
                <button
                    type="button"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? t('chat.formDock.expandAria') : t('chat.formDock.collapseAria')}
                    className="flex min-w-0 flex-1 items-center gap-2 text-start text-muted-foreground transition-colors hover:text-foreground"
                >
                    <Icon name="question" className="size-3.5 shrink-0 text-primary" />
                    <Icon name={collapsed ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" />
                    <span dir="auto" className="typography-ui-label min-w-0 truncate oc-ui-start-align text-foreground">{title}</span>
                    {isFromSubagent ? (
                        <span className="typography-micro shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-muted-foreground">
                            {t('chat.formCard.fromSubagent')}
                        </span>
                    ) : null}
                    <span className="typography-micro shrink-0 tabular-nums text-muted-foreground">
                        {t('chat.formDock.progress', { current: String(currentStep + 1), total: String(shown.length) })}
                    </span>
                </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>{collapsed ? t('chat.formDock.expandAria') : t('chat.formDock.collapseAria')}</TooltipContent>
                </Tooltip>
                {/* One dot per question: filled when answered, the current one solid. */}
                {!collapsed ? (
                    <div className="flex shrink-0 items-center gap-1" role="tablist">
                        {shown.map((field, index) => (
                            <Tooltip key={field.key}>
                                <TooltipTrigger asChild>
                                    <button
                                        type="button"
                                        role="tab"
                                        aria-selected={index === currentStep}
                                        aria-label={t('chat.formDock.stepAria', { index: String(index + 1), title: stepLabel(field, index) })}
                                        onClick={() => setStep(index)}
                                        className="flex size-4 items-center justify-center"
                                    >
                                        <span
                                            className={cn(
                                                'block size-1.5 rounded-full transition-colors',
                                                index === currentStep
                                                    ? 'bg-primary'
                                                    : answered[index]
                                                        ? 'bg-primary/40'
                                                        : 'bg-foreground/15',
                                            )}
                                        />
                                    </button>
                                </TooltipTrigger>
                                <TooltipContent side="top" sideOffset={6}>{stepLabel(field, index)}</TooltipContent>
                            </Tooltip>
                        ))}
                    </div>
                ) : null}
                {waiting > 0 ? (
                    <span className="typography-micro shrink-0 text-muted-foreground">
                        {t('chat.formDock.waiting', { count: String(waiting) })}
                    </span>
                ) : null}
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button type="button" onClick={() => void handleCopy('markdown')} aria-label={t('chat.questionCard.copyMarkdown')} className={iconButtonClass}>
                            <Icon name="file-text" className="size-3" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{t('chat.questionCard.copyMarkdown')}</TooltipContent>
                </Tooltip>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <button type="button" onClick={() => void handleCopy('json')} aria-label={t('chat.questionCard.copyJson')} className={iconButtonClass}>
                            <Icon name="code" className="size-3" />
                        </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{t('chat.questionCard.copyJson')}</TooltipContent>
                </Tooltip>
            </>}
        >
            {!collapsed ? (
                <div onKeyDown={handlePanelKeyDown}>
                    {recovered ? (
                        <div className="typography-micro mx-1.5 mb-1 rounded bg-[var(--status-warning-background)] px-2 py-1.5 text-[var(--status-warning-text)]">
                            {t('chat.formCard.recoveredNotice')}
                        </div>
                    ) : null}
                    <ScrollableOverlay
                        ref={bodyRef}
                        outerClassName="max-h-[50vh]"
                        outerStyle={availableMaxHeight === undefined ? undefined : { maxHeight: Math.max(120, availableMaxHeight - 96) }}
                        className="overscroll-contain px-1.5"
                        disableHorizontal
                    >
                        {currentField ? (
                            currentField.type === 'external' ? (
                                <div className="px-1.5 py-1">
                                    <div className="typography-meta font-medium text-foreground">{stepLabel(currentField, currentStep)}</div>
                                    {currentField.description ? (
                                        <FormMarkdown content={currentField.description} size="micro" className="mb-1 text-muted-foreground" />
                                    ) : null}
                                    <a
                                        href={currentField.url}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        className="typography-meta inline-flex items-center gap-1 text-primary hover:underline"
                                    >
                                        <Icon name="external-link" className="size-3" />
                                        {t('chat.formCard.openLink')}
                                    </a>
                                    <div className="typography-micro mt-1 text-muted-foreground">{t('chat.formDock.linkInfo')}</div>
                                </div>
                            ) : (
                                <FormFieldControl
                                    key={currentField.key}
                                    field={currentField}
                                    values={values}
                                    missing={missing}
                                    showErrors={showErrors}
                                    isResponding={isResponding}
                                    updateValue={updateValue}
                                    onTextKeyDown={handleTextKeyDown}
                                />
                            )
                        ) : null}
                    </ScrollableOverlay>

                    <div className="flex items-center gap-1.5 px-3 pb-2 pt-1">
                        <Button variant="ghost" size="xs" disabled={isResponding} onClick={() => void handleDismiss()}>
                            {t('chat.questionCard.dismiss')}
                        </Button>
                        {showErrors && !canSubmit ? (
                            <span className="typography-micro min-w-0 truncate text-[var(--status-error)]">{t('chat.formCard.missingRequired')}</span>
                        ) : null}
                        <div className="min-w-0 flex-1" />
                        {currentStep > 0 ? (
                            <Button variant="outline" size="xs" disabled={isResponding} onClick={() => setStep(currentStep - 1)}>
                                {t('chat.formDock.back')}
                            </Button>
                        ) : null}
                        {currentStep < lastStep ? (
                            <Button variant="outline" size="xs" disabled={isResponding} onClick={goNext}>
                                {t('chat.questionCard.next')}
                            </Button>
                        ) : (
                            <Button size="xs" disabled={!submitEnabled} onClick={() => void handleSubmit()}>
                                {isResponding ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : <Icon name="check" className="size-3.5" />}
                                {t('chat.formCard.submit')}
                            </Button>
                        )}
                    </div>
                </div>
            ) : null}
        </ComposerFloatingPanel>
    );
};

/** Memoized: the composer re-renders on every keystroke, and nothing here depends on the draft text. */
export const FormDock = React.memo(FormDockView);
