import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

it('runs shipped OpenUI source with declared dependencies and no UI workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openui-package-'));
  roots.push(root);
  await fs.writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  const library = path.join(root, 'server/lib');
  for (const directory of ['openui', 'shared', 'openchamber-control']) {
    await fs.mkdir(path.join(library, directory), { recursive: true });
  }
  await fs.cp(new URL('../../../shared', import.meta.url), path.join(root, 'shared'), { recursive: true });
  await fs.cp(new URL('./context/generated/', import.meta.url), path.join(library, 'openui/context/generated'), { recursive: true });
  await fs.cp(new URL('./context/groups/', import.meta.url), path.join(library, 'openui/context/groups'), { recursive: true });
  for (const name of ['instruction.md', 'gen.instruction.md', 'gen.schema.md']) {
    await fs.copyFile(new URL(`./context/${name}`, import.meta.url), path.join(library, `openui/context/${name}`));
  }
  for (const filename of ['openui/context/assets.js', 'openui/context/tools.js', 'openui/program.js', 'openui/runtime.js', 'openui/answers.js', 'shared/guards.js', 'openchamber-control/error.js']) {
    await fs.copyFile(new URL(`../${filename}`, import.meta.url), path.join(library, filename));
  }
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(await fs.readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  expect(manifest.files).toContain('shared');
  for (const name of ['@openuidev/lang-core', 'zod']) {
    expect(manifest.dependencies[name]).toBeTruthy();
    const link = path.join(root, 'node_modules', name);
    await fs.mkdir(path.dirname(link), { recursive: true });
    // Resolve only declared runtime dependencies, as an installed package does.
    let directory = path.dirname(require.resolve(name));
    while (!await fs.stat(path.join(directory, 'package.json')).catch(() => null)) directory = path.dirname(directory);
    await fs.symlink(directory, link, 'junction');
  }
  const probe = `import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
let requests = 0;
globalThis.fetch = async () => { requests++; throw new Error('No network is permitted in this probe'); };
const {readOpenUIInstructionGroups, readOpenUIGuidance} = await import('./server/lib/openui/context/assets.js');
const {createOpenUIRuntime} = await import('./server/lib/openui/runtime.js');
const {inspectOpenUI} = await import('./server/lib/openui/program.js');
const invalid = inspectOpenUI('root = Stack([Input()])');
assert.equal(invalid.valid, false);
assert.ok(invalid.diagnostics.some(error => error.component === 'Input' && error.path === '/name' && error.message.includes('signature:')));
const ui = 'root = Stack([Image("Preview", "/tmp/preview.png")])';
const message = { type: 'assistant', content: [{type: 'tool', id: 'call_1', name: 'openchamber_openui', state: {input: {action: 'openui.prompt', parameters: {ui}}}}] };
const started = Promise.withResolvers();
const runtime = createOpenUIRuntime({isEnabled: async () => true, onWaitChange: event => { if (event.type === 'waiting') started.resolve(event); }, getClient: async () => ({message: {list: async () => ({data: [message]})}})});
const pending = runtime.prompt({ui}, {sessionId: 'ses_1', callId: 'call_1', directory: '/repo'});
const event = await started.promise;
await runtime.answer({sessionId: 'ses_1', callId: 'call_1', sourceRevision: event.sourceRevision, summary: 'Done'});
assert.equal((await pending).answer.summary, 'Done');
assert.equal((await readOpenUIInstructionGroups(['interaction'])).groups[0], 'interaction');
const advancedGuide = new URL('./server/lib/openui/context/groups/advanced/instruction.md', import.meta.url);
await fs.rm(advancedGuide, { force: true });
assert.deepEqual((await readOpenUIInstructionGroups(['advanced'])).groups, ['advanced']);
const examples = await readOpenUIInstructionGroups(['examples']);
assert.deepEqual(examples.groups, ['examples']);
assert.ok((await readOpenUIGuidance()).length > 0);
const before = await readOpenUIGuidance();
const guide = new URL('./server/lib/openui/context/groups/interaction/instruction.md', import.meta.url);
await fs.appendFile(guide, '\\nLocal interaction guidance change.\\n');
assert.ok((await readOpenUIInstructionGroups(['interaction'])).content.includes('Local interaction guidance change.'));
assert.notEqual((await readOpenUIGuidance()).split('OpenUI catalog revision: ')[1], before.split('OpenUI catalog revision: ')[1]);
const beforeExamples = await readOpenUIGuidance();
const exampleGuide = new URL('./server/lib/openui/context/groups/examples/instruction.md', import.meta.url);
await fs.appendFile(exampleGuide, '\\nLocal example guidance change.\\n');
assert.ok((await readOpenUIInstructionGroups(['examples'])).content.includes('Local example guidance change.'));
assert.notEqual((await readOpenUIGuidance()).split('OpenUI catalog revision: ')[1], beforeExamples.split('OpenUI catalog revision: ')[1]);
const official = new URL('./server/lib/openui/context/gen.instruction.md', import.meta.url);
const beforeOfficial = await readOpenUIGuidance();
await fs.appendFile(official, '\\nOfficial language update.\\n');
assert.ok((await readOpenUIGuidance()).includes('Official language update.'));
assert.notEqual(await readOpenUIGuidance(), beforeOfficial);
const officialBody = await fs.readFile(official);
await fs.unlink(official);
await assert.rejects(readOpenUIGuidance(), error => error.statusCode === 503);
await fs.writeFile(official, officialBody);
const dataGuide = new URL('./server/lib/openui/context/groups/data/gen.instruction.md', import.meta.url);
const beforeData = await readOpenUIGuidance();
await fs.appendFile(dataGuide, '\\nOfficial data guidance update.\\n');
assert.notEqual(await readOpenUIGuidance(), beforeData);
await fs.unlink(dataGuide);
await assert.rejects(readOpenUIInstructionGroups(['data']), error => error.statusCode === 503);
await fs.unlink(new URL('./server/lib/openui/context/gen.schema.md', import.meta.url));
await assert.rejects(readOpenUIGuidance(), error => error.statusCode === 503);
await new Promise(resolve => setTimeout(resolve, 20));
assert.equal(requests, 0);
console.log('standalone OpenUI assets passed');
`;
  const filename = path.join(root, 'probe.mjs');
  await fs.writeFile(filename, probe);
  const result = await execute(process.execPath, [filename], {
    cwd: os.tmpdir(),
    env: { PATH: process.env.PATH, NODE_ENV: 'production', OPENUI_RUNTIME_TELEMETRY_ENABLED: '1' },
  });
  expect(result.stdout.trim()).toBe('standalone OpenUI assets passed');
});
