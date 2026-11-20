// external: https://github.com/anomalyco/opencode/blob/v2.3.2/packages/cli/src/server-process.ts
import './plugin-runtime.mjs';

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { Effect, Schema } from 'effect';
import { HttpServer } from 'effect/http';
import { PersistentPty } from '@opencode/schema/persistent-pty';
import { start } from '@opencode/server/process';
import { Global } from '@opencode/util/global';
import { LayerNode } from '@opencode/util/effect/layer-node';
import { Observability } from '@opencode/util/observability';
import { AppProcess } from '@opencode/util/process';

const OPENCODE_CHANNEL = 'latest';
const OPENCODE_ARTIFACT = 'openchamber-desktop';

const truthy = (value) => value === '1' || value?.toLowerCase() === 'true';

const databasePath = (data) => {
  const filename = process.env.OPENCODE_DB ?? 'opencode.db';
  return filename === ':memory:' ? filename : path.resolve(data, filename);
};

const waitForStdinClose = () => Effect.callback((resume) => {
  const close = () => resume(Effect.void);
  process.stdin.once('end', close);
  process.stdin.once('close', close);
  process.stdin.resume();
  if (process.stdin.readableEnded || process.stdin.destroyed) close();
  return Effect.sync(() => {
    process.stdin.off('end', close);
    process.stdin.off('close', close);
    process.stdin.pause();
  });
});

const readHandoff = Effect.fnUntraced(function* () {
  const inherited = process.env.OPENCODE_PTY_HANDOFF;
  delete process.env.OPENCODE_PTY_HANDOFF;
  if (inherited === undefined) return undefined;
  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PersistentPty.Handoff))(inherited).pipe(
    Effect.catch(() => Effect.logWarning('Ignoring invalid PTY restart handoff; persistent terminals will start fresh').pipe(Effect.as(undefined))),
  );
});

const serve = Effect.fnUntraced(function* (options) {
  const handoff = yield* readHandoff();
  const global = yield* Global.Service;
  const environmentPassword = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD || undefined;
  if (options.mode === 'stdio') {
    delete process.env.OPENCODE_PASSWORD;
    delete process.env.OPENCODE_SERVER_PASSWORD;
  }
  const password = environmentPassword ?? randomBytes(32).toString('base64url');
  const server = yield* start({
    app: {
      name: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
      version: options.version,
      channel: OPENCODE_CHANNEL,
    },
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port,
    cors: options.cors.length > 0 ? options.cors : undefined,
    password,
    pty: { handoff },
    simulation: truthy(process.env.OPENCODE_SIMULATE),
    database: { path: databasePath(global.data) },
    models: {
      url: process.env.OPENCODE_MODELS_URL,
      file: process.env.OPENCODE_MODELS_PATH,
      fetch: !truthy(process.env.OPENCODE_DISABLE_MODELS_FETCH),
    },
    config: {
      directory: process.env.OPENCODE_CONFIG_DIR,
      project: !truthy(process.env.OPENCODE_CONFIG_PROJECT_DISABLE ?? process.env.OPENCODE_DISABLE_PROJECT_CONFIG),
      claude: !(truthy(process.env.OPENCODE_DISABLE_CLAUDE_CODE) || truthy(process.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS)),
      file: process.env.OPENCODE_CONFIG,
      content: process.env.OPENCODE_CONFIG_CONTENT,
    },
    instructions: {
      claude: !(truthy(process.env.OPENCODE_DISABLE_CLAUDE_CODE) || truthy(process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT)),
    },
    windows: { gitbash: process.env.OPENCODE_GIT_BASH_PATH },
    fs: {
      filewatcher: !truthy(process.env.OPENCODE_FILEWATCHER_DISABLE ?? process.env.OPENCODE_DISABLE_FILEWATCHER),
      fff: process.env.OPENCODE_DISABLE_FFF === undefined ? process.platform !== 'win32' : !truthy(process.env.OPENCODE_DISABLE_FFF),
    },
  });
  const url = HttpServer.formatAddress(server.address);
  console.log(options.mode === 'stdio' ? JSON.stringify({ url }) : `server listening on ${url}`);
  if (!environmentPassword) console.log(`server password ${password}`);
  return yield* options.mode === 'stdio' ? waitForStdinClose() : Effect.never;
});

export const run = (options) => {
  Effect.scoped(serve(options)).pipe(
    Effect.annotateLogs({ role: 'server' }),
    Effect.provide(LayerNode.compile(LayerNode.group([Global.node, AppProcess.node]), {
      replacements: [
        Global.node.replace(Global.layerWith(process.env.OPENCODE_CONFIG_DIR ? { config: process.env.OPENCODE_CONFIG_DIR } : {})),
      ],
    })),
    Effect.provide(Observability.layer({
      endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: process.env.OTEL_EXPORTER_OTLP_HEADERS,
      client: process.env.OPENCODE_CLIENT ?? OPENCODE_ARTIFACT,
      version: options.version,
      channel: OPENCODE_CHANNEL,
    })),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
};
