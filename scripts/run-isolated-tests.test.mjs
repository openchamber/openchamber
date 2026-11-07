import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('./run-isolated-tests.mjs', import.meta.url));

const temporary = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'isolated-runner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const run = async (roots, workers) => {
  const env = { ...process.env };
  // Let nested Node test processes use their own test-worker protocol.
  delete env.NODE_TEST_CONTEXT;
  delete env.OPENCHAMBER_TEST_WORKERS;
  if (workers !== undefined) env.OPENCHAMBER_TEST_WORKERS = workers;
  try {
    return { code: 0, ...await execute(process.execPath, [runner, ...roots], { env, timeout: 10000 }) };
  } catch (error) {
    if (error.killed || !Number.isInteger(error.code)) throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
};

for (const [workers, expected] of [[undefined, 4], ['1', 1], ['2', 2], ['6', 6]]) {
  test(`runs all discovered Node and Bun fixtures with ${workers ?? 'default'} workers`, async (t) => {
    const root = await temporary(t);
    const started = [];
    const ended = [];
    const waiting = [];
    let active = 0;
    let peak = 0;
    let released = false;
    const server = http.createServer((request, response) => {
      const [event, id] = request.url.slice(1).split('/');
      if (event === 'start') {
        started.push(id);
        peak = Math.max(peak, ++active);
        if (!released) {
          waiting.push(response);
          if (waiting.length === expected) {
            released = true;
            for (const pending of waiting) pending.end();
          }
          return;
        }
      } else {
        ended.push(id);
        active -= 1;
      }
      response.end();
    });
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const roots = [path.join(root, 'first'), path.join(root, 'second')];
    const fixtures = ['a.test.mjs', 'nested/b.spec.mjs', 'c.test.cjs', 'd.test.js', 'e.test.ts', 'f.spec.ts', 'g.test.mjs'];
    for (const [index, file] of fixtures.entries()) {
      const target = path.join(roots[index % 2], file);
      await mkdir(path.dirname(target), { recursive: true });
      const framework = file.endsWith('.ts') ? 'bun:test' : 'node:test';
      const declaration = file.endsWith('.cjs') ? `const { test } = require('${framework}');` : `import { test } from '${framework}';`;
      await writeFile(target, `${declaration}
test('fixture', async () => {
  await fetch('${endpoint}/start/${index}');
  await fetch('${endpoint}/end/${index}');
});
`);
    }
    for (const directory of ['node_modules', 'dist', 'dist-bundle', 'build', 'out', '.git', 'ios', 'android', '.hidden']) {
      const target = path.join(roots[0], directory);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, 'ignored.test.mjs'), "import { test } from 'node:test'; test('must stay excluded', () => { throw new Error('excluded directory ran'); });");
    }
    await writeFile(path.join(roots[0], 'ordinary.mjs'), "throw new Error('non-test file ran');");
    const result = await run(roots, workers);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /7\/7 test files passed/);
    assert.deepEqual(started.sort(), ['0', '1', '2', '3', '4', '5', '6']);
    assert.deepEqual(ended.sort(), ['0', '1', '2', '3', '4', '5', '6']);
    assert.equal(active, 0);
    assert.equal(peak, expected);
  });
}

test('accepts the upper worker bound with fewer files than workers', async (t) => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'one.test.mjs'), "import { test } from 'node:test'; test('passes', () => {});");
  const result = await run([root], '32');
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /1\/1 test files passed/);
});

for (const workers of ['', '0', '-1', '+1', '1.5', '1e1', '0x10', ' 2', '2 ', '2\n', '02', 'NaN', 'Infinity', '33', '999999999999999999999']) {
  test(`rejects worker value ${JSON.stringify(workers)} before discovery or launching tests`, async (t) => {
    const root = await temporary(t);
    const result = await run([path.join(root, 'missing')], workers);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /OPENCHAMBER_TEST_WORKERS must be an integer from 1 to 32/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
    assert.equal(result.stdout, '');
  });
}

test('propagates test failure while completing the remaining files', async (t) => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'a.test.mjs'), "import { test } from 'node:test'; test('fails', () => { throw new Error('fixture failure'); });");
  await writeFile(path.join(root, 'c.test.mjs'), "import { test } from 'node:test'; test('passes', () => {});");
  const result = await run([root], '1');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /FAIL \(node\).*a\.test\.mjs/);
  assert.match(result.stderr, /fixture failure/);
  assert.match(result.stdout, /1\/2 test files passed, 1 failed/);
});

test('fails on an unknown runner while completing the remaining files', async (t) => {
  const root = await temporary(t);
  await writeFile(path.join(root, 'b.test.mjs'), 'export const unknown = true;');
  await writeFile(path.join(root, 'c.test.mjs'), "import { test } from 'node:test'; test('passes', () => {});");
  const result = await run([root], '1');
  assert.equal(result.code, 1);
  assert.match(result.stderr, /UNKNOWN RUNNER .*b\.test\.mjs/);
  assert.match(result.stdout, /1\/2 test files passed, 1 with no known runner/);
});
