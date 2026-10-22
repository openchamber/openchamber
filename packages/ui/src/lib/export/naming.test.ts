/**
 * The export document's own naming.
 *
 * The document names the agent that produced each message instead of a role
 * of its own, it names both the agent and the session of work that ran at
 * the same time, and it says plainly when the export is incomplete. These
 * tests hold those three contracts, and they hold them for the Markdown and
 * the HTML at once: a reader compares the two formats, and a name that
 * differs between them reads as two different things.
 */

import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { buildExportFromRecords } from './pipeline';
import { renderExportMarkdown } from './markdown';
import { renderExportHtml } from './html';
import {
  assistantMessage,
  subagentCall,
  textPart,
  userMessage,
  type Record_,
} from './fixtures';

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  projectID: 'proj_1',
  directory: '/repo',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  ...overrides,
});

type Fixture = {
  root: Session;
  sessions: Session[];
  records: Map<string, Record_[]>;
};

const fixture = (parts: {
  root: Session;
  sessions?: Session[];
  records: Record<string, Record_[]>;
}): Fixture => ({
  root: parts.root,
  sessions: parts.sessions ?? [parts.root],
  records: new Map(Object.entries(parts.records)),
});

const build = (input: Fixture, mode: 'readable' | 'detailed' = 'readable') => (
  buildExportFromRecords({
    root: input.root,
    sessions: input.sessions,
    records: input.records,
  }, mode)
);

const markdown = (input: Fixture, mode: 'readable' | 'detailed' = 'readable'): string => {
  const { projection, timeline, rootAgent } = build(input, mode);
  return renderExportMarkdown(projection, {
    title: input.root.title,
    mode,
    findings: timeline.findings, excluded: timeline.excluded,
    sessionCount: timeline.sessions.size,
    rootAgent,
  });
};

const html = (input: Fixture, mode: 'readable' | 'detailed' = 'readable'): string => {
  const { projection, timeline, rootAgent } = build(input, mode);
  return renderExportHtml(projection, {
    title: input.root.title,
    mode,
    findings: timeline.findings, excluded: timeline.excluded,
    sessionCount: timeline.sessions.size,
    rootAgent,
  });
};

/** The agent the page's own attributes name, for each entry. */
const domAgents = (document: string): Map<string, string> => {
  const agents = new Map<string, string>();
  for (const match of document.matchAll(/data-id="([^"]*)"[^>]*data-agent="([^"]*)"/g)) {
    agents.set(match[1], match[2]);
  }
  return agents;
};

/** The data the page's own script filters over. */
const pageData = (document: string): { entries: Array<{ id: string; agent?: string; search: string }>; agents: string[] } => {
  const match = document.match(/<script type="application\/json" id="export-data">([\s\S]*?)<\/script>/);
  expect(match).toBeTruthy();
  // SAFETY: the export writes the data block itself, so the match holds the
  // page's own data.
  return JSON.parse(match![1]);
};

describe('the document names the agent', () => {
  test('the root session\'s own messages carry the agent that wrote them', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Do the work'),
          assistantMessage('ses_root', 'a1', 2000, 'Starting', { agent: 'code-orchestrator' }),
        ],
      },
    });

    const output = markdown(input);

    // The agent has a name, and the document uses it. The term the export
    // used before — a role of its own — is gone from the document.
    expect(output).toContain('code-orchestrator');
    expect(output).not.toContain('Orchestrator');
  });

  test('a session that recorded no agent gets a neutral label, not a made-up one', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Do the work')],
      },
    });

    const output = markdown(input);

    expect(output).not.toContain('Orchestrator');
  });

  test('a message that recorded no agent either gets the neutral label', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [{
          info: {
            id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: '',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
          },
          parts: [textPart('a1', 'Starting')],
        }],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Assistant');
    expect(output).not.toContain('Orchestrator');
  });

  test('the HTML names the same agent the Markdown does', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
      records: {
        ses_root: [assistantMessage('ses_root', 'a1', 2000, 'Starting', { agent: 'code-orchestrator' })],
      },
    });

    const document = html(input);

    expect(document).toContain('code-orchestrator');
    expect(document).not.toContain('>Orchestrator<');
  });

  test('a sub-agent\'s own messages carry the sub-agent, not the root agent', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
      sessions: [
        session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'build' }),
      ],
      records: {
        ses_root: [{
          info: {
            id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'code-orchestrator',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
          },
          parts: [textPart('a1', 'Root work'), subagentCall('a1', { childSessionID: 'ses_child' })],
        }],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work', { agent: 'build' })],
      },
    });

    const output = markdown(input);

    expect(output).toContain('↳ build');
    expect(output).toContain('code-orchestrator');
  });
});

describe('the HTML agent filter offers the name the document shows', () => {
  test('the root\'s own entries carry the root agent, not the agent a call asked for', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
      sessions: [
        session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'build' }),
      ],
      records: {
        ses_root: [{
          info: {
            id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'code-orchestrator',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
          },
          // The call asked for the build agent; the call itself belongs to
          // the session that made it.
          parts: [textPart('a1', 'Root work'), subagentCall('a1', { childSessionID: 'ses_child', agent: 'build' })],
        }],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work', { agent: 'build' })],
      },
    });

    const document = html(input);
    const data = pageData(document);
    const agents = domAgents(document);

    // The filter's value and the document's label are one name.
    for (const entry of data.entries) {
      expect(agents.get(entry.id) ?? '').toBe(entry.agent ?? '');
    }
    expect(data.agents).toContain('code-orchestrator');
    expect(data.agents).toContain('build');
  });

  test('a message is signed with the agent that wrote it', () => {
    // The session ran one agent and then switched to another. Each message
    // carries the name of the agent that wrote it, so the second message is
    // not signed with the session's own agent.
    const input = fixture({
      root: session('ses_root', { title: 'Root', agent: 'planner' }),
      sessions: [session('ses_root', { title: 'Root', agent: 'planner' })],
      records: {
        ses_root: [
          assistantMessage('ses_root', 'a1', 1000, 'Planned by planner', { agent: 'planner' }),
          {
            info: {
              id: 'sw1', sessionID: 'ses_root', role: 'agent-switched', agent: 'builder',
              time: { created: 1500 },
            },
            parts: [],
          },
          assistantMessage('ses_root', 'a2', 2000, 'Built by builder', { agent: 'builder' }),
        ],
      },
    });

    const headings = markdown(input).split('\n').filter((line) => line.startsWith('### '));

    expect(headings[0]).toContain('planner');
    expect(headings[2]).toContain('builder');
    expect(headings[2]).not.toContain('planner');

    // The page names the same agent, and its filter carries the same name.
    const document = html(input);
    const data = pageData(document);
    const agents = domAgents(document);
    const built = data.entries.find((entry) => entry.search.includes('built by builder'));

    expect(built?.agent).toBe('builder');
    expect(agents.get(built?.id ?? '') ?? '').toBe('builder');
    expect(data.agents).toContain('builder');
  });

  test('a message inside a sub-agent block is signed with the agent that wrote it', () => {
    // The sub-agent session switched agents. The block keeps the session's
    // own name, and the message after the switch is signed with the agent
    // that wrote it.
    const input = fixture({
      root: session('ses_root', { title: 'Root', agent: 'planner' }),
      sessions: [
        session('ses_root', { title: 'Root', agent: 'planner' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
      ],
      records: {
        ses_root: [{
          info: {
            id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'planner',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 1000 },
          },
          parts: [textPart('a1', 'Root work'), subagentCall('a1', { childSessionID: 'ses_child' })],
        }],
        ses_child: [
          assistantMessage('ses_child', 'ca1', 2000, 'Before the switch', { agent: 'reviewer' }),
          {
            info: {
              id: 'sw1', sessionID: 'ses_child', role: 'agent-switched', agent: 'builder',
              time: { created: 2500 },
            },
            parts: [],
          },
          assistantMessage('ses_child', 'ca2', 3000, 'After the switch', { agent: 'builder' }),
        ],
      },
    });

    const output = markdown(input);
    const lines = output.split('\n').filter((line) => line.startsWith('**'));

    // The block's own header keeps the session's name: that is the identity
    // of the block, not the authorship of a message.
    expect(lines[0]).toContain('↳ reviewer');
    expect(lines[0]).toContain('Child');
    // The message before the switch carries the session's own name, because
    // that is the agent that wrote it.
    expect(lines.some((line) => line.includes('↳ reviewer') && line.includes('claude-opus-4-1'))).toBe(true);
    // The message after the switch carries the name of the agent that wrote
    // it.
    expect(lines.some((line) => line.includes('↳ builder'))).toBe(true);

    // The page names the same agent, and its filter carries the same name.
    const document = html(input);
    const data = pageData(document);
    const agents = domAgents(document);
    const after = data.entries.find((entry) => entry.search.includes('after the switch'));

    expect(after?.agent).toBe('builder');
    expect(agents.get(after?.id ?? '') ?? '').toBe('builder');
    expect(data.agents).toContain('builder');
    expect(data.agents).toContain('reviewer');
  });

  test('a sub-agent that recorded no agent does not borrow the root\'s name', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
      sessions: [
        session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root' }),
      ],
      records: {
        ses_root: [{
          info: {
            id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'code-orchestrator',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
          },
          parts: [textPart('a1', 'Root work'), subagentCall('a1', { childSessionID: 'ses_child' })],
        }],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work', { agent: '' })],
      },
    });

    const document = html(input);
    const data = pageData(document);
    const agents = domAgents(document);

    // The child recorded no agent, so the page names it as a sub-agent and
    // not as the root agent. An entry without an agent carries an empty
    // attribute, which no filter offers.
    const childEntries = data.entries.filter((entry) => entry.id.startsWith('ses_child'));
    expect(childEntries.length).toBeGreaterThan(0);
    for (const entry of childEntries) {
      expect(entry.agent ?? '').toBe('');
      expect(agents.get(entry.id) ?? '').toBe('');
    }
  });

  test('a filter that names the root agent keeps the root\'s own entries', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
      sessions: [
        session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'build' }),
      ],
      records: {
        ses_root: [
          userMessage('ses_root', 'u1', 1000, 'Go'),
          assistantMessage('ses_root', 'a1', 2000, 'Root work', { agent: 'code-orchestrator' }),
        ],
        ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work', { agent: 'build' })],
      },
    });

    const document = html(input);
    const data = pageData(document);
    const agents = domAgents(document);

    const rootEntries = data.entries.filter((entry) => entry.agent === 'code-orchestrator');
    expect(rootEntries.length).toBeGreaterThan(0);
    for (const entry of rootEntries) {
      expect(agents.get(entry.id)).toBe('code-orchestrator');
    }
  });
});

describe('work that ran at the same time names its agent and its session', () => {
  const parallel = fixture({
    root: session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
    sessions: [
      session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
      session('ses_a', { title: 'Shared title', parentID: 'ses_root', agent: 'reviewer' }),
      session('ses_b', { title: 'Shared title', parentID: 'ses_root', agent: 'tester' }),
    ],
    records: {
      ses_root: [
        {
          info: {
            id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'code-orchestrator',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
          },
          parts: [subagentCall('a1', { childSessionID: 'ses_a', startedAt: 2000, endedAt: 4000 })],
        },
        {
          info: {
            id: 'a2', sessionID: 'ses_root', role: 'assistant', agent: 'code-orchestrator',
            providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
          },
          parts: [subagentCall('a2', { childSessionID: 'ses_b', startedAt: 2000, endedAt: 4000 })],
        },
      ],
      ses_a: [assistantMessage('ses_a', 'ca1', 2500, 'Review work', { agent: 'reviewer' })],
      ses_b: [assistantMessage('ses_b', 'cb1', 2500, 'Test work', { agent: 'tester' })],
    },
  });

  test('the caption names the agent and the session of the overlapping work', () => {
    const output = markdown(parallel);

    // Two children of one call share a title, so the agent is what tells
    // them apart.
    expect(output).toContain('Ran at the same time as:');
    expect(output).toContain('reviewer — Shared title');
    expect(output).toContain('tester — Shared title');
  });

  test('the HTML names the same agent and session the Markdown does', () => {
    const document = html(parallel);

    expect(document).toContain('reviewer — Shared title');
    expect(document).toContain('tester — Shared title');
  });

  test('the caption does not name who is speaking', () => {
    const output = markdown(parallel);

    // The reader is already inside the block; the caption names the other
    // work, not the block it is in.
    expect(output).not.toContain('code-orchestrator — Shared title');
  });

  test('a session with no agent keeps the title it has', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
      sessions: [
        session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
        session('ses_a', { title: 'First child', parentID: 'ses_root' }),
        session('ses_b', { title: 'Second child', parentID: 'ses_root' }),
      ],
      records: {
        ses_root: [
          {
            info: {
              id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'code-orchestrator',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a1', { childSessionID: 'ses_a', startedAt: 2000, endedAt: 4000 })],
          },
          {
            info: {
              id: 'a2', sessionID: 'ses_root', role: 'assistant', agent: 'code-orchestrator',
              providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
            },
            parts: [subagentCall('a2', { childSessionID: 'ses_b', startedAt: 2000, endedAt: 4000 })],
          },
        ],
        ses_a: [assistantMessage('ses_a', 'ca1', 2500, 'First work')],
        ses_b: [assistantMessage('ses_b', 'cb1', 2500, 'Second work')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('Second child');
    expect(output).toContain('First child');
  });
});

describe('the incomplete export says what could not be read', () => {
  test('the section is named for what it is', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('## Incomplete export');
    expect(output).not.toContain('Export integrity');
  });

  test('a complete export carries no such section', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
      },
    });

    const output = markdown(input);

    expect(output).not.toContain('Incomplete export');
  });

  test('the summary says how much could not be read, in plain words', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
      },
    });

    const output = markdown(input);

    expect(output).toContain('1 thing could not be read from the recorded history:');
    expect(output).not.toContain('could not be established');
  });

  test('the HTML names the section the same way the Markdown does', () => {
    const input = fixture({
      root: session('ses_root', { title: 'Root' }),
      sessions: [
        session('ses_root', { title: 'Root' }),
        session('ses_child', { title: 'Child', parentID: 'ses_root' }),
      ],
      records: {
        ses_root: [userMessage('ses_root', 'u1', 1000, 'Go')],
      },
    });

    const document = html(input);

    expect(document).toContain('Incomplete export');
    expect(document).not.toContain('Export integrity');
  });
});

describe('a long prompt is cut the same way in every format', () => {
  const long = 'x'.repeat(900);

  const longPrompt = fixture({
    root: session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
    sessions: [
      session('ses_root', { title: 'Root', agent: 'code-orchestrator' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root', agent: 'reviewer' }),
    ],
    records: {
      ses_root: [{
        info: {
          id: 'a1', sessionID: 'ses_root', role: 'assistant', agent: 'code-orchestrator',
          providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created: 2000 },
        },
        parts: [subagentCall('a1', { childSessionID: 'ses_child', prompt: long })],
      }],
      ses_child: [assistantMessage('ses_child', 'ca1', 2500, 'Child work', { agent: 'reviewer' })],
    },
  });

  test('the Markdown and the HTML show the same excerpt of a long task', () => {
    const document = markdown(longPrompt);
    const page = html(longPrompt);

    // The excerpt is the same text in both, so a reader who compares the
    // two formats does not find two different cuts of one prompt. The
    // Markdown quotes the task, so the text is read line by line.
    const excerpt = long.slice(0, 600);
    for (const line of excerpt.split('\n')) {
      expect(document).toContain(line);
      expect(page).toContain(line);
    }
    expect(document).toContain('… [excerpt]');
    expect(page).toContain('… [excerpt]');
    // The cut is marked, so the reader knows the task continues.
    expect(document).not.toContain(long);
    expect(page).not.toContain(`<pre>${long}</pre>`);
  });

  test('the detailed view keeps the whole prompt', () => {
    const document = markdown(longPrompt, 'detailed');
    const page = html(longPrompt, 'detailed');

    expect(document).toContain(long);
    expect(page).toContain(long);
  });
});
