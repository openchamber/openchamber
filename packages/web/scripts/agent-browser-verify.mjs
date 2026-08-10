#!/usr/bin/env bun
/**
 * End-to-end verification of Agent Browser setup + capture artifacts.
 * Writes screenshots and an mp4 under /opt/cursor/artifacts (or ARTIFACT_DIR).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createBrowserRuntime } from '../server/lib/browser/runtime.js';
import { findBrowserExecutable } from '../server/lib/browser/chrome.js';
import { syncSystemSkills, buildSystemSkills } from '../server/lib/opencode/system-skills.js';

const artifactDir = process.env.ARTIFACT_DIR || '/opt/cursor/artifacts';
fs.mkdirSync(artifactDir, { recursive: true });

const searchPathFor = (name) => {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // continue
    }
  }
  return null;
};

const log = (step, detail = '') => {
  const line = detail ? `[verify] ${step}: ${detail}` : `[verify] ${step}`;
  console.log(line);
};

const writePng = async (runtime, name) => {
  const { artifact } = await runtime.executeAction('screenshot', {});
  const read = await runtime.readArtifact(artifact.id);
  const out = path.join(artifactDir, name);
  fs.writeFileSync(out, read.buffer);
  log('screenshot', `${out} (${read.buffer.length} bytes)`);
  return out;
};

const recordingToMp4 = async (runtime, artifactId, outName) => {
  const read = await runtime.readArtifact(artifactId);
  const manifest = JSON.parse(read.buffer.toString('utf8'));
  const frames = Array.isArray(manifest.frames) ? manifest.frames : [];
  if (frames.length === 0) {
    throw new Error('recording has no frames');
  }
  const frameDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-browser-frames-'));
  try {
    frames.forEach((frame, index) => {
      const data = typeof frame.data === 'string' ? frame.data : frame.data?.data;
      if (!data) throw new Error(`frame ${index} missing jpeg data`);
      const file = path.join(frameDir, `frame-${String(index).padStart(5, '0')}.jpg`);
      fs.writeFileSync(file, Buffer.from(data, 'base64'));
    });
    const out = path.join(artifactDir, outName);
    const fps = Math.max(1, Math.min(10, Math.round(frames.length / Math.max(1, (manifest.durationMs || 3000) / 1000))));
    const result = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-framerate',
        String(fps),
        '-i',
        path.join(frameDir, 'frame-%05d.jpg'),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        out,
      ],
      { encoding: 'utf8' },
    );
    if (result.status !== 0) {
      throw new Error(`ffmpeg failed: ${result.stderr?.slice(-800) || result.status}`);
    }
    log('video', `${out} (${frames.length} frames @ ~${fps}fps)`);
    return out;
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
};

const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>OpenChamber Agent Browser Setup</title>
  <style>
    :root { color-scheme: light; --ink:#1a2332; --accent:#0b6e4f; --wash:#e8f2ee; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh; font-family: "Iowan Old Style", "Palatino Linotype", Palatino, serif;
      color: var(--ink);
      background:
        radial-gradient(1200px 600px at 10% -10%, #cfe8dc 0%, transparent 55%),
        radial-gradient(900px 500px at 100% 0%, #d9e4f0 0%, transparent 50%),
        linear-gradient(165deg, #f7faf8, #eef3f0 40%, #e4ebe7);
      display: grid; place-items: center; padding: 32px;
    }
    main { width: min(720px, 100%); }
    h1 { font-size: 2.4rem; margin: 0 0 0.35em; letter-spacing: -0.02em; }
    p { font-size: 1.15rem; line-height: 1.45; margin: 0 0 1.25rem; max-width: 36ch; }
    label { display: block; font-size: 0.95rem; margin-bottom: 0.35rem; }
    input {
      width: 100%; padding: 0.7rem 0.85rem; border: 1.5px solid #9bb5a8; border-radius: 6px;
      background: rgba(255,255,255,0.85); font: inherit; margin-bottom: 1rem;
    }
    button {
      appearance: none; border: 0; background: var(--accent); color: #fff;
      padding: 0.75rem 1.25rem; border-radius: 6px; font: inherit; cursor: pointer;
    }
    button:hover { filter: brightness(1.05); }
    #status {
      margin-top: 1.25rem; padding: 0.85rem 1rem; background: var(--wash);
      border-left: 4px solid var(--accent); min-height: 3rem;
    }
  </style>
</head>
<body>
  <main>
    <h1>OpenChamber</h1>
    <p>Agent Browser setup verification — navigate, type, click, capture.</p>
    <label for="name">Project name</label>
    <input id="name" placeholder="openchamber-demo" />
    <button id="go" type="button">Confirm setup</button>
    <div id="status" role="status">Waiting for agent interaction…</div>
    <script>
      document.getElementById('go').addEventListener('click', () => {
        const name = document.getElementById('name').value.trim() || '(empty)';
        document.getElementById('status').textContent = 'Setup confirmed for: ' + name;
        document.title = 'Setup OK — ' + name;
      });
    </script>
  </main>
</body>
</html>`;

async function main() {
  const browserPath = findBrowserExecutable({ fs, path, env: process.env, searchPathFor });
  if (!browserPath) {
    console.error('[verify] FAIL: no Chrome/Chromium found. Install Chrome or set OPENCHAMBER_BROWSER_PATH.');
    process.exit(2);
  }
  log('chrome', browserPath);

  const skillRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-skill-verify-'));
  const skills = buildSystemSkills({ apiBaseUrl: 'http://127.0.0.1:4096' });
  const agentSkill = skills.find((s) => s.name === 'agent-browser');
  if (!agentSkill?.body?.includes('openchamber_browser')) {
    throw new Error('agent-browser system skill missing or incomplete');
  }
  const syncResults = syncSystemSkills({
    apiBaseUrl: 'http://127.0.0.1:4096',
    skillRootDir: skillRoot,
  });
  const installed = syncResults.find((r) => r.name === 'agent-browser');
  log('skill', `${installed?.action} → ${installed?.path}`);
  const skillCopy = path.join(artifactDir, 'agent-browser-SKILL.md');
  fs.copyFileSync(installed.path, skillCopy);
  log('skill-copy', skillCopy);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-browser-verify-'));
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(DEMO_HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  log('demo-page', baseUrl);

  const runtime = createBrowserRuntime({
    fs,
    fsPromises: fs.promises,
    path,
    spawn,
    crypto,
    dataDir,
    searchPathFor,
    idleShutdownMs: 5 * 60 * 1000,
  });

  try {
    if (!runtime.state().supported) {
      throw new Error('runtime.state().supported is false despite discovered Chrome');
    }

    await runtime.executeAction('tab.create', { url: baseUrl, preset: 'desktop' });
    await runtime.executeAction('wait', { selector: '#name', timeout: 10_000 });
    await writePng(runtime, '01-setup-landing.png');

    await runtime.executeAction('recording.start', {});
    await runtime.executeAction('evaluate', {
      expression: `(() => {
        const el = document.getElementById('name');
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    }).then(async ({ value }) => {
      await runtime.executeAction('click', { x: value.x, y: value.y });
    });
    await runtime.executeAction('type', { text: 'agent-browser-ready' });
    await writePng(runtime, '02-typed-project-name.png');

    const buttonBox = await runtime.executeAction('evaluate', {
      expression: `(() => {
        const el = document.getElementById('go');
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      })()`,
    });
    await runtime.executeAction('click', { x: buttonBox.value.x, y: buttonBox.value.y });
    await runtime.executeAction('wait', {
      expression: 'document.title.startsWith("Setup OK")',
      timeout: 5000,
    });
    await writePng(runtime, '03-setup-confirmed.png');

    // Extra frames for a clearer video
    await new Promise((r) => setTimeout(r, 400));
    await runtime.executeAction('viewport', { preset: 'tablet' });
    await new Promise((r) => setTimeout(r, 400));
    await runtime.executeAction('viewport', { preset: 'desktop' });
    await writePng(runtime, '04-viewport-restored.png');

    const { artifact } = await runtime.executeAction('recording.stop', {});
    await recordingToMp4(runtime, artifact.id, 'agent-browser-setup-demo.mp4');

    // Longer reviewable walkthrough from the key PNGs (screencast fps can be sparse).
    const walkthrough = path.join(artifactDir, 'agent-browser-setup-walkthrough.mp4');
    const walk = spawnSync(
      'ffmpeg',
      [
        '-y',
        '-loop', '1', '-t', '2.5', '-i', path.join(artifactDir, '01-setup-landing.png'),
        '-loop', '1', '-t', '2.5', '-i', path.join(artifactDir, '02-typed-project-name.png'),
        '-loop', '1', '-t', '2.5', '-i', path.join(artifactDir, '03-setup-confirmed.png'),
        '-loop', '1', '-t', '2.5', '-i', path.join(artifactDir, '04-viewport-restored.png'),
        '-filter_complex',
        '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0,format=yuv420p,scale=trunc(iw/2)*2:trunc(ih/2)*2',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
        walkthrough,
      ],
      { encoding: 'utf8' },
    );
    if (walk.status !== 0) {
      throw new Error(`walkthrough ffmpeg failed: ${walk.stderr?.slice(-800) || walk.status}`);
    }
    log('walkthrough', walkthrough);

    const summary = {
      ok: true,
      chrome: browserPath,
      skill: {
        name: 'agent-browser',
        action: installed.action,
        path: installed.path,
        copy: skillCopy,
      },
      artifacts: [
        '01-setup-landing.png',
        '02-typed-project-name.png',
        '03-setup-confirmed.png',
        '04-viewport-restored.png',
        'agent-browser-setup-demo.mp4',
        'agent-browser-setup-walkthrough.mp4',
        'agent-browser-SKILL.md',
      ].map((name) => path.join(artifactDir, name)),
      setup: [
        'Install Chrome/Chromium or set OPENCHAMBER_BROWSER_PATH',
        'Keep agentControlToolEnabled enabled (default) with managed OpenCode',
        'Start OpenChamber server — syncs agent-browser skill to ~/.config/opencode/skills/',
        'Open Agent Browser in the context rail; agents use openchamber_browser',
      ],
    };
    const summaryPath = path.join(artifactDir, 'agent-browser-verify-summary.json');
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    log('summary', summaryPath);
    log('DONE', 'setup + skill + screenshots + video verified');
  } finally {
    await runtime.shutdown();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(skillRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('[verify] FAIL', err);
  process.exit(1);
});
