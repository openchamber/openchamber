import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { FormRequest } from '@/lib/opencode/model';
import type { WebSearchConsent, WebSearchConsentOption } from '@/lib/opencode/websearch';
import * as sessionActions from '@/sync/session-actions';
import { useSessions } from '@/sync/sync-context';
import { ComposerFloatingPanel } from './composer/ui/ComposerFloatingPanel';

/**
 * OpenCode's first-use web search question, as its own card instead of the
 * generic form. It answers the same form through the same reply path: one
 * click sends `{ [field]: option }`, "Not now" cancels the form (the search
 * fails and OpenCode asks again next time).
 *
 * The first step is allow / choose another provider / turn off; "choose"
 * makes OpenCode raise a second form listing the providers.
 */

type ChoiceValue = 'allow' | 'choose' | 'disable';

const isChoiceValue = (value: string): value is ChoiceValue =>
    value === 'allow' || value === 'choose' || value === 'disable';

const CHOICE_LABEL_KEYS = {
    allow: 'chat.webSearchConsent.allow',
    choose: 'chat.webSearchConsent.choose',
    disable: 'chat.webSearchConsent.disable',
} as const;

const CHOICE_VARIANTS = {
    allow: 'default',
    choose: 'outline',
    disable: 'ghost',
} as const;

function useConsentReply(form: FormRequest, consent: WebSearchConsent) {
    const { t } = useI18n();
    const [pending, setPending] = React.useState(false);

    const answer = React.useCallback(async (value: string) => {
        setPending(true);
        try {
            await sessionActions.replyToForm(form.sessionID, form.id, { [consent.fieldKey]: value });
        } catch {
            toast.error(t('chat.formCard.submitFailed'), { description: t('chat.formCard.tryAgain') });
        } finally {
            setPending(false);
        }
    }, [consent.fieldKey, form.id, form.sessionID, t]);

    const dismiss = React.useCallback(async () => {
        setPending(true);
        try {
            await sessionActions.cancelForm(form.sessionID, form.id);
        } catch {
            toast.error(t('chat.formCard.cancelFailed'), { description: t('chat.formCard.tryAgain') });
        } finally {
            setPending(false);
        }
    }, [form.id, form.sessionID, t]);

    return { pending, answer, dismiss };
}

const ConsentBody: React.FC<{
    consent: WebSearchConsent;
    pending: boolean;
    onAnswer: (value: string) => void;
    onDismiss: () => void;
}> = ({ consent, pending, onAnswer, onDismiss }) => {
    const { t } = useI18n();

    const renderOption = (option: WebSearchConsentOption) => {
        if (consent.step === 'choice' && isChoiceValue(option.value)) {
            return (
                <Button
                    key={option.value}
                    variant={CHOICE_VARIANTS[option.value]}
                    size="sm"
                    disabled={pending}
                    onClick={() => onAnswer(option.value)}
                >
                    {t(CHOICE_LABEL_KEYS[option.value])}
                </Button>
            );
        }
        // Provider names, or a choice this card does not know yet: OpenCode's label.
        return (
            <Button key={option.value} variant="outline" size="sm" disabled={pending} onClick={() => onAnswer(option.value)}>
                {option.label}
            </Button>
        );
    };

    return (
        <div className="space-y-2 px-3 pb-2 pt-1">
            <p className="typography-meta text-muted-foreground">
                {consent.step === 'choice' ? t('chat.webSearchConsent.explanation') : t('chat.webSearchConsent.providerExplanation')}
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
                {consent.options.map(renderOption)}
                <Button variant="ghost" size="sm" disabled={pending} onClick={onDismiss}>
                    {t('chat.webSearchConsent.notNow')}
                </Button>
                {pending ? <Icon name="loader-4" className="size-3.5 animate-spin text-muted-foreground" /> : null}
            </div>
            <p className="typography-micro text-muted-foreground/80">{t('chat.webSearchConsent.settingsHint')}</p>
        </div>
    );
};

const consentTitle = (consent: WebSearchConsent, t: ReturnType<typeof useI18n>['t']): string =>
    consent.step === 'choice' ? t('chat.webSearchConsent.title') : t('chat.webSearchConsent.providerTitle');

/** Docked above the composer, in place of `FormDock`'s generic panel. */
export const WebSearchConsentDock: React.FC<{ form: FormRequest; consent: WebSearchConsent }> = ({ form, consent }) => {
    const { t } = useI18n();
    const sessions = useSessions();
    const isFromSubagent = React.useMemo(
        () => Boolean(sessions.find((session) => session.id === form.sessionID)?.parentID),
        [form.sessionID, sessions],
    );
    const { pending, answer, dismiss } = useConsentReply(form, consent);
    const title = consentTitle(consent, t);
    return (
        <ComposerFloatingPanel
            role="dialog"
            ariaLabel={title}
            header={<>
                <Icon name="global" className="size-3.5 shrink-0 text-primary" />
                <span className="typography-ui-label min-w-0 flex-1 truncate text-foreground">{title}</span>
                {isFromSubagent ? (
                    <span className="typography-micro shrink-0 rounded bg-foreground/5 px-1.5 py-0.5 text-muted-foreground">
                        {t('chat.formCard.fromSubagent')}
                    </span>
                ) : null}
            </>}
        >
            <ConsentBody consent={consent} pending={pending} onAnswer={(value) => void answer(value)} onDismiss={() => void dismiss()} />
        </ComposerFloatingPanel>
    );
};

/** Inline variant for the BTW sheet, which renders forms as cards. */
export const WebSearchConsentCard: React.FC<{ form: FormRequest; consent: WebSearchConsent }> = ({ form, consent }) => {
    const { t } = useI18n();
    const { pending, answer, dismiss } = useConsentReply(form, consent);
    return (
        <div className="group w-full pt-0 pb-2">
            <div className="chat-column">
                <div className="-mt-1 rounded-xl border border-border/30 bg-muted/10">
                    <div className="flex items-center gap-2 border-b border-border/20 px-3 py-1.5">
                        <Icon name="global" className="size-3.5 text-primary" />
                        <span className="typography-meta font-medium text-foreground">{consentTitle(consent, t)}</span>
                    </div>
                    <ConsentBody consent={consent} pending={pending} onAnswer={(value) => void answer(value)} onDismiss={() => void dismiss()} />
                </div>
            </div>
        </div>
    );
};
