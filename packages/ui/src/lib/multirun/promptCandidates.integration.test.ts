import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { opencodeClient } from '@/lib/opencode/client';
import { configureRuntimeUrlResolver } from '@/lib/runtime-url';
import { initializeRuntimeEndpoint } from '@/lib/runtime-switch';
import { generatePromptCandidates, selectPromptCandidates, type PromptCandidate } from './promptCandidates';

const url = process.env.MULTIRUN_TEST_URL;
const root = process.env.MULTIRUN_TEST_ROOT;
// This opt-in uses a real OpenCode instance. The normal suite reports a skip,
// because pointing it at the user's running app would not be an isolated test.
const runtimeTest = url && root ? test : test.skip;

runtimeTest('real OpenCode generates candidates with selected aliases and effort, retaining partial successes', async () => {
  if (!url || !root) throw new Error('Isolated runtime parameters missing');
  const endpoint = new URL(url);
  if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname)) throw new Error('Test server must be loopback');
  const fixtureRoot = realpathSync(root);
  const settingsResponse = await fetch(new URL('/api/config/settings', endpoint));
  if (!settingsResponse.ok) throw new Error('Could not verify the isolated server');
  const settings = z.object({ projects: z.array(z.object({ path: z.string() })) }).parse(await settingsResponse.json());
  if (!settings.projects.some((project) => resolve(project.path) === join(fixtureRoot, 'project'))) throw new Error('Server is not the isolated fixture');

  // Oracle: fixed candidate outputs plus independently observed OpenAI requests.
  // The HTTP server is synthetic and exposes no filesystem or tool operations.
  const outputs = new Map<string, Array<Omit<PromptCandidate, 'id' | 'model'>>>([
    ['wire-a', [
      { title: 'Parser tests', text: 'Review api_v2 with tests.', kind: 'variation' },
      { title: 'New accessibility task', text: 'Create a new accessibility audit.', kind: 'new' },
    ]],
    ['wire-b', [
      { title: 'Parser errors', text: 'Review api_v2 error handling.', kind: 'variation' },
      { title: 'New performance task', text: 'Create a new performance audit.', kind: 'new' },
    ]],
  ]);
  const requestSchema = z.object({
    model: z.string(),
    messages: z.array(z.object({ content: z.union([
      z.string(), z.array(z.object({ type: z.literal('text'), text: z.string() })).transform((parts) => parts.map((part) => part.text).join('\n')),
    ]) })),
    stream: z.boolean().optional(),
    tools: z.array(z.json()).optional(),
    fixture_effort: z.string().optional(),
  });
  const received: Array<z.infer<typeof requestSchema>> = [];
  const paths: string[] = [];
  const rejected: string[] = [];
  const provider = createServer(async (request, response) => {
    paths.push(request.url ?? '');
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return; }
    try {
      request.setEncoding('utf8');
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        // This fixture accepts only small synthetic prompts, not user data.
        if (raw.length > 1_048_576) throw new Error('Synthetic request too large');
      }
      const body = requestSchema.parse(JSON.parse(raw));
      received.push(body);
      const content = body.model === 'wire-invalid' ? 'Invalid candidate JSON' : JSON.stringify({ candidates: outputs.get(body.model) });
      const envelope = { id: 'chatcmpl-candidates', object: 'chat.completion', created: 1, model: body.model };
      if (body.stream) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(`data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] })}\n\n`);
        response.write(`data: ${JSON.stringify({ ...envelope, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
      } else {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ...envelope, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }));
      }
    } catch (error) {
      rejected.push(String(error));
      response.writeHead(400).end('Invalid synthetic request');
    }
  });
  await new Promise<void>((ready, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', ready); });
  const globalConfigFile = join(fixtureRoot, 'state', 'home', '.config', 'opencode', 'opencode.json');
  let writtenGlobal: string | undefined;
  try {
    const address = z.object({ port: z.number().int().positive() }).parse(provider.address());
    const directory = mkdtempSync(join(fixtureRoot, 'candidate-generation-'));
    const marker = join(directory, 'retained-artifact.txt');
    writeFileSync(marker, 'Source artifact stays unchanged.\n');
    // Refuse to overwrite an existing configuration, even in the isolated home.
    mkdirSync(join(fixtureRoot, 'state', 'home', '.config', 'opencode'), { recursive: true });
    const globalContent = JSON.stringify({
      providers: { 'prompt-fixture': {
        name: 'Prompt generation fixture', package: '@opencode/ai/providers/openai-compatible',
        settings: { baseURL: `http://127.0.0.1:${address.port}/v1`, apiKey: 'unused' },
        models: {
          'candidate-a': { modelID: 'wire-a', variants: [{ id: 'careful', body: { fixture_effort: 'careful' } }] },
          'candidate-b': { modelID: 'wire-b' },
          'invalid-format': { modelID: 'wire-invalid' },
        },
      } },
    });
    writeFileSync(globalConfigFile, globalContent, { flag: 'wx' });
    writtenGlobal = globalContent;
    // This fourth model appears in the project picker but cannot be selected
    // by OpenCode's stateless Generate handler, which uses global.config.
    writeFileSync(join(directory, 'opencode.json'), JSON.stringify({ providers: { 'prompt-fixture': { models: { 'project-only': { modelID: 'wire-project' } } } } }));
    configureRuntimeUrlResolver({ apiBaseUrl: endpoint.origin });
    initializeRuntimeEndpoint({ apiBaseUrl: endpoint.origin });
    opencodeClient.reconnectToRuntimeBaseUrl();
    const catalog = await opencodeClient.getProvidersForConfig(directory, { fresh: true });
    expect(catalog.models.filter((model) => model.providerID === 'prompt-fixture').map((model) => model.id).sort()).toEqual(['candidate-a', 'candidate-b', 'invalid-format', 'project-only']);
    const models = [
      { providerID: 'prompt-fixture', id: 'candidate-a', variant: 'careful' },
      { providerID: 'prompt-fixture', id: 'candidate-b' },
      { providerID: 'prompt-fixture', id: 'invalid-format' },
      { providerID: 'prompt-fixture', id: 'project-only' },
    ];
    const failures: string[] = [];
    const result = await generatePromptCandidates({ original: 'Review api_v2', description: 'One variation and one new prompt from each model', models, directory }, async (prompt, options) => {
      try { return await opencodeClient.generateText(prompt, options); }
      catch (error) { failures.push(String(error)); throw error; }
    });
    if (result.candidates.length === 0) throw new Error(JSON.stringify({ paths, rejected, failures }));
    expect(result.candidates.map((candidate) => candidate.text)).toEqual([
      'Review api_v2 with tests.', 'Create a new accessibility audit.',
      'Review api_v2 error handling.', 'Create a new performance audit.',
    ]);
    expect(result.failures).toEqual([{ model: models[2], reason: 'generation' }, { model: models[3], reason: 'model-unavailable' }]);
    expect(result.candidates.map((candidate) => candidate.model)).toEqual([models[0], models[0], models[1], models[1]]);
    expect(received.map((request) => request.model).sort()).toEqual(['wire-a', 'wire-b', 'wire-invalid']);
    expect(received.find((request) => request.model === 'wire-a')?.fixture_effort).toBe('careful');
    expect(received.every((request) => request.tools === undefined)).toBe(true);
    for (const request of received) {
      expect(request.messages.map((message) => message.content).join('\n')).toContain('Review api_v2');
      expect(request.messages.map((message) => message.content).join('\n')).toContain('One variation and one new prompt from each model');
    }
    expect(selectPromptCandidates(result.candidates, new Set([result.candidates[0].id, result.candidates[3].id])).map((candidate) => candidate.text)).toEqual(['Review api_v2 with tests.', 'Create a new performance audit.']);
    expect(readFileSync(marker, 'utf8')).toBe('Source artifact stays unchanged.\n');
  } finally {
    // Only remove the file this test wrote, and leave any concurrent change.
    if (writtenGlobal && existsSync(globalConfigFile) && readFileSync(globalConfigFile, 'utf8') === writtenGlobal) unlinkSync(globalConfigFile);
    await new Promise<void>((closed, reject) => provider.close((error) => error ? reject(error) : closed()));
  }
}, 120_000);
