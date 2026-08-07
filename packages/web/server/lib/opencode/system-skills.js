import fs from 'fs';
import path from 'path';
import { SKILL_DIR, parseMdFile, writeMdFile } from './shared.js';

/**
 * OpenChamber-managed "system" skills.
 *
 * These skills ship with the OpenChamber server and are installed into the
 * user-level OpenCode skill directory (`~/.config/opencode/skills/<name>/`)
 * at startup so the agent can load them natively in every project — web,
 * desktop, and the Discord bridge all discover them through the same
 * skill-discovery paths OpenCode itself scans.
 *
 * Ownership contract: a system skill carries `managed-by: openchamber` in its
 * frontmatter and is refreshed on every server start (content is regenerated
 * with the current local API base URL). A skill file WITHOUT that marker is
 * user-owned and is never touched — users who want to customize a system
 * skill can simply remove the marker to take ownership.
 */

const MANAGED_BY_KEY = 'managed-by';
const MANAGED_BY_VALUE = 'openchamber';

/**
 * The `create-project` system skill — bootstraps a brand-new OpenChamber
 * project from inside a conversation: create/scaffold the folder, register it
 * with OpenChamber, write an AGENTS.md, and mirror it into Discord as a
 * channel the user can immediately chat in.
 */
function buildCreateProjectSkill({ apiBaseUrl }) {
  const api = `${apiBaseUrl}/api/messenger/agent`;
  const body = [
    '# Create a new OpenChamber project',
    '',
    'Use this skill when the user asks to create, bootstrap, scaffold, or clone a **new project** (a new folder / repository / workspace that should become its own OpenChamber project with its own Discord channel).',
    '',
    'This skill file is managed by OpenChamber and refreshed on server start. Remove the `managed-by` frontmatter field to take ownership of your edits.',
    '',
    '## Workflow',
    '',
    '### 1. Resolve the target location — ask, never guess',
    '',
    '- If the user already told you where to create the project (a folder or parent directory), use it. Resolve to an **absolute path**.',
    '- If the user did **not** specify a location, you MUST ask before creating anything. Suggest the OpenChamber projects root (`~/.config/openchamber/projects/<name>`) as the default and let the user confirm or provide a different folder.',
    '- Also confirm the project name if it is not obvious from the request.',
    '',
    '### 2. Create the project folder',
    '',
    'Pick the simplest path that matches the request:',
    '',
    '- **Empty project**: `mkdir -p <abs-path>` (optionally `git init`).',
    '- **Framework project**: use the official scaffolding CLI non-interactively (for example `npm create vite@latest <name> -- --template react-ts`, `cargo new <name>`, `uv init <name>`). Run it so the target folder ends up at the confirmed absolute path.',
    '- **Clone an existing repository**: skip this step — the registration endpoint below can clone for you (`action: "clone"`).',
    '',
    '### 3. Register the project with OpenChamber (auto-creates the Discord channel)',
    '',
    'Call the local OpenChamber API with bash curl. This registers the project so it appears in the OpenChamber UI **and**, when Discord is connected, finds-or-creates a Discord channel bound to the project:',
    '',
    '```bash',
    '# Folder you created in step 2 (or any existing directory):',
    `curl -s -X POST ${api}/create-project -H 'Content-Type: application/json' \\`,
    '  -d \'{"action":"path","path":"<abs-path>","label":"<Project Name>"}\'',
    '',
    '# Let the server create an empty directory for you (path optional):',
    `curl -s -X POST ${api}/create-project -H 'Content-Type: application/json' \\`,
    '  -d \'{"action":"new","path":"<abs-path>","label":"<Project Name>"}\'',
    '',
    '# Clone a git repository as the new project:',
    `curl -s -X POST ${api}/create-project -H 'Content-Type: application/json' \\`,
    '  -d \'{"action":"clone","url":"<git-url>","path":"<optional-abs-dest>","label":"<Project Name>"}\'',
    '```',
    '',
    'The response contains `project` (`{ id, path, label }`) and `discord` (`{ ok, channelId, channelName, url }` on success, or `{ ok: false, error }` when Discord is unavailable). Project registration and the Discord channel are independent: a Discord failure never rolls back the project — report it instead.',
    '',
    '### 4. Create AGENTS.md for the new project',
    '',
    '- Ask the user what kind of AGENTS.md the new project should have. Propose a concrete draft derived from:',
    '  - the **conversation context** (what the project is for, stack, conventions discussed), and',
    '  - the **AGENTS.md of the current project** you are running in — read it from the current working directory (or its worktree root) and reuse the sections that transfer (tooling, code style, validation commands), dropping anything project-specific that does not apply.',
    '- If the current project has no AGENTS.md, propose a minimal one: purpose, tech stack, build/test commands, and code conventions.',
    '- After the user confirms (or asks you to just do it), write `AGENTS.md` into the new project root.',
    '',
    '### 5. Report back',
    '',
    'Tell the user, in one compact message:',
    '',
    '- the absolute path of the new project and what was scaffolded,',
    '- that it is registered in OpenChamber (it appears in the project switcher),',
    '- the Discord channel: include `discord.url` from the response and say they can **start chatting in that channel right away** — messages there open sessions in the new project. If `discord.ok` is false, say the channel was not created and include the error.',
    '',
    '## Rules',
    '',
    '- Never create the project in a location the user did not confirm.',
    '- Never ask for or handle the Discord bot token — the server resolves it internally.',
    '- Use absolute paths in every API call.',
    '- If curl fails because the OpenChamber API is unreachable, report the error instead of silently skipping registration.',
  ].join('\n');

  return {
    name: 'create-project',
    frontmatter: {
      name: 'create-project',
      description:
        'Use when the user asks to create, bootstrap, scaffold, or clone a NEW project (new folder/repo/workspace). Creates the folder (CLI/scaffold/clone), registers it as an OpenChamber project, writes an AGENTS.md based on the conversation and the current AGENTS.md, and links a Discord channel the user can immediately chat in.',
      [MANAGED_BY_KEY]: MANAGED_BY_VALUE,
    },
    body,
  };
}

function buildReadSessionSkill({ apiBaseUrl }) {
  const api = `${apiBaseUrl}/api/messenger/agent`;
  const body = [
    '# Read another OpenChamber session',
    '',
    'Use this skill when the user pastes a **session id**, a **Discord thread URL**, or asks you to read another conversation from a different project/thread.',
    '',
    'Users copy the reference from the OpenChamber session sidebar (right-click → Copy session reference). Discord-bound sessions copy the thread URL; web-only sessions copy the session id.',
    '',
    'This skill file is managed by OpenChamber and refreshed on server start. Remove the `managed-by` frontmatter field to take ownership of your edits.',
    '',
    '## Workflow',
    '',
    '### 1. Identify the reference',
    '',
    'Accept any of these:',
    '',
    '- an OpenCode/OpenChamber session id such as `ses_…`',
    '- a Discord thread URL such as `https://discord.com/channels/<guild>/<thread>`',
    '- a raw Discord snowflake when the user copied the thread id directly',
    '',
    'If the user only pasted a public OpenCode share URL and no session id is available, ask them for the session id or Discord thread URL instead.',
    '',
    '### 2. Resolve the target (optional but recommended)',
    '',
    '```bash',
    `curl -s -X POST ${api}/resolve-reference -H 'Content-Type: application/json' \\`,
    '  -d \'{"reference":"<session-id-or-discord-url>"}\'',
    '```',
    '',
    'This returns `{ sessionId, directory, title, discordUrl, shareUrl, reference }` without downloading the full transcript.',
    '',
    '### 3. Read the transcript',
    '',
    '```bash',
    `curl -s -X POST ${api}/read-session -H 'Content-Type: application/json' \\`,
    '  -d \'{"reference":"<session-id-or-discord-url>","format":"markdown"}\'',
    '```',
    '',
    'The response includes `transcript` (markdown), `messageCount`, `title`, `directory`, and `projectLabel`.',
    '',
    'Use `format:"json"` only when you need structured message records for tooling.',
    '',
    '### 4. Answer using the fetched context',
    '',
    '- Summarize or quote the other conversation accurately.',
    '- Say which session/title/project you read when it helps the user orient.',
    '- If the API returns 404, tell the user the reference is unknown or the session was deleted.',
    '',
    '## Rules',
    '',
    '- Never invent transcript content — fetch it through the API first.',
    '- The API resolves sessions across registered OpenChamber projects; you do not need to switch projects manually.',
    '- Do not ask for Discord bot tokens or OpenChamber auth secrets.',
    '- If curl fails because the OpenChamber API is unreachable, report the error instead of guessing.',
  ].join('\n');

  return {
    name: 'read-session',
    frontmatter: {
      name: 'read-session',
      description:
        'Use when the user pastes a session id or Discord thread URL and wants you to read another OpenChamber conversation from any project/thread. Resolves the reference server-side and returns the full transcript.',
      [MANAGED_BY_KEY]: MANAGED_BY_VALUE,
    },
    body,
  };
}

/**
 * The `agent-browser` system skill — teaches agents how and when to drive the
 * shared OpenChamber browser surface the user is watching (navigate, click,
 * type, evaluate, screenshot, record) through the managed `openchamber_browser`
 * tool.
 */
function buildAgentBrowserSkill() {
  const body = [
    '# Drive the OpenChamber agent browser',
    '',
    'Use this skill when the user asks you to open, inspect, interact with, or capture a **web application** — a local or remote site — and wants to watch the same browser surface while you work.',
    '',
    'This skill file is managed by OpenChamber and refreshed on server start. Remove the `managed-by` frontmatter field to take ownership of your edits.',
    '',
    '## Tool',
    '',
    'Use the managed OpenCode tool **`openchamber_browser`**. One action per call. Operate on the active tab unless you pass `tabId`. Screenshots and recordings become inspectable artifacts in the Agent Browser panel the user can open from the context rail.',
    '',
    'Only `http` and `https` URLs can be opened. Bare `localhost:PORT`, `127.0.0.1:PORT`, and `:PORT` shorthands resolve against the OpenChamber server host where local/private dev servers live.',
    '',
    '## When to use',
    '',
    '- The user asks you to open, browse, click through, fill forms, or verify a web UI.',
    '- The user wants a screenshot or a recording of browser activity as an inspectable artifact.',
    '- The user asks you to check a local preview (`localhost`, `:5173`, a Vite/Next/etc. URL) that is running on the same machine as OpenChamber.',
    '',
    'Do **not** use this tool for:',
    '',
    '- Reading docs you can fetch with a normal web-fetch tool when the user does not need a live shared browser.',
    '- Delegating work that belongs in another session or scheduled task.',
    '',
    '## Workflow',
    '',
    '### 1. Inspect current state',
    '',
    'Call `openchamber_browser` with `action: "state"` and empty `parameters` to see open tabs, the active tab, and whether a recording is already running. If the surface reports it is unsupported, tell the user a Chrome-compatible browser is missing on the server (install Chrome/Chromium or set `OPENCHAMBER_BROWSER_PATH`) instead of inventing results.',
    '',
    '### 2. Open or navigate',
    '',
    '- New tab: `action: "tab.create"` with optional `url` and viewport `preset` (`desktop`, `laptop`, `tablet`, `mobile`).',
    '- Existing tab: `action: "navigate"` with `url` (and optional `tabId`).',
    '',
    'Prefer creating a tab when none exist. Prefer navigating the active tab when one already matches the task. Tell the user they can open **Agent Browser** in the context rail to watch live.',
    '',
    '### 3. Interact',
    '',
    '- `click` — requires viewport coordinates `x` and `y` in CSS pixels.',
    '- `type` — inserts `text` at the current focus (click or evaluate-to-focus first).',
    '- `key` — dispatches a key or combo such as `Enter`, `Tab`, `Escape`, `Control+A`, `Meta+Shift+ArrowLeft`.',
    '- `scroll` — optional `x`/`y` plus `deltaX`/`deltaY`.',
    '- `evaluate` — run a JavaScript `expression` in the page and return its value (use this to discover element positions, titles, and readiness).',
    '- `wait` — wait until a CSS `selector` exists or an `expression` is truthy; optional `timeout` in ms.',
    '- `viewport` — set a `preset` or custom `width`/`height` so responsive layouts can be checked.',
    '',
    'Discover click targets by evaluating the DOM (`getBoundingClientRect`) rather than guessing pixel coordinates. After each meaningful interaction, re-evaluate or wait so you act on authoritative page state.',
    '',
    '### 4. Capture',
    '',
    '- `screenshot` — capture the tab as an inspectable PNG artifact (`fullPage` optional).',
    '- `recording.start` / `recording.stop` — start and stop an explicit recording; stop produces an inspectable recording artifact. Only one recording can be active at a time. Start only when the user asks to record, or when a short capture of the interaction is clearly needed.',
    '',
    '### 5. Report back',
    '',
    'Tell the user, briefly:',
    '',
    '- which URL/tab you used,',
    '- what you verified or changed,',
    '- that screenshots/recordings are available as Captures in the Agent Browser panel.',
    '',
    'Never promise to keep watching a page after your turn ends; the user follows live activity in OpenChamber.',
    '',
    '## Rules',
    '',
    '- Prefer the shared browser surface over a private fetch when the user wants to see and control the same session.',
    '- Never open `file:`, `chrome:`, `javascript:`, or `data:` URLs — they are rejected.',
    '- Never invent page content; evaluate or screenshot to prove what you saw.',
    '- Keep recording visibility explicit: start and stop with the dedicated actions so the recording indicator is accurate for the user.',
    '- If a call returns `ok: false`, report the error and recover (for example create a tab first, or wait for a selector) instead of retrying blindly.',
  ].join('\n');

  return {
    name: 'agent-browser',
    frontmatter: {
      name: 'agent-browser',
      description:
        'Use when the user asks you to open, inspect, interact with, or capture a web application in the shared OpenChamber browser surface they can watch live. Drive tabs with the openchamber_browser tool: navigate, click, type, key, scroll, evaluate, wait, resize viewport, screenshot, and record.',
      [MANAGED_BY_KEY]: MANAGED_BY_VALUE,
    },
    body,
  };
}

/** Build every OpenChamber system skill for the given local API base URL. */
export function buildSystemSkills({ apiBaseUrl }) {
  return [
    buildCreateProjectSkill({ apiBaseUrl }),
    buildReadSessionSkill({ apiBaseUrl }),
    buildAgentBrowserSkill(),
  ];
}

/**
 * Install or refresh the OpenChamber system skills in the user skill dir.
 *
 * - Missing skill → installed.
 * - Existing skill with the `managed-by: openchamber` marker → rewritten when
 *   the generated content differs (e.g. the server port changed).
 * - Existing skill WITHOUT the marker → left untouched (user-owned).
 *
 * Returns per-skill results: { name, path, action } with action one of
 * 'installed' | 'updated' | 'unchanged' | 'skipped-user-owned'.
 */
export function syncSystemSkills({ apiBaseUrl, skillRootDir = SKILL_DIR }) {
  const results = [];
  for (const skill of buildSystemSkills({ apiBaseUrl })) {
    const skillDir = path.join(skillRootDir, skill.name);
    const skillPath = path.join(skillDir, 'SKILL.md');
    let action = 'installed';

    if (fs.existsSync(skillPath)) {
      let existing = { frontmatter: {}, body: '' };
      try {
        existing = parseMdFile(skillPath);
      } catch {
        // unreadable file — treat as user-owned rather than clobbering it
        results.push({ name: skill.name, path: skillPath, action: 'skipped-user-owned' });
        continue;
      }
      if (existing.frontmatter?.[MANAGED_BY_KEY] !== MANAGED_BY_VALUE) {
        results.push({ name: skill.name, path: skillPath, action: 'skipped-user-owned' });
        continue;
      }
      const sameBody = existing.body === skill.body.trim();
      const sameDescription =
        existing.frontmatter?.description === skill.frontmatter.description;
      if (sameBody && sameDescription) {
        results.push({ name: skill.name, path: skillPath, action: 'unchanged' });
        continue;
      }
      action = 'updated';
    }

    fs.mkdirSync(skillDir, { recursive: true });
    writeMdFile(skillPath, skill.frontmatter, skill.body);
    results.push({ name: skill.name, path: skillPath, action });
  }
  return results;
}
