import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const input = 'packages/ui/src/components/chat/composer/input/';
const rule = 'openchamber(composer-input-boundaries)';
const cases: Array<{ name: string; file: string; code: string; messages: Array<keyof typeof reasons> }> = [
    { name: 'misplaced state', file: 'useComposerDictation.ts', code: 'const prevWasAbortedRef = React.useRef(false);\n', messages: ['owner'] },
    { name: 'multiline state', file: 'useComposerEditorState.ts', code: 'const [\ncomposerText\n] = React.useState(createText);\n', messages: ['owner'] },
    { name: 'state owner', file: 'useComposerDraftText.ts', code: 'const [composerText] = React.useState(createText);\n', messages: [] },
    { name: 'consumer slice', file: 'useComposerControls.ts', code: 'const { composerText } = draftText;\n', messages: [] },
    { name: 'equivalent state declaration', file: 'useComposerDraftText.ts', code: 'let [\n  composerText,\n] = React.useState(createText);\n', messages: [] },
    { name: 'misplaced publication', file: 'useComposerSubmission.ts', code: 'handleSubmitRef.current = handleSubmit;\n', messages: ['publish'] },
    { name: 'queue publication', file: 'useComposerQueueActions.ts', code: "handleQueueMessageRef['current'] = handleQueueMessage;\n", messages: ['publish'] },
    { name: 'publication owner', file: 'useComposerSending.ts', code: 'handleSubmitRef.current = handleSubmit; handleQueueMessageRef.current = queue;\n', messages: [] },
    { name: 'dynamic property', file: 'useComposerSubmission.ts', code: 'handleSubmitRef[current] = value;\n', messages: [] },
    { name: 'misplaced consumption', file: 'useComposerDictation.ts', code: 'store.consumePendingPresetSubmit(); store.consumePendingDraftSubmit(id);\n', messages: ['consume', 'consume'] },
    { name: 'consumption owner', file: 'useComposerExternalSubmits.ts', code: 'store.consumePendingPresetSubmit(); store.consumePendingDraftSubmit(id);\n', messages: [] },
    { name: 'flat render field', file: 'renderComposerForm.tsx', code: 'type Dependencies = { composerText: Text };\n', messages: ['slices'] },
    { name: 'flat dialog field', file: 'renderComposerDialogs.tsx', code: 'type Dependencies = { currentSessionId: string; setReferencePicker: Setter; handleSubmitRef: Ref };\n', messages: ['slices', 'slices', 'slices'] },
    { name: 'intersection boundary', file: 'renderComposerForm.tsx', code: "type Dependencies = Pick<State, 'composerText'> & Pick<Scope, 'currentSessionId'>;\n", messages: ['slices'] },
    { name: 'named slices', file: 'renderComposerForm.tsx', code: 'type Dependencies = { draftText: Text; sessionScope: Scope };\n', messages: [] },
    { name: 'nested slice fields', file: 'renderComposerForm.tsx', code: 'type Dependencies = { draftText: { composerText: Text } };\n', messages: [] },
    { name: 'equivalent interface', file: 'renderComposerDialogs.tsx', code: 'interface Dependencies { draftText: Text; sessionScope: Scope }\n', messages: [] },
    { name: 'destructured composition', file: '../../ChatInput.tsx', code: 'const { composerText } = useComposerDraftText();\n', messages: ['slices'] },
    { name: 'named composition', file: '../../ChatInput.tsx', code: 'const draft = useComposerDraftText();\n', messages: [] },
    { name: 'retired state bucket', file: 'useComposerInputState.ts', code: 'export const state = {};\n', messages: ['retired'] },
    { name: 'retired environment bucket', file: 'useComposerEnvironment.ts', code: 'export const environment = {};\n', messages: ['retired'] },
    { name: 'redundant form fragment', file: 'renderComposerForm.tsx', code: 'const render = () => (<>\n<form />\n</>);\n', messages: ['fragment'] },
    { name: 'direct form', file: 'renderComposerForm.tsx', code: 'const render = () => <form />;\n', messages: [] },
    { name: 'multiple children', file: 'renderComposerForm.tsx', code: 'const render = () => <><form /><aside /></>;\n', messages: [] },
    { name: 'missing newline', file: 'useStableHandler.ts', code: 'export function useStableHandler() {}', messages: ['newline'] },
    { name: 'comment after export', file: 'useStableHandler.ts', code: 'export /** Handler. */ function useStableHandler() {}\n', messages: ['export'] },
    { name: 'detached export', file: 'useStableHandler.ts', code: 'export\nfunction useStableHandler() {}\n', messages: ['export'] },
    { name: 'documented export', file: 'useStableHandler.ts', code: '/** Handler. */\nexport function useStableHandler() {}\n', messages: [] },
    { name: 'unrelated module', file: '../../Other.ts', code: 'const composerText = createText();', messages: [] },
];

let directory: string;
let findings: Array<{ filename: string; code: string; message: string }>;

beforeAll(() => {
    directory = mkdtempSync('/tmp/opencode/composer-lint-');
    for (const [index, fixture] of cases.entries()) {
        const target = join(directory, String(index), input, fixture.file);
        mkdirSync(resolve(target, '..'), { recursive: true });
        writeFileSync(target, fixture.code);
    }
    const config = join(directory, 'lint.config.json');
    writeFileSync(config, JSON.stringify({
        categories: { correctness: 'off' },
        jsPlugins: [{ name: 'openchamber', specifier: join(root, 'tools/oxlint/openchamber/index.ts') }],
        rules: { 'openchamber/composer-input-boundaries': 'error' },
    }));
    const result = spawnSync(join(root, 'node_modules/.bin/oxlint'), ['-c', config, '-f', 'json', directory], { encoding: 'utf8' });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    findings = JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))).diagnostics;
    expect(findings.every((finding) => finding.code === rule)).toBe(true);
});

afterAll(() => rmSync(directory, { recursive: true, force: true }));

const reasons = {
    owner: /belongs to .* so composer state and effects keep one domain owner/,
    publish: /published together in useComposerSending.ts/,
    consume: /belong to useComposerExternalSubmits.ts/,
    slices: /connect named domain slices/,
    retired: /catch-all composer module mixes unrelated state lifetimes/,
    fragment: /fragment around only the composer form/,
    newline: /need a final newline/,
    export: /Keep export attached to its declaration/,
};

for (const [index, fixture] of cases.entries()) {
    test(fixture.name, () => {
        const actual = findings.filter((finding) => finding.filename.startsWith(join(directory, String(index)) + '/'));
        expect(actual).toHaveLength(fixture.messages.length);
        for (const [messageIndex, message] of fixture.messages.entries()) {
            expect(reasons[message].test(actual[messageIndex].message)).toBe(true);
        }
    });
}
