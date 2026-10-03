import React from 'react';
import type { FormField } from '@opencode/client';
import { ComposerFloatingPanel } from './composer/ui/ComposerFloatingPanel';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import type { FormRequest } from '@/lib/opencode/model';
import { readWebSearchConsent } from '@/lib/opencode/websearch';
import { useUIStore } from '@/stores/useUIStore';
import { useScopedBlockingForms, useSessions } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';
import { useMobileAutocompleteMaxHeight } from './useMobileAutocompleteMaxHeight';
import { FormFieldControl } from './FormFieldControl';
import { WebSearchConsentDock } from './WebSearchConsent';
import { FormMarkdown } from './FormMarkdown';
import { serializeFormAsJson, serializeFormAsMarkdown } from './formSerializers';
import {
    type FormValues,
    buildFormAnswer,
    fieldAnswer,
    initialFormValues,
    isAnswerableField,
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
 * the frame's clearance and hides behind BTW like the queue does. The BTW
 * sheet keeps the inline `FormCard` for its child session's forms.
 */

interface FormDockProps {
    sessionId: string | null;
    directory?: string;
    hidden: boolean;
}

export const FormDock: React.FC<FormDockProps> = ({ sessionId, directory, hidden }) => {
    const forms = useScopedBlockingForms(sessionId, directory);
    // The session's own forms come first; a location-scoped form (an MCP
    // elicitation, owned by no session) follows and shows in every session
    // of the directory that raised it.
    const form = forms[0];
    if (hidden || !form) return null;
    const webSearchConsent = readWebSearchConsent(form);
    if (webSearchConsent) return <WebSearchConsentDock key={form.id} form={form} consent={webSearchConsent} />;
    // Keyed on the form id so a different request starts from a clean slate.
    return <FormDockPanel key={form.id} form={form} waiting={forms.length - 1} />;
};

type FormDraft = { fieldsSignature: string; values: FormValues; step: number };

// Answers in progress outlive the panel: switching sessions unmounts it, and
// coming back must find the form where it was left. Kept in memory only and
// dropped once the form is answered or dismissed.
const formDrafts = new Map<string, FormDraft>();
const MAX_FORM_DRAFTS = 50;

const saveFormDraft = (formId: string, draft: FormDraft) => {
    formDrafts.delete(formId);
    formDrafts.set(formId, draft);
    if (formDrafts.size > MAX_FORM_DRAFTS) {
        const oldest = formDrafts.keys().next().value;
        if (oldest !== undefined) formDrafts.delete(oldest);
    }
};

const isStepAnswered = (field: FormField, values: FormValues): boolean => {
    if (!isAnswerableField(field)) return valueOf(values, field.key).acknowledged;
    const answer = fieldAnswer(field, values);
    if (answer === undefined) return false;
    return !(Array.isArray(answer) && answer.length === 0);
};

const FormDockPanel: React.FC<{ form: FormRequest; waiting: number }> = ({ form, waiting }) => {
    const { t } = useI18n();
    const isMobile = useUIStore((state) => state.isMobile);
    const sessions = useSessions();
    const bodyRef = React.useRef<HTMLDivElement | null>(null);

    const fields = form.fields;
    // A rebuilt pending list hands over a new object with the same content;
    // only fields that actually changed start the answers over.
    const fieldsSignature = fields.map((field) => `${field.key}:${field.type}`).join('|');
    const [restored] = React.useState(() => {
        const draft = formDrafts.get(form.id);
        return draft?.fieldsSignature === fieldsSignature ? draft : null;
    });
    const [values, setValues] = React.useState<FormValues>(() => restored?.values ?? initialFormValues(fields));
    const [step, setStep] = React.useState(restored?.step ?? 0);
    const [collapsed, setCollapsed] = React.useState(false);
    const [isResponding, setIsResponding] = React.useState(false);
    const [showErrors, setShowErrors] = React.useState(false);

    const appliedSignatureRef = React.useRef(fieldsSignature);
    React.useEffect(() => {
        if (appliedSignatureRef.current === fieldsSignature) return;
        appliedSignatureRef.current = fieldsSignature;
        setValues(initialFormValues(fields));
        setStep(0);
        setShowErrors(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fieldsSignature]);

    React.useEffect(() => {
        if (appliedSignatureRef.current !== fieldsSignature) return;
        saveFormDraft(form.id, { fieldsSignature, values, step });
    }, [fieldsSignature, form.id, step, values]);

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
    const answered = React.useMemo(() => shown.map((field) => isStepAnswered(field, values)), [shown, values]);
    // Submit stays off while any question is still open, optional or not:
    // the agent asked, so every question gets an answer or the form is
    // dismissed.
    const allAnswered = answered.every(Boolean);
    const submitEnabled = !isResponding && allAnswered;

    const availableMaxHeight = useMobileAutocompleteMaxHeight(bodyRef, !collapsed, 320);

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
        if (!canSubmit) {
            // Jump to the first question that still needs an answer.
            setShowErrors(true);
            const firstMissing = shown.findIndex((field) => missing.includes(field.key));
            if (firstMissing >= 0) setStep(firstMissing);
            return;
        }
        setIsResponding(true);
        try {
            await sessionActions.replyToForm(form.sessionID, form.id, buildFormAnswer(fields, values));
            formDrafts.delete(form.id);
        } catch {
            toast.error(t('chat.formCard.submitFailed'), { description: t('chat.formCard.tryAgain') });
        } finally {
            setIsResponding(false);
        }
    }, [canSubmit, fields, form.id, form.sessionID, missing, shown, t, values]);

    const handleDismiss = React.useCallback(async () => {
        setIsResponding(true);
        try {
            await sessionActions.cancelForm(form.sessionID, form.id);
            formDrafts.delete(form.id);
        } catch {
            toast.error(t('chat.formCard.cancelFailed'), { description: t('chat.formCard.tryAgain') });
        } finally {
            setIsResponding(false);
        }
    }, [form.id, form.sessionID, t]);

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
    const iconButtonClass = 'rounded p-1 text-muted-foreground/70 transition-colors hover:bg-interactive-hover/30 hover:text-foreground';

    return (
        <ComposerFloatingPanel
            role="dialog"
            ariaLabel={title}
            compact={collapsed}
            header={<>
                <button
                    type="button"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? t('chat.formDock.expandAria') : t('chat.formDock.collapseAria')}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-muted-foreground transition-colors hover:text-foreground"
                >
                    <Icon name="question" className="size-3.5 shrink-0 text-primary" />
                    <Icon name={collapsed ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" />
                    <span className="typography-ui-label min-w-0 truncate text-foreground">{title}</span>
                    {isFromSubagent ? (
                        <span className="typography-micro shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-muted-foreground">
                            {t('chat.formCard.fromSubagent')}
                        </span>
                    ) : null}
                    <span className="typography-micro shrink-0 tabular-nums text-muted-foreground">
                        {t('chat.formDock.progress', { current: String(currentStep + 1), total: String(shown.length) })}
                    </span>
                </button>
                {/* One dot per question: filled when answered, the current one solid. */}
                {!collapsed ? (
                    <div className="flex shrink-0 items-center gap-1" role="tablist">
                        {shown.map((field, index) => (
                            <button
                                key={field.key}
                                type="button"
                                role="tab"
                                aria-selected={index === currentStep}
                                aria-label={t('chat.formDock.stepAria', { index: String(index + 1), title: stepLabel(field, index) })}
                                title={stepLabel(field, index)}
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
                        ))}
                    </div>
                ) : null}
                {waiting > 0 ? (
                    <span className="typography-micro shrink-0 text-muted-foreground">
                        {t('chat.formDock.waiting', { count: String(waiting) })}
                    </span>
                ) : null}
                <button type="button" onClick={() => void handleCopy('markdown')} title={t('chat.questionCard.copyMarkdown')} aria-label={t('chat.questionCard.copyMarkdown')} className={iconButtonClass}>
                    <Icon name="file-text" className="size-3" />
                </button>
                <button type="button" onClick={() => void handleCopy('json')} title={t('chat.questionCard.copyJson')} aria-label={t('chat.questionCard.copyJson')} className={iconButtonClass}>
                    <Icon name="code" className="size-3" />
                </button>
            </>}
        >
            {!collapsed ? (
                <div onKeyDown={handlePanelKeyDown}>
                    <div
                        ref={bodyRef}
                        className="max-h-[50vh] overflow-y-auto overscroll-contain px-1.5"
                        style={availableMaxHeight === undefined ? undefined : { maxHeight: Math.max(120, availableMaxHeight - 96) }}
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
                    </div>

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
