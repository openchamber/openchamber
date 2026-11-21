
import type { FormField, FormValue } from '@/lib/opencode/model';

type FieldValue = {
    text: string;
    number: number | null;
    boolean: boolean;
    selected: string[];
    custom: boolean;
    acknowledged: boolean;
};

export type FormValues = Record<string, FieldValue>;

export type AnswerableField = Exclude<FormField, { type: 'external' }>;

export const isAnswerableField = (field: FormField): field is AnswerableField => field.type !== 'external';

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
    acknowledgeExternal?: boolean;
};

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

export const acknowledgeLinks = (fields: readonly FormField[], values: FormValues) => {
    const next = { ...values };
    for (const field of fields) {
        if (!isAnswerableField(field)) next[field.key] = { ...valueOf(values, field.key), acknowledged: true };
    }
    return next;
};

export const isFieldAnswered = (field: FormField, values: FormValues): boolean => {
    if (!isAnswerableField(field)) return valueOf(values, field.key).acknowledged;
    const answer = fieldAnswer(field, values);
    if (answer === undefined) return false;
    return !(Array.isArray(answer) && answer.length === 0);
};

export type FormEvaluation = {
    active: FormField[];
    answer: Record<string, FormValue>;
};

const clauseMatches = (clause: NonNullable<AnswerableField['when']>[number], answer: FormValue | undefined): boolean => {
    if (answer === undefined) return false;
    const hit = Array.isArray(answer) ? answer.some((entry) => entry === clause.value) : answer === clause.value;
    return clause.op === 'eq' ? hit : !hit;
};

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

export function visibleFields(fields: readonly FormField[], values: FormValues): FormField[] {
    return evaluateForm(fields, values).active;
}

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

export function buildFormAnswer(fields: readonly FormField[], values: FormValues): Record<string, FormValue> {
    return evaluateForm(fields, values).answer;
}
