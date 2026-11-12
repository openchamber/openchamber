import { describe, expect, test } from 'bun:test';
import type { FormField, FormValue } from '@opencode/client';
import {
    buildFormAnswer,
    evaluateForm,
    initialFormValues,
    missingRequiredKeys,
    visibleFields,
} from './formCardState';

/**
 * A port of the acceptance rules in OpenCode's `Form.validateAnswer`
 * (`packages/core/src/form.ts`, v2.0.14): the reply the card builds has to
 * pass exactly this, or the server rejects it and the agent keeps waiting.
 * Per-type value checks (patterns, bounds) are left out; activity, presence
 * and external acknowledgement are what the card decides.
 */
const upstreamValidateAnswer = (form: readonly FormField[], answer: Record<string, FormValue>): string | undefined => {
    const keys = new Set(form.map((field) => field.key));
    for (const key of Object.keys(answer)) if (!keys.has(key)) return `Unknown form field: ${key}`;
    const matches = (when: { key: string; op: 'eq' | 'neq'; value: FormValue }, value: FormValue | undefined) => {
        if (value === undefined) return false;
        const hit = Array.isArray(value) ? value.some((item) => item === when.value) : value === when.value;
        return when.op === 'eq' ? hit : !hit;
    };
    for (const field of form) {
        const value = answer[field.key];
        if (field.type === 'external') {
            if (value !== true) return `External form field must be acknowledged: ${field.key}`;
            continue;
        }
        const active = (field.when ?? []).every((when) => matches(when, answer[when.key]));
        if (value === undefined) {
            if (field.required && active) return `Missing required form field: ${field.key}`;
            continue;
        }
        if (!active) return `Form field is not active: ${field.key}`;
    }
    return undefined;
};

const yesNo = (key: string, extra: Partial<Extract<FormField, { type: 'string' }>> = {}): FormField => ({
    key,
    type: 'string',
    options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
    ...extra,
});

describe('conditional fields follow the server rules', () => {
    // A -> B -> C: B shown when A is "yes", C shown when B is "yes" and defaults to "yes".
    const chain: FormField[] = [
        yesNo('a'),
        yesNo('b', { when: [{ key: 'a', op: 'eq', value: 'yes' }] }),
        yesNo('c', { default: 'yes', when: [{ key: 'b', op: 'eq', value: 'yes' }] }),
    ];

    test('a hidden field hides its dependents even when they have defaults', () => {
        const values = initialFormValues(chain);
        // Nothing answered yet: B waits on A, C waits on B.
        expect(visibleFields(chain, values).map((field) => field.key)).toEqual(['a']);
        // A answered "no": B hidden, so C's default must not surface.
        values.a = { ...values.a, selected: ['no'] };
        expect(visibleFields(chain, values).map((field) => field.key)).toEqual(['a']);
        const answer = buildFormAnswer(chain, values);
        expect(answer).toEqual({ a: 'no' });
        expect(upstreamValidateAnswer(chain, answer)).toBeUndefined();
    });

    test('the chain opens step by step as each controlling answer arrives', () => {
        const values = initialFormValues(chain);
        values.a = { ...values.a, selected: ['yes'] };
        expect(visibleFields(chain, values).map((field) => field.key)).toEqual(['a', 'b']);
        values.b = { ...values.b, selected: ['yes'] };
        expect(visibleFields(chain, values).map((field) => field.key)).toEqual(['a', 'b', 'c']);
        const answer = buildFormAnswer(chain, values);
        expect(answer).toEqual({ a: 'yes', b: 'yes', c: 'yes' });
        expect(upstreamValidateAnswer(chain, answer)).toBeUndefined();
    });

    test('neq against an unanswered field is false, like on the server', () => {
        const fields: FormField[] = [
            { key: 'name', type: 'string' },
            { key: 'why', type: 'string', when: [{ key: 'name', op: 'neq', value: 'skip' }] },
        ];
        const values = initialFormValues(fields);
        expect(visibleFields(fields, values).map((field) => field.key)).toEqual(['name']);
        values.why = { ...values.why, text: 'typed before the gate opened' };
        expect(buildFormAnswer(fields, values)).toEqual({});
        values.name = { ...values.name, text: 'Ada' };
        expect(visibleFields(fields, values).map((field) => field.key)).toEqual(['name', 'why']);
        const answer = buildFormAnswer(fields, values);
        expect(answer).toEqual({ name: 'Ada', why: 'typed before the gate opened' });
        expect(upstreamValidateAnswer(fields, answer)).toBeUndefined();
    });

    test('a required field behind a closed gate is not missing', () => {
        const fields: FormField[] = [
            yesNo('a'),
            { key: 'detail', type: 'string', required: true, when: [{ key: 'a', op: 'eq', value: 'yes' }] },
        ];
        const values = initialFormValues(fields);
        values.a = { ...values.a, selected: ['no'] };
        expect(missingRequiredKeys(fields, values)).toEqual([]);
        values.a = { ...values.a, selected: ['yes'] };
        expect(missingRequiredKeys(fields, values)).toEqual(['detail']);
    });

    for (const literal of ['Infinity', '-Infinity', 'NaN']) {
        for (const type of ['string', 'multiselect'] as const) {
            test(`${type} conditions compare ${literal} as a literal string`, () => {
                const options = [{ value: literal, label: literal }];
                const control: FormField = type === 'string'
                    ? { key: 'choice', type, options, default: literal }
                    : { key: 'choice', type, options, default: [literal] };
                const fields: FormField[] = [
                    control,
                    { key: 'detail', type: 'string', required: true, when: [{ key: 'choice', op: 'eq', value: literal }] },
                    { key: 'other', type: 'string', default: 'hidden', when: [{ key: 'choice', op: 'neq', value: literal }] },
                ];
                const values = initialFormValues(fields);
                expect(visibleFields(fields, values).map((field) => field.key)).toEqual(['choice', 'detail']);
                expect(missingRequiredKeys(fields, values)).toEqual(['detail']);
                values.detail = { ...values.detail, text: 'answered' };
                const answer = buildFormAnswer(fields, values);
                expect(answer.detail).toBe('answered');
                expect(answer.other).toBeUndefined();
                expect(upstreamValidateAnswer(fields, answer)).toBeUndefined();
            });
        }
    }

    test('a multiselect clause matches any selected entry', () => {
        const fields: FormField[] = [
            { key: 'areas', type: 'multiselect', options: [{ value: 'ui', label: 'UI' }, { value: 'api', label: 'API' }] },
            { key: 'route', type: 'string', when: [{ key: 'areas', op: 'eq', value: 'api' }] },
        ];
        const values = initialFormValues(fields);
        values.areas = { ...values.areas, selected: ['ui'] };
        expect(visibleFields(fields, values).map((field) => field.key)).toEqual(['areas']);
        values.areas = { ...values.areas, selected: ['ui', 'api'] };
        expect(visibleFields(fields, values).map((field) => field.key)).toEqual(['areas', 'route']);
    });
});

describe('external fields', () => {
    const external: FormField = { key: 'elicitation', type: 'external', url: 'https://example.test/auth' };

    test('an external-only form replies with the acknowledgement the server requires', () => {
        const fields = [external];
        const unseen = initialFormValues(fields);
        expect(missingRequiredKeys(fields, unseen)).toEqual(['elicitation']);
        expect(upstreamValidateAnswer(fields, buildFormAnswer(fields, unseen))).toBe(
            'External form field must be acknowledged: elicitation',
        );

        const seen = initialFormValues(fields, { acknowledgeExternal: true });
        expect(missingRequiredKeys(fields, seen)).toEqual([]);
        const answer = buildFormAnswer(fields, seen);
        expect(answer).toEqual({ elicitation: true });
        expect(upstreamValidateAnswer(fields, answer)).toBeUndefined();
    });

    test('acknowledging one link leaves the rest of the form unchanged', () => {
        const fields: FormField[] = [external, { key: 'name', type: 'string', required: true }];
        const values = initialFormValues(fields);
        values.elicitation = { ...values.elicitation, acknowledged: true };
        values.name = { ...values.name, text: 'Ada' };
        const { active, answer } = evaluateForm(fields, values);
        expect(active.map((field) => field.key)).toEqual(['elicitation', 'name']);
        expect(answer).toEqual({ elicitation: true, name: 'Ada' });
        expect(upstreamValidateAnswer(fields, answer)).toBeUndefined();
    });

    test('external fields are never gated', () => {
        const fields: FormField[] = [yesNo('a'), external];
        const values = initialFormValues(fields);
        expect(visibleFields(fields, values).map((field) => field.key)).toEqual(['a', 'elicitation']);
    });
});
