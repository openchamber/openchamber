import React from 'react';
import type { FormField } from '@opencode/client';
import { Checkbox } from '@/components/ui/checkbox';
import { Radio } from '@/components/ui/radio';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { FORM_CUSTOM_TEXTAREA_MIN_HEIGHT, getFormCustomTextareaHeight } from './formTextareaSizing';
import { FormMarkdown } from './FormMarkdown';
import { isRecommendedOption, stripRecommendedMarker } from './formSerializers';
import { type FormValues, isAnswerableField, toFiniteNumber, valueOf } from './formCardState';

/**
 * One form field as the user answers it: label, description, and the control
 * for its type (options as radios or checkboxes with an "Other" free-text
 * entry, a text box, a number box, a yes/no checkbox, or an external link).
 * Shared by the inline card (the BTW sheet) and the composer dock, so both
 * answer a field the same way.
 */

interface AutoGrowTextareaProps {
    value: string;
    placeholder: string;
    disabled: boolean;
    autoFocus?: boolean;
    onValueChange: (value: string) => void;
    onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

/**
 * Free-text answer box. It keeps its own value while the user types so a
 * keystroke does not re-render the whole form, and grows with the content up
 * to the cap in `formTextareaSizing`.
 */
const AutoGrowTextarea = React.memo(function AutoGrowTextarea({
    value,
    placeholder,
    disabled,
    autoFocus,
    onValueChange,
    onKeyDown,
}: AutoGrowTextareaProps) {
    const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
    const [localValue, setLocalValue] = React.useState(value);
    const [height, setHeight] = React.useState(FORM_CUSTOM_TEXTAREA_MIN_HEIGHT);
    const [isScrollable, setIsScrollable] = React.useState(false);

    React.useEffect(() => {
        setLocalValue(value);
    }, [value]);

    React.useLayoutEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;
        const nextHeight = getFormCustomTextareaHeight({
            scrollHeight: textarea.scrollHeight,
            currentHeight: height,
        });
        const nextScrollable = textarea.scrollHeight > (nextHeight ?? height);
        if (isScrollable !== nextScrollable) setIsScrollable(nextScrollable);
        if (nextHeight !== null && nextHeight !== height) setHeight(nextHeight);
    }, [height, isScrollable, localValue]);

    return (
        <textarea
            ref={textareaRef}
            value={localValue}
            placeholder={placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            style={{ height }}
            onChange={(event) => {
                setLocalValue(event.target.value);
                onValueChange(event.target.value);
            }}
            onKeyDown={onKeyDown}
            className={cn(
                'w-full resize-none rounded border border-border/30 bg-background/50 px-2 py-1',
                'typography-meta text-foreground placeholder:text-muted-foreground/60',
                'focus:outline-none focus:border-border/60',
                isScrollable ? 'overflow-y-auto' : 'overflow-y-hidden',
                disabled ? 'opacity-60' : null,
            )}
        />
    );
});

export interface FormFieldControlProps {
    field: FormField;
    values: FormValues;
    /** Keys of required fields still unanswered, used to mark the label. */
    missing: string[];
    showErrors: boolean;
    isResponding: boolean;
    updateValue: (key: string, patch: Partial<FormValues[string]>) => void;
    /** Enter in a text box submits or advances; the owner decides which. */
    onTextKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

export function FormFieldControl({ field, values, missing, showErrors, isResponding, updateValue, onTextKeyDown }: FormFieldControlProps) {
const { t } = useI18n();
const value = valueOf(values, field.key);
const isMissing = showErrors && missing.includes(field.key);
const label = field.title?.trim() || field.key;

return (
        <div key={field.key} className="px-1.5 py-1">
            <div className="flex items-baseline gap-1.5">
                <span className={cn('typography-meta font-medium', isMissing ? 'text-[var(--status-error)]' : 'text-foreground')}>
                    {label}
                </span>
                {isAnswerableField(field) && field.required ? (
                    <span className="typography-micro text-muted-foreground">{t('chat.formCard.required')}</span>
                ) : null}
            </div>
            {field.description ? (
                <FormMarkdown content={field.description} size="micro" className="text-muted-foreground mb-1" />
            ) : null}

            {field.type === 'external' ? (
                <a
                    href={field.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-1 typography-meta text-primary hover:underline"
                >
                    <Icon name="external-link" className="h-3 w-3" />
                    {t('chat.formCard.openLink')}
                </a>
            ) : null}

            {field.type === 'boolean' ? (
                <button
                    type="button"
                    onClick={() => updateValue(field.key, { boolean: !value.boolean })}
                    disabled={isResponding}
                    className="flex items-center gap-2 rounded px-1 py-1 hover:bg-interactive-hover/30 transition-colors"
                >
                    <Checkbox
                        checked={value.boolean}
                        onChange={() => updateValue(field.key, { boolean: !value.boolean })}
                        disabled={isResponding}
                    />
                    <span className="typography-meta text-foreground/80">{t('chat.formCard.yes')}</span>
                </button>
            ) : null}

            {field.type === 'number' || field.type === 'integer' ? (
                <input
                    type="number"
                    inputMode={field.type === 'integer' ? 'numeric' : 'decimal'}
                    step={field.type === 'integer' ? 1 : 'any'}
                    min={toFiniteNumber(field.minimum) ?? undefined}
                    max={toFiniteNumber(field.maximum) ?? undefined}
                    value={value.number ?? ''}
                    disabled={isResponding}
                    onChange={(event) => {
                        const parsed = event.target.value === '' ? null : Number(event.target.value);
                        updateValue(field.key, { number: parsed !== null && Number.isFinite(parsed) ? parsed : null });
                    }}
                    className={cn(
                        'w-full rounded border border-border/30 bg-background/50 px-2 py-1',
                        'typography-meta text-foreground focus:outline-none focus:border-border/60',
                    )}
                />
            ) : null}

            {(field.type === 'string' || field.type === 'multiselect') && (field.options?.length ?? 0) > 0 ? (
                <div className="space-y-0.5">
                    {(field.options ?? []).map((option) => {
                        const multiple = field.type === 'multiselect';
                        const selected = !value.custom || multiple ? value.selected.includes(option.value) : false;
                        const toggle = () => {
                            if (multiple) {
                                const next = value.selected.includes(option.value)
                                    ? value.selected.filter((entry) => entry !== option.value)
                                    : [...value.selected, option.value];
                                updateValue(field.key, { selected: next });
                                return;
                            }
                            updateValue(field.key, { selected: [option.value], custom: false });
                        };
                        return (
                            <button
                                key={option.value}
                                type="button"
                                onClick={toggle}
                                disabled={isResponding}
                                className={cn(
                                    'w-full px-1.5 py-1 text-left rounded transition-colors hover:bg-interactive-hover/30',
                                    selected ? 'bg-interactive-selection/20' : null,
                                    isResponding ? 'opacity-60 cursor-not-allowed' : null,
                                )}
                            >
                                {/* The control and the label share one centred row; the
                                    description hangs under the label, so the control never
                                    depends on a line height to line up. */}
                                <div className="flex items-center gap-2">
                                    {multiple ? (
                                        <Checkbox checked={selected} onChange={toggle} disabled={isResponding} />
                                    ) : (
                                        <Radio checked={selected} onChange={toggle} disabled={isResponding} />
                                    )}
                                    <span
                                        className={cn(
                                            'typography-meta min-w-0 break-all',
                                            selected ? 'text-foreground font-medium' : 'text-foreground/80',
                                        )}
                                    >
                                        {stripRecommendedMarker(option.label)}
                                    </span>
                                    {isRecommendedOption(option.label) ? (
                                        <span className="typography-micro shrink-0 text-primary/80">
                                            {t('chat.questionCard.recommended')}
                                        </span>
                                    ) : null}
                                </div>
                                {option.description ? (
                                    <div className="typography-micro break-words pl-[22px] text-muted-foreground">
                                        {option.description}
                                    </div>
                                ) : null}
                            </button>
                        );
                    })}

                    {field.custom ? (
                        <>
                            <button
                                type="button"
                                onClick={() => updateValue(field.key, { custom: true, selected: field.type === 'multiselect' ? value.selected : [] })}
                                disabled={isResponding}
                                className={cn(
                                    'w-full px-1.5 py-1 text-left rounded transition-colors hover:bg-interactive-hover/30',
                                    value.custom ? 'bg-interactive-selection/20' : null,
                                )}
                            >
                                <div className="flex items-center gap-2">
                                    <Icon
                                        name="edit"
                                        className={cn('h-3.5 w-3.5', value.custom ? 'text-primary' : 'text-muted-foreground/50')}
                                    />
                                    <span
                                        className={cn(
                                            'typography-meta',
                                            value.custom ? 'text-foreground font-medium' : 'text-muted-foreground',
                                        )}
                                    >
                                        {t('chat.formCard.other')}
                                    </span>
                                </div>
                            </button>
                            {value.custom ? (
                                <div className="pl-6 pr-1 pt-0.5">
                                    <AutoGrowTextarea
                                        value={value.text}
                                        placeholder={t('chat.formCard.yourAnswer')}
                                        disabled={isResponding}
                                        autoFocus
                                        onValueChange={(next) => updateValue(field.key, { text: next })}
                                        onKeyDown={onTextKeyDown}
                                    />
                                </div>
                            ) : null}
                        </>
                    ) : null}
                </div>
            ) : null}

            {field.type === 'string' && (field.options?.length ?? 0) === 0 ? (
                <AutoGrowTextarea
                    value={value.text}
                    placeholder={field.placeholder ?? t('chat.formCard.yourAnswer')}
                    disabled={isResponding}
                    onValueChange={(next) => updateValue(field.key, { text: next })}
                    onKeyDown={onTextKeyDown}
                />
            ) : null}
        </div>
    );
}
