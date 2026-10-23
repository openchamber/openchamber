import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const spaces = new URL('../spaces/', import.meta.url);
await fs.mkdir('/tmp/opencode', { recursive: true });
const root = await fs.mkdtemp('/tmp/opencode/bot-allocation-mutation-');
try {
  const source = await fs.readFile(new URL('journey.js', spaces), 'utf8');
  const protection = 'if (onAllocated) await onAllocated({ id, directory: entry.directory });';
  assert.equal(source.split(protection).length, 2);
  const copied = source.replace(protection, '/* mutation: allocation persistence omitted */')
    .replace(/from '(\.[^']+)'/g, (_all, relative) => `from '${new URL(relative, new URL('journey.js', spaces)).href}'`)
    .replace("from 'zod'", `from '${import.meta.resolve('zod')}'`);
  const mutant = path.join(root, 'journey.mjs'); await fs.writeFile(mutant, copied);
  const probe = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createMemoryPlace } from '${new URL('places/memory-place.js', spaces).href}';
import { createPlaceRegistry } from '${new URL('places/registry.js', spaces).href}';
import { createSpaceManager } from '${new URL('manager.js', spaces).href}';
import { createSpaceRecords } from '${new URL('space-records.js', spaces).href}';
const { createSpaceJourney } = await import(process.argv[2]);
const dataDir = await fs.mkdtemp('${root}/probe-');
const place=createMemoryPlace(); const registry=createPlaceRegistry([place]); registry.seal();
const manager=createSpaceManager({registry});
const journey=createSpaceJourney({manager,places:registry,records:createSpaceRecords({dataDir}),
  listProjectDirectories:async()=>['/driver/project'],folderExists:async()=>true,
  gatekeeper:{setNetwork:async()=>{},readPolicy:async()=>({grants:[]})},
  codeIn:{bringCodeIn:async({spaceId})=>({spacePath:'/spaces/'+spaceId+'/project',base:'a'.repeat(40),identityCopied:{name:true,email:true}}),sendHistory:async()=>({status:'sent'}),removeSpaceRefs:async()=>{}},
  serverInside:{writeIdleStop:async()=>{},writePermissionDefault:async()=>{}},spaceOpenCode:{},logger:{warn:()=>{}},
});
await assert.rejects(()=>journey.createBotSpace({projectDirectory:'/driver/project',name:'Bot worker'},
  {sourceDirectory:'/driver/worktree',onAllocated:async()=>{throw Error('disk full')}}),/disk full/);
assert.deepEqual(await place.list(),[],'A container was created before durable allocation');
await fs.rm(dataDir,{recursive:true,force:true});
`;
  const file = path.join(root, 'probe.mjs'); await fs.writeFile(file, probe);
  const run = (module) => spawnSync(process.execPath, [file, module], { encoding: 'utf8', timeout: 30_000 });
  const original = new URL('journey.js', spaces).href;
  const before = run(original); assert.equal(before.status, 0, before.stderr);
  const broken = run(pathToFileURL(mutant).href);
  assert.notEqual(broken.status, 0, 'The allocation regression survived its mutation');
  assert.match(broken.stderr, /Missing expected rejection/);
  const restored = run(original); assert.equal(restored.status, 0, restored.stderr);
  console.log(JSON.stringify({ protection: 'Persist allocation before creating a container', control: 'green', mutation: 'red: missing expected rejection', restored: 'green', module: fileURLToPath(new URL('journey.js', spaces)), dockerIsolation: 'not tested' }));

  const adapter = new URL('./isolated-stages.js', import.meta.url);
  const adapterSource = await fs.readFile(adapter, 'utf8');
  const toolProbe = `
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { Readable } from 'node:stream';
import { botDefinitionSchema } from '${new URL('./config.js', import.meta.url).href}';
import { digestMutationInput } from '${new URL('../source-control/mutation-executor.js', import.meta.url).href}';
const { createBotIsolatedStages } = await import(process.argv[2]);
const dataDir = await fs.mkdtemp('${root}/tools-');
try {
  const sessions = new Map(); const hostActions = []; let requests = [];
  const host = { manager: { verify: async () => [] }, journey: {
    readHostCustomProviders: async () => ({providers:[]}), readHostLogins: async () => ({logins:[{provider:'chosen',state:'usable'}]}),
    createBotSpace: async (_request, {onAllocated}) => onAllocated({id:'abcdef123456',directory:'/spaces/abcdef123456/project'}),
    listSpaces: async () => [{id:'abcdef123456',state:'running',access:'granted',grants:[{provider:'chosen'}]}],
  }, dispatcher: {requestInside: async (_space, value) => {
    const body = value.body ? JSON.parse(String(value.body)) : null;
    let result = {};
    if (value.path === '/api/session') { sessions.set(body.id, body); result = {data:body}; }
    else if (value.method === 'GET' && value.path.startsWith('/api/session/')) result = {data:sessions.get(value.path.split('/').at(-1))};
    else if (value.path.includes('isolated-tools?')) result = {requests};
    else if (value.path.endsWith('/settle')) {requests=[];result={settled:true};}
    const response = Readable.from([Buffer.from(JSON.stringify(result))]);response.statusCode=value.method==='PATCH'?204:200;response.complete=true;return response;
  }}};
  const adapter = createBotIsolatedStages({dataDir,getSpacesHost:()=>host,resolveProject:async()=>({id:'p',path:'/project'}),
    sessionKnowledgeRuntime:{collect:async()=>({notes:[],plans:[],memory:{enabled:false,complete:true,global:[],project:[]}})},
    handleTool:async(request)=>{hostActions.push(request);return {receipt:{id:'allowed'}};},
  });
  const bot = botDefinitionSchema.parse({id:'b',name:'Bot',mission:'Fix',isolated:true});
  const created=await adapter.create({projectId:'p',itemId:'i',directory:'/worktree',bot,stage:'fixing',prompt:'Fix',dispatchedAt:1,afterIdleId:null,
    selection:{providerID:'chosen',modelID:'model'}},async()=>{});
  const enqueue = (sessionId, callId) => {const request={sessionId,callId,action:'jira.comment',input:{operationId:callId,body:'Evidence'}};requests=[{id:digestMutationInput({sessionId,callId}),request}];};
  enqueue(created.sessionId,'allowed');
  assert.deepEqual(await adapter.forwardTools({spaceId:'abcdef123456',sessionId:created.sessionId}),{forwarded:1});
  assert.equal(hostActions.length,1,'The allowed host action did not execute');
  const wrongSpace=process.argv[3]==='space';
  enqueue(wrongSpace?created.sessionId:'ses_foreign','unbound');
  let refused=false;
  try {await adapter.forwardTools({spaceId:wrongSpace?'000000000000':'abcdef123456',sessionId:created.sessionId});}
  catch(error) {assert.equal(error.code,'BOT_ISOLATED_TOOL_SESSION_REQUIRED');refused=true;}
  assert.equal(hostActions.length,1,'An unbound tool request triggered a host action');
  assert.equal(refused,true,'The unbound tool request was not refused');
} finally {await fs.rm(dataDir,{recursive:true,force:true});}
`;
  const toolFile = path.join(root, 'tool-probe.mjs'); await fs.writeFile(toolFile, toolProbe);
  const runTool = (module, mode) => spawnSync(process.execPath, [toolFile, module, mode], { encoding: 'utf8', timeout: 30_000 });
  const protections = [
    ['space', 'binding.spaceId !== spaceId || ', ''],
    ['session', "    if (page.requests.some((entry) => entry.request.sessionId !== sessionId\n      || entry.id !== digestMutationInput({ sessionId, callId: entry.request.callId }))) refuse('BOT_ISOLATED_TOOL_SESSION_REQUIRED');", ''],
  ];
  for (const [mode, protection, replacement] of protections) {
    assert.equal(adapterSource.split(protection).length, 2);
    const source = adapterSource.replace(protection, replacement)
      .replace(/from '(\.[^']+)'/g, (_all, relative) => `from '${new URL(relative, adapter).href}'`)
      .replace("from 'zod'", `from '${import.meta.resolve('zod')}'`)
      .replace("from '@opencode/client'", `from '${import.meta.resolve('@opencode/client')}'`);
    const mutant = path.join(root, `isolated-stages-${mode}.mjs`); await fs.writeFile(mutant, source);
    const before = runTool(adapter.href, mode); assert.equal(before.status, 0, before.stderr);
    const broken = runTool(pathToFileURL(mutant).href, mode);
    assert.notEqual(broken.status, 0, `The ${mode} authority regression survived its mutation`);
    assert.match(broken.stderr, /An unbound tool request triggered a host action/);
    const restored = runTool(adapter.href, mode); assert.equal(restored.status, 0, restored.stderr);
    console.log(JSON.stringify({ protection: `Recorded isolated tool ${mode} authority`, control: 'green: allowed action and unbound refusal', mutation: 'red: unbound host action executed', restored: 'green', dockerIsolation: 'not tested' }));
  }
} finally { await fs.rm(root, { recursive: true, force: true }); }
