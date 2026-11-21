import fs from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvironmentStore } from '../environment/store.js';
import { createSavedSecrets, createSecretRequests } from './secret-request.js';
import { createSecretLeases, redactSecrets, secretRunCommandLine, SECRET_LEASE_MS } from './secret-run.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

// `project` is the project id the session's directory belongs to; null is outside any project.
// `savesSecrets: false` is the server inside an isolated space, which runs without saved secrets.
const createHarness = async ({ enabled = true, now, hasUnreadChat, project = null, projectIdFor = async () => project, savesSecrets = true } = {}) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-secret-run-'));
  temporaryDirectories.push(directory);
  const events = new EventEmitter();
  const onWaitChange = vi.fn((change) => events.emit(change.type));
  const leases = createSecretLeases({ now });
  const store = createEnvironmentStore({ filePath: path.join(directory, 'environment.json'), savesSecrets });
  const stored = createSavedSecrets({ store, projectIdFor });
  // `writes.fail` makes the store refuse saved values, as a full disk would.
  const writes = { fail: false };
  const failing = (method) => (...args) => (writes.fail ? Promise.reject(new Error('disk full')) : method(...args));
  const saved = { ...stored, write: failing(stored.write), remove: failing(stored.remove) };
  const requests = createSecretRequests({ isEnabled: async () => enabled, files: null, onWaitChange, hasUnreadChat, leases, saved: savesSecrets ? saved : null });
  return { directory, requests, onWaitChange, leases, store, writes, waitForCard: () => once(events, 'waiting') };
};

// The real runtime, so the child, its environment and its output are what a user gets.
const printToken = {
  program: process.execPath,
  args: ['-e', 'console.log("token is " + process.env.API_TOKEN); console.error("user " + process.env.API_USER); process.exit(3)'],
  reason: 'To log in to the staging API.',
  inputs: [{ env: 'API_TOKEN', label: 'Staging API token' }, { env: 'API_USER', label: 'User name' }],
};
const call = (directory, extra = {}) => ({ sessionId: 'ses_1', callId: 'call_1', directory, authorized: true, ...extra });

describe('secret.run', () => {
  it('runs the command once with the values in its environment and keeps them out of the result', async () => {
    const { directory, requests, onWaitChange, waitForCard } = await createHarness();
    const pending = requests.run(printToken, call(directory));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_1' })).toEqual({ fields: ['API_TOKEN', 'API_USER'], reused: [], saved: [], savedGlobally: [], savedInBoth: [], canSave: false, canSaveGlobally: true });
    expect(onWaitChange).toHaveBeenCalledWith(expect.objectContaining({ type: 'waiting', title: 'Staging API token, User name' }));

    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-secret-1', API_USER: 'alice-secret' } }))
      .resolves.toEqual({ status: 'submitted' });
    const result = await pending;

    expect(result.answer).toEqual({ status: 'ran', outcome: 'exited', exitCode: 3 });
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');
    expect(result.stderr.trim()).toBe('user [secret:API_USER]');
    expect(result.remembered).toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/tok-secret-1|alice-secret/);
  });

  it('runs in the session directory', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const pending = requests.run({ ...printToken, args: ['-e', 'console.log(process.cwd())'], inputs: [printToken.inputs[0]] }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'x-1234' } });
    expect((await pending).stdout.trim()).toBe(await fs.realpath(directory));
  });

  it('reuses only the fields the user let the chat remember, and asks for the rest', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const first = requests.run(printToken, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-secret-1', API_USER: 'alice-secret' }, remember: ['API_TOKEN'] });
    expect((await first).remembered).toEqual(['API_TOKEN']);

    const second = requests.run(printToken, call(directory, { callId: 'call_2' }));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_2' })).toEqual({ fields: ['API_USER'], reused: ['API_TOKEN'], saved: [], savedGlobally: [], savedInBoth: [], canSave: false, canSaveGlobally: true });
    // A value for a field the card did not ask for is refused.
    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_USER: 'bob', API_TOKEN: 'other' } })).rejects.toMatchObject({ statusCode: 400 });
    requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_USER: 'bob-secret' } });
    const result = await second;
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');
    expect(result.stderr.trim()).toBe('user [secret:API_USER]');
  });

  it('runs at once when every field is remembered, in this session only', async () => {
    const { directory, requests, leases, onWaitChange, waitForCard } = await createHarness();
    leases.keep('ses_1', 'API_TOKEN', 'tok-secret-1');
    const result = await requests.run({ ...printToken, inputs: [printToken.inputs[0]] }, call(directory));
    expect(onWaitChange).not.toHaveBeenCalled();
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');

    const other = requests.run({ ...printToken, inputs: [printToken.inputs[0]] }, call(directory, { sessionId: 'ses_2' }));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_2', callId: 'call_1' })).toEqual({ fields: ['API_TOKEN'], reused: [], saved: [], savedGlobally: [], savedInBoth: [], canSave: false, canSaveGlobally: true });
    requests.answer({ sessionId: 'ses_2', callId: 'call_1', declined: true });
    await expect(other).resolves.toMatchObject({ answer: { status: 'declined' } });
  });

  it('saves a field for the project, then shows it on the card for one click and never runs it on its own', async () => {
    const { directory, requests, store, waitForCard } = await createHarness({ project: 'path_app' });
    const single = { ...printToken, inputs: [printToken.inputs[0]] };
    const first = requests.run(single, call(directory));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_1' })).toEqual({ fields: ['API_TOKEN'], reused: [], saved: [], savedGlobally: [], savedInBoth: [], canSave: true, canSaveGlobally: true });
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-secret-1' }, save: ['API_TOKEN'] });
    expect((await first).saved).toEqual(['API_TOKEN']);
    expect(store.projectSecrets('path_app')).toEqual({ API_TOKEN: 'tok-secret-1' });
    // Saved for secret.run only: Git, the terminal and project actions never get it.
    expect(store.projectEntry('path_app').variables).toEqual({});

    // Another chat in the project: the card waits with the saved field and nothing to type.
    const second = requests.run(single, call(directory, { sessionId: 'ses_2' }));
    await waitForCard();
    // fields lists the saved name too, so an app older than saved secrets asks for it instead of drawing nothing.
    expect(requests.fields({ sessionId: 'ses_2', callId: 'call_1' })).toEqual({ fields: ['API_TOKEN'], reused: [], saved: ['API_TOKEN'], savedGlobally: [], savedInBoth: [], canSave: true, canSaveGlobally: true });
    // An answer that neither confirms the saved field nor gives a value for it cannot run it.
    await expect(requests.answer({ sessionId: 'ses_2', callId: 'call_1', values: {} })).rejects.toMatchObject({ statusCode: 409 });
    requests.answer({ sessionId: 'ses_2', callId: 'call_1', values: {}, saved: ['API_TOKEN'] });
    const result = await second;
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');
    expect(result.saved).toEqual(['API_TOKEN']);
    expect(JSON.stringify(result)).not.toMatch(/tok-secret-1/);
  });

  it('asks again for a saved field the user forgets on the card, and secret.forget drops saved ones only when the user confirms', async () => {
    const { directory, requests, store, waitForCard } = await createHarness({ project: 'path_app' });
    await store.updateProject('path_app', { secrets: { API_TOKEN: 'tok-old', API_USER: 'alice-saved' } });
    // Reversed, so the output shows which value ran without being redacted.
    const reversed = { ...printToken, args: ['-e', 'console.log([...process.env.API_TOKEN].reverse().join(""))'] };
    const pending = requests.run(reversed, call(directory));
    await waitForCard();
    const forgetting = requests.forgetSaved({ sessionId: 'ses_1', callId: 'call_1', env: 'API_TOKEN' });
    // A Run that lands while the store is written must not use the forgotten value.
    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: {}, saved: ['API_TOKEN', 'API_USER'] }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(forgetting).resolves.toEqual({ fields: ['API_TOKEN', 'API_USER'], reused: [], saved: ['API_USER'], savedGlobally: [], savedInBoth: [], canSave: true, canSaveGlobally: true });
    expect(store.projectSecrets('path_app')).toEqual({ API_USER: 'alice-saved' });
    // Another device forgets the same field: it gets the current card instead of an error.
    await expect(requests.forgetSaved({ sessionId: 'ses_1', callId: 'call_1', env: 'API_TOKEN' }))
      .resolves.toEqual({ fields: ['API_TOKEN', 'API_USER'], reused: [], saved: ['API_USER'], savedGlobally: [], savedInBoth: [], canSave: true, canSaveGlobally: true });
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-new' }, saved: ['API_USER'] });
    const result = await pending;
    expect(result.stdout.trim()).toBe('wen-kot');
    expect(result.saved).toEqual(['API_USER']);
    await expect(requests.forgetSaved({ sessionId: 'ses_1', callId: 'call_1', env: 'API_USER' })).rejects.toMatchObject({ statusCode: 404 });

    await expect(requests.forget({}, call(directory))).resolves.toEqual({ forgotten: 0 });
    expect(store.projectSecrets('path_app')).toEqual({ API_USER: 'alice-saved' });

    // With saved: true the agent only asks: the card lists them, and Keep leaves them saved.
    const kept = requests.forget({ saved: true }, call(directory, { callId: 'call_2' }));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_2' })).toEqual({ fields: ['API_USER'], reused: [], saved: ['API_USER'], savedGlobally: [], savedInBoth: [], canSave: true, canSaveGlobally: false });
    await requests.answer({ sessionId: 'ses_1', callId: 'call_2', declined: true });
    await expect(kept).resolves.toMatchObject({ forgotten: 0, forgottenSaved: [] });
    expect(store.projectSecrets('path_app')).toEqual({ API_USER: 'alice-saved' });

    const confirming = requests.forget({ saved: true }, call(directory, { callId: 'call_3' }));
    await waitForCard();
    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_3', values: {} })).rejects.toMatchObject({ statusCode: 409 });
    await requests.answer({ sessionId: 'ses_1', callId: 'call_3', values: {}, saved: ['API_USER'] });
    await expect(confirming).resolves.toEqual({ forgotten: 0, forgottenSaved: ['API_USER'] });
    expect(store.projectSecrets('path_app')).toEqual({});
    await expect(requests.forget({ saved: true }, call(null, { callId: 'call_5' }))).rejects.toMatchObject({ statusCode: 400 });
    // Nothing left to forget: no card.
    await expect(requests.forget({ saved: true }, call(directory, { callId: 'call_4' }))).resolves.toEqual({ forgotten: 0, forgottenSaved: [] });
  });

  it('saves a field for all projects, lets a project value win, and forgets both on the card', async () => {
    const outside = os.tmpdir();
    const { directory, requests, store, waitForCard } = await createHarness({ projectIdFor: async (dir) => (dir === outside ? null : 'path_app') });
    const reversed = { ...printToken, inputs: [printToken.inputs[0]], args: ['-e', 'console.log([...process.env.API_TOKEN].reverse().join(""))'] };

    // A chat outside any project can save only for all projects.
    const first = requests.run(reversed, call(outside));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_1' })).toEqual({ fields: ['API_TOKEN'], reused: [], saved: [], savedGlobally: [], savedInBoth: [], canSave: false, canSaveGlobally: true });
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-global' }, save: ['API_TOKEN'], saveGlobally: ['API_TOKEN'] });
    expect((await first).saved).toEqual(['API_TOKEN']);
    expect(store.userSecrets()).toEqual({ API_TOKEN: 'tok-global' });
    expect(store.userVariables()).toEqual({});

    // A chat in a project shows it as saved for all projects, and runs it on the click.
    const second = requests.run(reversed, call(directory, { sessionId: 'ses_2' }));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_2', callId: 'call_1' })).toEqual({ fields: ['API_TOKEN'], reused: [], saved: ['API_TOKEN'], savedGlobally: ['API_TOKEN'], savedInBoth: [], canSave: true, canSaveGlobally: true });
    requests.answer({ sessionId: 'ses_2', callId: 'call_1', values: {}, saved: ['API_TOKEN'] });
    expect((await second).stdout.trim()).toBe('labolg-kot');

    // The project's own value wins over the one for all projects.
    await store.updateProject('path_app', { secrets: { API_TOKEN: 'tok-project' } });
    const third = requests.run(reversed, call(directory, { sessionId: 'ses_3' }));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_3', callId: 'call_1' })).toMatchObject({ saved: ['API_TOKEN'], savedGlobally: [] });
    requests.answer({ sessionId: 'ses_3', callId: 'call_1', values: {}, saved: ['API_TOKEN'] });
    expect((await third).stdout.trim()).toBe('tcejorp-kot');

    // Forgetting lists the name once, says it is in both places, and removes it from both.
    const forgetting = requests.forget({ saved: true }, call(directory, { sessionId: 'ses_4' }));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_4', callId: 'call_1' })).toMatchObject({ saved: ['API_TOKEN'], savedGlobally: [], savedInBoth: ['API_TOKEN'] });
    await requests.answer({ sessionId: 'ses_4', callId: 'call_1', values: {}, saved: ['API_TOKEN'] });
    await expect(forgetting).resolves.toMatchObject({ forgottenSaved: ['API_TOKEN'] });
    expect(store.projectSecrets('path_app')).toEqual({});
    expect(store.userSecrets()).toEqual({});
  });

  it('still runs the command when the store cannot take a value to save, and says it was not saved', async () => {
    const { directory, requests, store, writes, waitForCard } = await createHarness({ project: 'path_app' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writes.fail = true;
    const running = requests.run({ ...printToken, inputs: [printToken.inputs[0]] }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-unsaved-1' }, save: ['API_TOKEN'] });
    const result = await running;
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');
    expect(result.notSaved).toEqual(['API_TOKEN']);
    expect(result).not.toHaveProperty('saved');
    expect(store.projectSecrets('path_app')).toEqual({});
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/tok-unsaved-1/);
    warn.mockRestore();
  });

  it('keeps a saved field on the card when forgetting it cannot write the store', async () => {
    const { directory, requests, store, writes, waitForCard } = await createHarness({ project: 'path_app' });
    const single = { ...printToken, inputs: [printToken.inputs[0]] };
    const first = requests.run(single, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-kept-1' }, save: ['API_TOKEN'] });
    await first;

    const second = requests.run(single, call(directory, { sessionId: 'ses_2' }));
    await waitForCard();
    writes.fail = true;
    await expect(requests.forgetSaved({ sessionId: 'ses_2', callId: 'call_1', env: 'API_TOKEN' })).rejects.toThrow('disk full');
    expect(requests.fields({ sessionId: 'ses_2', callId: 'call_1' })).toMatchObject({ saved: ['API_TOKEN'] });
    expect(store.projectSecrets('path_app')).toEqual({ API_TOKEN: 'tok-kept-1' });
    writes.fail = false;
    requests.answer({ sessionId: 'ses_2', callId: 'call_1', values: {}, saved: ['API_TOKEN'] });
    expect((await second).stdout.trim()).toBe('token is [secret:API_TOKEN]');
  });

  it('does not run a saved value the user forgot while its card waited', async () => {
    const { directory, requests, store, waitForCard } = await createHarness({ project: 'path_app' });
    await store.updateProject('path_app', { secrets: { API_TOKEN: 'tok-old' } });
    const single = { ...printToken, inputs: [printToken.inputs[0]] };
    const pending = requests.run(single, call(directory));
    await waitForCard();
    // Another chat in the project forgets it; this card still shows it as saved.
    const forgetting = requests.forget({ saved: true }, call(directory, { sessionId: 'ses_2' }));
    await waitForCard();
    await requests.answer({ sessionId: 'ses_2', callId: 'call_1', values: {}, saved: ['API_TOKEN'] });
    await expect(forgetting).resolves.toMatchObject({ forgottenSaved: ['API_TOKEN'] });
    await requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: {}, saved: ['API_TOKEN'] });
    const result = await pending;
    expect(result.answer).toEqual({ status: 'ran', outcome: 'not-started', exitCode: null });
    expect(result.stdout).toBe('');
    expect(result.saved).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/tok-old/);
  });

  it('lets an app older than saved secrets type every field, and never runs a saved value it did not confirm', async () => {
    const { directory, requests, store, waitForCard } = await createHarness({ project: 'path_app' });
    await store.updateProject('path_app', { secrets: { API_TOKEN: 'tok-saved' } });
    const reversed = { ...printToken, args: ['-e', 'console.log([...process.env.API_TOKEN].reverse().join("") + " " + process.env.API_USER)'] };

    // Every field saved: the old app still gets a field to type, and the typed value runs instead of the saved one.
    const allSaved = requests.run({ ...reversed, args: ['-e', 'console.log([...process.env.API_TOKEN].reverse().join(""))'], inputs: [printToken.inputs[0]] }, call(directory));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_1' })).toMatchObject({ fields: ['API_TOKEN'], saved: ['API_TOKEN'] });
    await requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-typed' } });
    const typed = await allSaved;
    expect(typed.stdout.trim()).toBe('depyt-kot');
    expect(typed).not.toHaveProperty('saved');
    expect(store.projectSecrets('path_app')).toEqual({ API_TOKEN: 'tok-saved' });

    // A mixed card: an answer with only the unsaved field neither confirms nor replaces the saved one.
    const mixed = requests.run(reversed, call(directory, { callId: 'call_2' }));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_2' })).toMatchObject({ fields: ['API_USER', 'API_TOKEN'], saved: ['API_TOKEN'] });
    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_USER: 'alice' } })).rejects.toMatchObject({ statusCode: 409 });
    await requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_USER: 'alice', API_TOKEN: 'tok-typed' } });
    expect((await mixed).stdout.trim()).toBe('depyt-kot [secret:API_USER]');
  });

  it('forgets a saved value only while it still holds what the card showed', async () => {
    const { directory, requests, store, waitForCard } = await createHarness({ project: 'path_app' });
    await store.updateProject('path_app', { secrets: { API_TOKEN: 'tok-old' } });
    await store.updateUser({ secrets: { API_USER: 'alice-old' } });

    // Row Forget: another chat saved a replacement while this card waited, so the replacement stays
    // and the card asks for the field instead of offering the stale value again.
    const pending = requests.run(printToken, call(directory));
    await waitForCard();
    await store.updateProject('path_app', { secrets: { API_TOKEN: 'tok-new' } });
    await expect(requests.forgetSaved({ sessionId: 'ses_1', callId: 'call_1', env: 'API_TOKEN' })).rejects.toMatchObject({ statusCode: 409 });
    expect(store.projectSecrets('path_app')).toEqual({ API_TOKEN: 'tok-new' });
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_1' }).saved).toEqual(['API_USER']);
    await expect(requests.forgetSaved({ sessionId: 'ses_1', callId: 'call_1', env: 'API_TOKEN' })).resolves.toMatchObject({ saved: ['API_USER'] });
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', declined: true });
    await pending;

    // Bulk Forget: a replacement in one scope keeps both scopes whole, and a row Forget cannot remove one name early.
    const replaced = requests.forget({ saved: true }, call(directory, { callId: 'call_2' }));
    await waitForCard();
    await expect(requests.forgetSaved({ sessionId: 'ses_1', callId: 'call_2', env: 'API_TOKEN' })).rejects.toMatchObject({ statusCode: 400 });
    expect(store.projectSecrets('path_app')).toEqual({ API_TOKEN: 'tok-new' });
    await store.updateUser({ secrets: { API_USER: 'alice-new' } });
    await requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: {}, saved: ['API_TOKEN', 'API_USER'] });
    await expect(replaced).rejects.toMatchObject({ statusCode: 409 });
    expect(store.projectSecrets('path_app')).toEqual({ API_TOKEN: 'tok-new' });
    expect(store.userSecrets()).toEqual({ API_USER: 'alice-new' });

    // Bulk Forget the store cannot write: nothing is half removed, on disk either.
    const failing = requests.forget({ saved: true }, call(directory, { callId: 'call_3' }));
    await waitForCard();
    await fs.chmod(directory, 0o500);
    try {
      await requests.answer({ sessionId: 'ses_1', callId: 'call_3', values: {}, saved: ['API_TOKEN', 'API_USER'] });
      await expect(failing).rejects.toThrow();
    } finally {
      await fs.chmod(directory, 0o700);
    }
    const reread = createEnvironmentStore({ filePath: path.join(directory, 'environment.json') });
    expect(reread.projectSecrets('path_app')).toEqual({ API_TOKEN: 'tok-new' });
    expect(reread.userSecrets()).toEqual({ API_USER: 'alice-new' });
    expect(store.userSecrets()).toEqual({ API_USER: 'alice-new' });
  });

  it('offers only this run and this chat inside an isolated space, and saves nothing there', async () => {
    const { directory, requests, store, waitForCard } = await createHarness({ project: 'path_app', savesSecrets: false });
    const single = { ...printToken, inputs: [printToken.inputs[0]] };
    const pending = requests.run(single, call(directory));
    await waitForCard();
    expect(requests.fields({ sessionId: 'ses_1', callId: 'call_1' })).toMatchObject({ fields: ['API_TOKEN'], saved: [], canSave: false, canSaveGlobally: false });
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'tok-space' }, save: ['API_TOKEN'], saveGlobally: ['API_TOKEN'] });
    const result = await pending;
    expect(result.stdout.trim()).toBe('token is [secret:API_TOKEN]');
    expect(result).not.toHaveProperty('saved');
    expect(result).not.toHaveProperty('notSaved');
    expect(store.projectSecrets('path_app')).toEqual({});
    expect(store.userSecrets()).toEqual({});
    await expect(requests.forget({ saved: true }, call(directory, { callId: 'call_2' }))).resolves.toEqual({ forgotten: 0, forgottenSaved: [] });
  });

  it('forgets a remembered value when its time is up or the agent forgets it', async () => {
    let clock = 1_000;
    const leases = createSecretLeases({ now: () => clock });
    leases.keep('ses_1', 'A', 'one');
    leases.keep('ses_1', 'B', 'two');
    clock += SECRET_LEASE_MS - 1;
    expect(leases.read('ses_1', 'A')).toBe('one');
    clock += 1;
    expect(leases.read('ses_1', 'A')).toBeNull();
    leases.keep('ses_1', 'A', 'again');
    expect(leases.forget('ses_1')).toBe(2);
    expect(leases.read('ses_1', 'A')).toBeNull();
  });

  it('does not run when the user declines', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const marker = path.join(directory, 'ran');
    const pending = requests.run({ ...printToken, args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`] }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', declined: true });
    await expect(pending).resolves.toMatchObject({ answer: { status: 'declined' } });
    await expect(fs.access(marker)).rejects.toThrow();
    // A card that stopped waiting has no fields to read.
    expect(() => requests.fields({ sessionId: 'ses_1', callId: 'call_1' })).toThrow(expect.objectContaining({ statusCode: 404 }));
  });

  it('stops the command when the call is stopped', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const controller = new AbortController();
    const marker = path.join(directory, 'started');
    const pending = requests.run({ ...printToken, args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "ready"); setTimeout(() => {}, 60000)`], inputs: [printToken.inputs[0]] }, call(directory, { signal: controller.signal }));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'x-1234' } });
    await vi.waitFor(async () => expect(await fs.readFile(marker, 'utf8')).toBe('ready'), { timeout: 10_000 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ statusCode: 499 });
  });

  it('reports a timeout and a program that does not start, with the values out of the message', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const slow = requests.run({ ...printToken, args: ['-e', 'setTimeout(() => {}, 60000)'], inputs: [printToken.inputs[0]], timeoutMs: 300 }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: 'x-1234' } });
    await expect(slow).resolves.toMatchObject({ answer: { status: 'ran', outcome: 'timeout', exitCode: null } });

    const missing = requests.run({ ...printToken, program: 'no-such-program-oc', inputs: [printToken.inputs[0]] }, call(directory, { callId: 'call_2' }));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_2', values: { API_TOKEN: 'x-1234' } });
    await expect(missing).resolves.toMatchObject({ answer: { outcome: 'not-started' }, error: expect.stringContaining('no-such-program-oc') });
  });

  it('refuses a call that did not come through the secret tool, or that is malformed, before any card', async () => {
    const { directory, requests, onWaitChange } = await createHarness();
    await expect(requests.run(printToken, call(directory, { authorized: false }))).rejects.toMatchObject({ statusCode: 403 });
    await expect(requests.run({ ...printToken, program: '' }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.run({ ...printToken, inputs: [{ env: 'BAD-NAME', label: 'x' }] }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.run({ ...printToken, inputs: [printToken.inputs[0], printToken.inputs[0]] }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.run({ ...printToken, args: 'oops' }, call(directory))).rejects.toMatchObject({ statusCode: 400 });
    expect(onWaitChange).not.toHaveBeenCalled();
  });

  it('does not wait or run when the user wrote in the chat first, remembered values or not', async () => {
    const { directory, requests, onWaitChange, leases } = await createHarness({ hasUnreadChat: async () => true });
    await expect(requests.run(printToken, call(directory))).resolves.toMatchObject({ answer: { answered: false, reason: 'chat-sent-earlier' } });
    expect(onWaitChange).not.toHaveBeenCalled();

    leases.keep('ses_1', 'API_TOKEN', 'tok-secret-1');
    const marker = path.join(directory, 'ran');
    const remembered = { ...printToken, args: ['-e', `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], inputs: [printToken.inputs[0]] };
    await expect(requests.run(remembered, call(directory))).resolves.toMatchObject({ answer: { answered: false, reason: 'chat-sent-earlier' } });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('refuses a value no environment can hold, so the runtime never quotes it', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const pending = requests.run({ ...printToken, inputs: [printToken.inputs[0]] }, call(directory));
    await waitForCard();
    const nul = String.fromCharCode(0);
    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: `head${nul}tail` } })).rejects.toMatchObject({ statusCode: 400 });
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', declined: true });
    await pending;
  });

  it('drops a secret cut in half where the output was cut at its limit', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const secret = `S${'k'.repeat(15_000)}END-OF-SECRET`;
    // About 1.05 MB, so the runner keeps the last 1 MB and cuts one copy apart.
    const script = 'for (let i = 0; i < 70; i++) process.stdout.write(process.env.API_TOKEN + "\\n")';
    const pending = requests.run({ ...printToken, args: ['-e', script], inputs: [printToken.inputs[0]] }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: secret } });
    const result = await pending;
    expect(result.truncated).toEqual({ stdout: true, stderr: false });
    expect(result.stdout).not.toContain('END-OF-SECRET');
    expect(result.stdout).not.toContain('kkkk');
    expect(result.stdout).toContain('[secret:API_TOKEN]');
  });

  it('hides a repeating secret cut at the limit, where a shifted match would leave a piece', async () => {
    const { directory, requests, waitForCard } = await createHarness();
    const secret = '0123456789'.repeat(1500);
    const script = 'for (let i = 0; i < 70; i++) process.stdout.write(process.env.API_TOKEN + "\\n")';
    const pending = requests.run({ ...printToken, args: ['-e', script], inputs: [printToken.inputs[0]] }, call(directory));
    await waitForCard();
    requests.answer({ sessionId: 'ses_1', callId: 'call_1', values: { API_TOKEN: secret } });
    const { stdout } = await pending;
    expect(stdout).not.toMatch(/\d/);
  });

  it('answers 403 while the tool is off', async () => {
    const { directory, requests } = await createHarness({ enabled: false });
    await expect(requests.run(printToken, call(directory))).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('secret run helpers', () => {
  it('replaces every value, a longer one before one inside it', () => {
    expect(redactSecrets('a=abc123 b=abc', { SHORT: 'abc', LONG: 'abc123' })).toBe('a=[secret:LONG] b=[secret:SHORT]');
  });

  it('hides overlapping occurrences together, and the end of a value a cut text starts with', () => {
    expect(redactSecrets('x abab ababab y', { V: 'abab' })).toBe('x [secret:V] [secret:V] y');
    expect(redactSecrets('cdef tail', { V: 'abcdef' }, { cutAtStart: true })).toBe('[secret:V] tail');
    expect(redactSecrets('cdef tail', { V: 'abcdef' })).toBe('cdef tail');
  });

  it('quotes what is not plain and shows characters that would hide or reorder text', () => {
    expect(secretRunCommandLine('wrangler', ['deploy', '--env', 'prod'])).toBe('wrangler deploy --env prod');
    expect(secretRunCommandLine('sh', ['-c', "echo 'hi' && x"])).toBe("sh -c 'echo '\\''hi'\\'' && x'");
    expect(secretRunCommandLine('echo', [`safe${String.fromCharCode(0x202e)}txt`])).toBe("echo 'safe\\u{202E}txt'");
  });
});
