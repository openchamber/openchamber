/**
 * Pure form logic behind `FormCard`.
 *
 * OpenCode v2 replaced the old multi-question prompt with a typed form: one
 * request carries a title and an ordered list of fields, and the reply is a
 * single `{ [key]: value }` answer. Everything that decides what the card
 * shows and whether it can be submitted lives here so it can be tested without
 * rendering, and so the component stays a view.
 */

import type { FormField, FormValue } from '@opencode/client';

/**
 * The value a field currently holds in the card.
 *
 * `custom` marks a select field whose user typed their own answer instead of
 * picking an option, so re-selecting an option can clear the typed text.
 * `acknowledged` is the only state an `external` field has: OpenCode accepts
 * a reply only when every external field answers `true`, so it records that
 * the user has seen the step with the link.
 */
export type FieldValue = {
    text: string;
    number: number | null;
    boolean: boolean;
    selected: string[];
    custom: boolean;
    acknowledged: boolean;
};

export type FormValues = Record<string, FieldValue>;

/** Fields whose value the user edits; `external` only links out. */
export type AnswerableField = Exclude<FormField, { type: 'external' }>;

export const isAnswerableField = (field: FormField): field is AnswerableField => field.type !== 'external';

/**
 * Numeric bounds and defaults arrive as either a number or one of the JSON
 * stand-ins for values JSON cannot hold. The stand-ins are not usable as a
 * starting value or a bound, so they read as absent.
 */
export const toFiniteNumber = (value: number | 'Infinity' | '-Infinity' | 'NaN' | undefined): number | null => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value;
};

const emptyValue = (): FieldValue => ({
    text: '',
    number: null,
    boolean: false,
    selected: [],
    custom: false,
    acknowledged: false,
});

export type InitialFormValuesOptions = {
    /**
     * Whether external fields start acknowledged. A surface that shows every
     * field at once (the inline card) has shown the link by the time the user
     * can submit; a stepped surface acknowledges each link as its step opens.
     */
    acknowledgeExternal?: boolean;
};

/** The card's starting state: every field seeded from its declared default. */
export function initialFormValues(fields: readonly FormField[], options: InitialFormValuesOptions = {}): FormValues {
    const values: FormValues = {};
    for (const field of fields) {
        const value = emptyValue();
        if (!isAnswerableField(field)) {
            value.acknowledged = options.acknowledgeExternal === true;
            values[field.key] = value;
            continue;
        }
        switch (field.type) {
            case 'string':
                if (field.default !== undefined) {
                    // A default that names an option selects it; otherwise it is typed text.
                    if (field.options?.some((option) => option.value === field.default)) {
                        value.selected = [field.default];
                    } else {
                        value.text = field.default;
                        value.custom = Boolean(field.options?.length);
                    }
                }
                break;
            case 'number':
            case 'integer':
                value.number = toFiniteNumber(field.default);
                break;
            case 'boolean':
                value.boolean = field.default ?? false;
                break;
            case 'multiselect':
                value.selected = field.default ? [...field.default] : [];
                break;
        }
        values[field.key] = value;
    }
    return values;
}

export const valueOf = (values: FormValues, key: string): FieldValue => values[key] ?? emptyValue();

/** The answer a single field contributes, or `undefined` when it has none yet. */
export function fieldAnswer(field: AnswerableField, values: FormValues): FormValue | undefined {
    const value = valueOf(values, field.key);
    switch (field.type) {
        case 'string': {
            if (field.options?.length && !value.custom) {
                return value.selected[0];
            }
            const text = value.text.trim();
            return text.length > 0 ? text : undefined;
        }
        case 'number':
        case 'integer':
            return value.number ?? undefined;
        case 'boolean':
            return value.boolean;
        case 'multiselect': {
            const selected = [...value.selected];
            const custom = value.text.trim();
            if (value.custom && custom.length > 0) selected.push(custom);
            return selected.length > 0 ? selected : undefined;
        }
    }
}

/** What the form resolves to right now: the fields the user sees and the reply they add up to. */
export type FormEvaluation = {
    /** Fields shown to the user, in declaration order. */
    active: FormField[];
    /** The reply so far: an answer per answered active field, `true` per acknowledged external field. */
    answer: Record<string, FormValue>;
};

/**
 * Mirrors OpenCode's `matches()` (`packages/core/src/form.ts`): a clause
 * against an unanswered field is false for both `eq` and `neq`. Combined with
 * inactive fields contributing no answer, hiding a field hides every field
 * that depends on it, however long the chain.
 */
const clauseMatches = (clause: NonNullable<AnswerableField['when']>[number], answer: FormValue | undefined): boolean => {
    if (answer === undefined) return false;
    const hit = Array.isArray(answer) ? answer.some((entry) => entry === clause.value) : answer === clause.value;
    return clause.op === 'eq' ? hit : !hit;
};

/**
 * Walks the fields in declaration order the way the server validates a reply:
 * a `when` clause reads only the answers of active fields declared before it
 * (OpenCode rejects a form whose clause points at a later field), so the
 * fields shown here are exactly the ones the server will accept a value for.
 * `external` fields are never gated.
 */
export function evaluateForm(fields: readonly FormField[], values: FormValues): FormEvaluation {
    const active: FormField[] = [];
    const answer: Record<string, FormValue> = {};
    for (const field of fields) {
        if (!isAnswerableField(field)) {
            active.push(field);
            if (valueOf(values, field.key).acknowledged) answer[field.key] = true;
            continue;
        }
        const isActive = (field.when ?? []).every((clause) => clauseMatches(clause, answer[clause.key]));
        if (!isActive) continue;
        active.push(field);
        const value = fieldAnswer(field, values);
        if (value !== undefined) answer[field.key] = value;
    }
    return { active, answer };
}

/** Fields the card renders right now, in declaration order. */
export function visibleFields(fields: readonly FormField[], values: FormValues): FormField[] {
    return evaluateForm(fields, values).active;
}

/**
 * Keys of visible fields the server would refuse the reply without: required
 * fields still unanswered, and external links the user has not opened yet.
 */
export function missingRequiredKeys(fields: readonly FormField[], values: FormValues): string[] {
    const { active, answer } = evaluateForm(fields, values);
    const missing: string[] = [];
    for (const field of active) {
        const value = answer[field.key];
        if (!isAnswerableField(field)) {
            if (value !== true) missing.push(field.key);
            continue;
        }
        if (!field.required) continue;
        if (value === undefined || (Array.isArray(value) && value.length === 0)) {
            missing.push(field.key);
        }
    }
    return missing;
}

/**
 * The reply payload. Only active fields contribute: a field hidden by a
 * `when` clause was never asked, and the server rejects a value for it.
 * External fields answer `true` once acknowledged, as the server requires.
 */
export function buildFormAnswer(fields: readonly FormField[], values: FormValues): Record<string, FormValue> {
    return evaluateForm(fields, values).answer;
}

/** Fields a form request actually asks the user to fill in. */
