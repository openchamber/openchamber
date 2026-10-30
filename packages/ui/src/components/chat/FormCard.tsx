import React from 'react';
import type { FormField } from '@opencode/client';
import { Icon } from '@/components/icon/Icon';

import { cn } from '@/lib/utils';
import { isIMECompositionEvent } from '@/lib/ime';
import { toast } from '@/components/ui';
import type { FormRequest } from '@/lib/opencode/model';
import type { RecoveredQuestion } from '@/sync/recoverable-questions';
import { noteLocalFormCancelled } from '@/sync/recoverable-questions';
import { readWebSearchConsent } from '@/lib/opencode/websearch';
import { useUIStore } from '@/stores/useUIStore';
import { useChatSessionSelection } from './chatColumnSession';
import { useSessions } from '@/sync/sync-context';
import * as sessionActions from '@/sync/session-actions';
import { isFormRequestNotFoundError } from '@/sync/form-request-error';
import { useI18n } from '@/lib/i18n';
import { copyTextToClipboard } from '@/lib/clipboard';
import { serializeFormAnswerAsMarkdown, serializeFormAsJson, serializeFormAsMarkdown } from './formSerializers';
import { dropFormDraft, formDraftScope, loadFormDraft, saveFormDraft } from './formDrafts';
import { FormFieldControl } from './FormFieldControl';
import { WebSearchConsentCard } from './WebSearchConsent';
import {
    type FormValues,
    buildFormAnswer,
    initialFormValues,
    missingRequiredKeys,
    valueOf,
    visibleFields,
} from './formCardState';

interface FormCardProps {
    form: FormRequest;
    /** Set when this card re-asks a question whose turn died before it was answered. */
    recovered?: RecoveredQuestion;
}

/**
 * The inline card for a form request, used where a dock cannot float: the
 * BTW sheet renders its child session's forms with it. The main composer
 * shows forms in `FormDock` instead, one field at a time.
 *
 * A form request is a single blocking question with typed fields, so the card
 * renders every visible field at once and submits one answer. Fields gated by
 * a `when` clause appear and disappear as their controlling field changes.
 */
export const FormCard: React.FC<FormCardProps> = ({ form, recovered }) => {
    const webSearchConsent = readWebSearchConsent(form);
    if (webSearchConsent) return <WebSearchConsentCard form={form} consent={webSearchConsent} />;
    return <GenericFormCard form={form} recovered={recovered} />;
};

const GenericFormCard: React.FC<FormCardProps> = ({ form, recovered }) => {
    const { t } = useI18n();
    const isMobile = useUIStore((state) => state.isMobile);
    const { sessionId: currentSessionId, directory: currentSessionDirectory } = useChatSessionSelection();
    const sessions = useSessions(currentSessionDirectory ?? undefined);

    const isFromSubagent = React.useMemo(() => {
        if (!currentSessionId || form.sessionID === currentSessionId) return false;
        const sourceSession = sessions.find((session) => session.id === form.sessionID);
        return Boolean(sourceSession?.parentID && sourceSession.parentID === currentSessionId);
    }, [form.sessionID, currentSessionId, sessions]);

    const fields = form.fields;
    const fieldsSignature = fields.map((field) => `${field.key}:${field.type}`).join('|');
    const recoveryDirectory = recovered?.directory;
    const draftScope = React.useMemo(
        () => (recoveryDirectory !== undefined ? formDraftScope(form, recoveryDirectory) : null),
        [form, recoveryDirectory],
    );
    const [restored] = React.useState(() => {
        const draft = draftScope ? loadFormDraft(draftScope) : null;
        return draft?.fieldsSignature === fieldsSignature ? draft : null;
    });
    // The card shows every field at once, so an external link is on screen
    // from the start and its acknowledgement travels with the reply.
    const [values, setValues] = React.useState<FormValues>(() => restored?.values ?? initialFormValues(fields, { acknowledgeExternal: true }));
    const [isResponding, setIsResponding] = React.useState(false);
    const respondingRef = React.useRef(false);
    const [hasResponded, setHasResponded] = React.useState(false);
    const [showErrors, setShowErrors] = React.useState(false);

    // The store hands the card a fresh form object whenever the pending list
    // is rebuilt (an event for another form, a bootstrap reconcile), so the
    // fields array changes identity without changing content. Resetting on
    // identity threw away half-filled answers; only a different form, or a
    // form whose fields actually changed, starts over.
    const mountedIdentityRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        const identity = `${form.id}\u0000${fieldsSignature}`;
        if (mountedIdentityRef.current === identity) return;
        const first = mountedIdentityRef.current === null;
        mountedIdentityRef.current = identity;
        // The first run needs no reset: the initial state already holds this
        // scope's restored draft.
        if (!first) setValues(initialFormValues(fields, { acknowledgeExternal: true }));
        setHasResponded(false);
        setShowErrors(false);
        // oxlint-disable-next-line react-hooks/exhaustive-deps
    }, [fieldsSignature, form.id]);

    React.useEffect(() => {
        if (!draftScope) return;
        saveFormDraft(draftScope, { fieldsSignature, values, step: 0 });
    }, [draftScope, fieldsSignature, values]);

    const shown = React.useMemo(() => visibleFields(fields, values), [fields, values]);
    const missing = React.useMemo(() => missingRequiredKeys(fields, values), [fields, values]);
    const canSubmit = missing.length === 0;

    const updateValue = React.useCallback((key: string, patch: Partial<FormValues[string]>) => {
        setValues((previous) => ({ ...previous, [key]: { ...valueOf(previous, key), ...patch } }));
    }, []);

    const handleSubmit = React.useCallback(async () => {
        if (respondingRef.current) return;
        if (!canSubmit) {
            setShowErrors(true);
            return;
        }
        respondingRef.current = true;
        setIsResponding(true);
        try {
            const answer = buildFormAnswer(fields, values);
            if (recovered) {
                await sessionActions.sendRecoveredFormAnswer(recovered, serializeFormAnswerAsMarkdown(form, answer));
                if (draftScope) dropFormDraft(draftScope);
            } else {
                await sessionActions.replyToForm(form.sessionID, form.id, answer);
            }
            setHasResponded(true);
        } catch (error) {
            // The store removes not-found requests, so no card remains to retry.
            if (!recovered && isFormRequestNotFoundError(error)) {
                setHasResponded(true);
                return;
            }
            toast.error(t('chat.formCard.submitFailed'), { description: t('chat.formCard.tryAgain') });
        } finally {
            respondingRef.current = false;
            setIsResponding(false);
        }
    }, [canSubmit, draftScope, fields, form, recovered, t, values]);

    const handleCancel = React.useCallback(async () => {
        if (respondingRef.current) return;
        respondingRef.current = true;
        setIsResponding(true);
        try {
            if (recovered) {
                noteLocalFormCancelled(recovered.form.id);
                if (draftScope) dropFormDraft(draftScope);
            } else {
                await sessionActions.cancelForm(form.sessionID, form.id);
            }
            setHasResponded(true);
        } catch (error) {
            if (isFormRequestNotFoundError(error)) {
                setHasResponded(true);
                return;
            }
            toast.error(t('chat.formCard.cancelFailed'), { description: t('chat.formCard.tryAgain') });
        } finally {
            respondingRef.current = false;
            setIsResponding(false);
        }
    }, [draftScope, form.id, form.sessionID, recovered, t]);

    const handleKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
            if (isIMECompositionEvent(event)) return;
            if (event.key === 'Enter' && !event.shiftKey && (!isMobile || event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void handleSubmit();
            }
        },
        [handleSubmit, isMobile],
    );

    const renderField = (field: FormField) => (
        <FormFieldControl
            key={field.key}
            field={field}
            values={values}
            missing={missing}
            showErrors={showErrors}
            isResponding={isResponding}
            updateValue={updateValue}
            onTextKeyDown={handleKeyDown}
        />
    );

    // The question travels to other tools as Markdown (to read) or JSON (to
    // feed a script); both leave the routing ids behind.
    const handleCopy = React.useCallback(async (format: 'markdown' | 'json') => {
        const text = format === 'markdown' ? serializeFormAsMarkdown(form) : serializeFormAsJson(form);
        const result = await copyTextToClipboard(text);
        if (result.ok) {
            toast.success(t(format === 'markdown' ? 'chat.questionCard.copiedMarkdown' : 'chat.questionCard.copiedJson'));
            return;
        }
        toast.error(t('chat.questionCard.copyFailed'));
    }, [form, t]);

    if (hasResponded || fields.length === 0) return null;

    return (
        <div className="group w-full pt-0 pb-2">
            <div className="chat-column">
                <div className="-mt-1 border border-edge-muted rounded-xl bg-muted/10">
                    <div className="px-2 py-1.5 border-b border-edge-muted">
                        <div className="flex items-center gap-2">
                            <Icon name="question" className="h-3.5 w-3.5 text-primary" />
                            <span className="typography-meta font-medium text-foreground">
                                {form.title?.trim() || t('chat.formCard.inputNeeded')}
                            </span>
                            {isFromSubagent ? (
                                <span className="typography-micro text-muted-foreground px-1.5 py-0.5 rounded bg-foreground/5">
                                    {t('chat.formCard.fromSubagent')}
                                </span>
                            ) : null}
                            <div className="ms-auto flex items-center gap-0.5">
                                <button
                                    type="button"
                                    onClick={() => void handleCopy('markdown')}
                                    title={t('chat.questionCard.copyMarkdown')}
                                    aria-label={t('chat.questionCard.copyMarkdown')}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/30 hover:text-foreground"
                                >
                                    <Icon name="file-text" className="h-3 w-3" />
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void handleCopy('json')}
                                    title={t('chat.questionCard.copyJson')}
                                    aria-label={t('chat.questionCard.copyJson')}
                                    className="rounded p-1 text-muted-foreground transition-colors hover:bg-interactive-hover/30 hover:text-foreground"
                                >
                                    <Icon name="code" className="h-3 w-3" />
                                </button>
                            </div>
                        </div>
                    </div>

                    {recovered ? (
                        <div className="typography-micro bg-[var(--status-warning-background)] px-2 py-1.5 text-[var(--status-warning-text)]">
                            {t('chat.formCard.recoveredNotice')}
                        </div>
                    ) : null}

                    <div className="px-2 py-2 space-y-1">{shown.map(renderField)}</div>

                    <div className="px-2 pb-1.5 pt-1 flex items-center gap-1.5 border-t border-edge-muted">
                        <button
                            type="button"
                            onClick={() => void handleSubmit()}
                            disabled={isResponding}
                            className={cn(
                                'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-colors',
                                'bg-[var(--status-success)]/10 text-[var(--status-success)] hover:bg-[var(--status-success)]/20',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                            )}
                        >
                            <Icon name="check" className="h-3 w-3" />
                            {t('chat.formCard.submit')}
                        </button>

                        <button
                            type="button"
                            onClick={() => void handleCancel()}
                            disabled={isResponding}
                            className={cn(
                                'flex items-center gap-1 px-2 py-1 typography-meta font-medium rounded transition-colors',
                                'bg-[var(--status-error)]/10 text-[var(--status-error)] hover:bg-[var(--status-error)]/20',
                                'disabled:opacity-50 disabled:cursor-not-allowed',
                            )}
                        >
                            <Icon name="close" className="h-3 w-3" />
                            {t('chat.formCard.cancel')}
                        </button>

                        {showErrors && !canSubmit ? (
                            <span className="typography-micro text-[var(--status-error)]">
                                {t('chat.formCard.missingRequired')}
                            </span>
                        ) : null}

                        {isResponding ? (
                            <div className="ms-auto">
                                <div className="animate-spin h-3 w-3 border border-primary border-t-transparent rounded-full" />
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
};
