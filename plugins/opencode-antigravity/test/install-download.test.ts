import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  ASSET_ORIGIN,
  CHECKSUM_MESSAGE,
  SIZE_MESSAGE,
  diskSpaceMessage,
  downloadAsset,
  networkFailureMessage,
  safeFetch,
} from "../src/install/download.ts";
import type { AgyManifest } from "../src/install/manifest.ts";
import { TempDirs, mappedFetch, messageOf, rejection, serve, sha512, sleep, type LocalServer } from "./fixtures/install-helpers.ts";

const temps = new TempDirs();
const servers: LocalServer[] = [];
const rawServers: Server[] = [];
afterEach(() => {
  temps.cleanup();
  while (servers.length) servers.pop()?.stop();
  while (rawServers.length) rawServers.pop()?.close();
});

const ASSET_PATH = "/antigravity-public/antigravity-cli/1.5.16-1/darwin-arm/cli_mac_arm64.tar.gz";
const FOREIGN = "https://evil.example";
const BODY = Buffer.alloc(200_000, 7);

function manifestFor(body: Buffer, assetPath = ASSET_PATH): AgyManifest {
  return { version: "1.5.16", url: `${ASSET_ORIGIN}${assetPath}`, sha512: sha512(body) };
}

function local(handler: Parameters<typeof serve>[0]): LocalServer {
  const s = serve(handler);
  servers.push(s);
  return s;
}

/** A raw HTTP server for responses Bun.serve will not produce. Resolves to its base URL. */
async function raw(onRequest: (socket: Socket) => void): Promise<string> {
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", () => onRequest(socket));
  });
  rawServers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

function staging(): string {
  return path.join(temps.make(), "versions", ".install-test");
}

const noDiskCheck = { freeBytes: async () => null };

describe("downloadAsset", () => {
  test("good bytes: file written, digest matches", async () => {
    const asset = local(() => new Response(BODY));
    const dir = staging();
    const result = await downloadAsset(manifestFor(BODY), dir, { fetch: mappedFetch({ [ASSET_ORIGIN]: asset.url }), ...noDiskCheck });
    expect(result.bytes).toBe(BODY.length);
    expect(readFileSync(result.file).equals(BODY)).toBe(true);
  });

  test("digest mismatch: checksum message, staging dir removed", async () => {
    const asset = local(() => new Response(BODY));
    const dir = staging();
    const err = await rejection(
      downloadAsset({ ...manifestFor(BODY), sha512: "0".repeat(128) }, dir, { fetch: mappedFetch({ [ASSET_ORIGIN]: asset.url }), ...noDiskCheck }),
    );
    expect(messageOf(err)).toBe(CHECKSUM_MESSAGE);
    expect(existsSync(dir)).toBe(false);
  });

  test("404", async () => {
    const asset = local(() => new Response("nope", { status: 404 }));
    const dir = staging();
    const err = await rejection(downloadAsset(manifestFor(BODY), dir, { fetch: mappedFetch({ [ASSET_ORIGIN]: asset.url }), ...noDiskCheck }));
    expect(messageOf(err)).toBe(networkFailureMessage("HTTP 404"));
    expect(existsSync(dir)).toBe(false);
  });

  test("Content-Length larger than the body", async () => {
    const base = await raw((socket) => {
      socket.write("HTTP/1.1 200 OK\r\nContent-Length: 1000\r\nConnection: close\r\n\r\n");
      socket.end(Buffer.alloc(10, 1));
    });
    const dir = staging();
    const err = await rejection(downloadAsset(manifestFor(BODY), dir, { fetch: mappedFetch({ [ASSET_ORIGIN]: base }), ...noDiskCheck }));
    expect(messageOf(err).startsWith("Could not download Antigravity from Google:")).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("Content-Length over 512 MiB is refused before the body is read", async () => {
    let bodyWritten = false;
    const base = await raw((socket) => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${600 * 1024 * 1024}\r\n\r\n`);
      setTimeout(() => {
        bodyWritten = true;
        socket.destroy();
      }, 2_000);
    });
    const started = Date.now();
    const err = await rejection(downloadAsset(manifestFor(BODY), staging(), { fetch: mappedFetch({ [ASSET_ORIGIN]: base }), ...noDiskCheck }));
    expect(messageOf(err)).toBe(SIZE_MESSAGE);
    expect(bodyWritten).toBe(false);
    expect(Date.now() - started < 1_500).toBe(true);
  });

  test("body over the cap (no Content-Length)", async () => {
    const asset = local(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(BODY));
              controller.close();
            },
          }),
        ),
    );
    const dir = staging();
    const err = await rejection(
      downloadAsset(manifestFor(BODY), dir, { fetch: mappedFetch({ [ASSET_ORIGIN]: asset.url }), maxBytes: 1000, ...noDiskCheck }),
    );
    expect(messageOf(err)).toBe(SIZE_MESSAGE);
    expect(existsSync(dir)).toBe(false);
  });

  test("not enough free space", async () => {
    const dir = staging();
    const err = await rejection(downloadAsset(manifestFor(BODY), dir, { fetch: async () => new Response(BODY), freeBytes: async () => 1 }));
    expect(messageOf(err)).toBe(diskSpaceMessage(path.dirname(dir)));
  });

  test("a redirect to a foreign host is refused; the foreign host gets no request", async () => {
    const foreign = local(() => new Response(BODY));
    const asset = local(() => new Response(null, { status: 302, headers: { location: `${FOREIGN}/x` } }));
    const dir = staging();
    const err = await rejection(
      downloadAsset(manifestFor(BODY), dir, { fetch: mappedFetch({ [ASSET_ORIGIN]: asset.url, [FOREIGN]: foreign.url }), ...noDiskCheck }),
    );
    expect(messageOf(err)).toBe(networkFailureMessage("the download location is not a Google server"));
    expect(foreign.hits.length).toBe(0);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("safeFetch", () => {
  test("https to http on the allowed host is refused before the second request", async () => {
    const calls: string[] = [];
    const asset = local((_req, url) =>
      url.pathname === "/first" ? new Response(null, { status: 301, headers: { location: "http://storage.googleapis.com/second" } }) : new Response("ok"),
    );
    const err = await rejection(
      safeFetch(`${ASSET_ORIGIN}/first`, { allowedOrigins: [ASSET_ORIGIN], stallMs: 2_000, fetch: mappedFetch({ [ASSET_ORIGIN]: asset.url }, calls) }),
    );
    expect(messageOf(err)).toBe(networkFailureMessage("the download location is not a Google server"));
    expect(asset.hits).toEqual(["/first"]);
    expect(calls.length).toBe(1);
  });

  test("allowed to foreign to allowed is refused at the foreign hop", async () => {
    const foreign = local(() => new Response(null, { status: 302, headers: { location: `${ASSET_ORIGIN}/back` } }));
    const asset = local((_req, url) => (url.pathname === "/start" ? new Response(null, { status: 307, headers: { location: `${FOREIGN}/hop` } }) : new Response("ok")));
    const err = await rejection(
      safeFetch(`${ASSET_ORIGIN}/start`, { allowedOrigins: [ASSET_ORIGIN], stallMs: 2_000, fetch: mappedFetch({ [ASSET_ORIGIN]: asset.url, [FOREIGN]: foreign.url }) }),
    );
    expect(messageOf(err)).toBe(networkFailureMessage("the download location is not a Google server"));
    expect(foreign.hits.length).toBe(0);
    expect(asset.hits).toEqual(["/start"]);
  });

  test("five hops are followed; six are refused", async () => {
    const asset = local((_req, url) => {
      const n = Number(url.pathname.slice(3));
      return n > 0 ? new Response(null, { status: 302, headers: { location: `/r/${n - 1}` } }) : new Response("done");
    });
    const fetch = mappedFetch({ [ASSET_ORIGIN]: asset.url });
    const ok = await safeFetch(`${ASSET_ORIGIN}/r/5`, { allowedOrigins: [ASSET_ORIGIN], stallMs: 2_000, fetch });
    expect(await ok.response.text()).toBe("done");
    ok.timers.done();
    const err = await rejection(safeFetch(`${ASSET_ORIGIN}/r/6`, { allowedOrigins: [ASSET_ORIGIN], stallMs: 2_000, fetch }));
    expect(messageOf(err)).toBe(networkFailureMessage("too many redirects"));
  });

  test("userinfo and a non-default port are refused before any request", async () => {
    const calls: string[] = [];
    const fetch = mappedFetch({}, calls);
    for (const url of ["https://user@storage.googleapis.com/x", "https://storage.googleapis.com:8443/x"]) {
      const err = await rejection(safeFetch(url, { allowedOrigins: [ASSET_ORIGIN], stallMs: 1_000, fetch }));
      expect(messageOf(err)).toBe(networkFailureMessage("the download location is not a Google server"));
    }
    expect(calls.length).toBe(0);
  });

  test("the request carries Accept-Encoding: identity", async () => {
    let seen: string | null = null;
    const asset = local((req) => {
      seen = req.headers.get("accept-encoding");
      return new Response("ok");
    });
    const result = await safeFetch(`${ASSET_ORIGIN}/x`, { allowedOrigins: [ASSET_ORIGIN], stallMs: 2_000, fetch: mappedFetch({ [ASSET_ORIGIN]: asset.url }) });
    result.timers.done();
    expect(seen).toBe("identity");
  });

  test("a response with Content-Encoding: gzip is refused", async () => {
    const gz = gzipSync(BODY);
    const base = await raw((socket) => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: ${gz.length}\r\nConnection: close\r\n\r\n`);
      socket.end(gz);
    });
    const dir = staging();
    const err = await rejection(downloadAsset(manifestFor(BODY), dir, { fetch: mappedFetch({ [ASSET_ORIGIN]: base }), ...noDiskCheck }));
    expect(messageOf(err)).toBe(networkFailureMessage("the server sent a compressed response"));
    expect(existsSync(dir)).toBe(false);
  });

  test("stall mid-body aborts", async () => {
    const base = await raw((socket) => {
      socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${BODY.length}\r\n\r\n`);
      socket.write(BODY.subarray(0, 1000));
      setTimeout(() => socket.destroy(), 2_000);
    });
    const dir = staging();
    const started = Date.now();
    const err = await rejection(downloadAsset(manifestFor(BODY), dir, { fetch: mappedFetch({ [ASSET_ORIGIN]: base }), stallMs: 200, ...noDiskCheck }));
    expect(messageOf(err)).toBe(networkFailureMessage("the connection stalled"));
    expect(Date.now() - started < 1_500).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  test("stall before headers aborts", async () => {
    const base = await raw((socket) => {
      setTimeout(() => socket.destroy(), 2_000);
    });
    const started = Date.now();
    const err = await rejection(downloadAsset(manifestFor(BODY), staging(), { fetch: mappedFetch({ [ASSET_ORIGIN]: base }), stallMs: 200, ...noDiskCheck }));
    expect(messageOf(err)).toBe(networkFailureMessage("the connection stalled"));
    expect(Date.now() - started < 1_500).toBe(true);
  });

  test("nothing is left behind in the versions dir after failures", async () => {
    const asset = local(() => new Response("nope", { status: 500 }));
    const dir = staging();
    await rejection(downloadAsset(manifestFor(BODY), dir, { fetch: mappedFetch({ [ASSET_ORIGIN]: asset.url }), ...noDiskCheck }));
    await sleep(10);
    expect(readdirSync(path.dirname(dir))).toEqual([]);
  });
});
