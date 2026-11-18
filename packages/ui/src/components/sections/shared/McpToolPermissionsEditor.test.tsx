import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import type { McpToolPermissions, ProjectMcpToolCatalog } from '@/lib/suggestedTasksApi';
import { clickSuggestedTasksControl, deferred, installSuggestedTasksDom } from '@/lib/test-utils/suggestedTasks.fixture';

const dom = installSuggestedTasksDom();
const previousFetch = globalThis.fetch;
let reply = (_url: string): Response | Promise<Response> => Response.json({ status: 'ready', servers: [] });
globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
  const url = input instanceof Request ? input.url : input.toString();
  return url.includes('/mcp-tools') ? reply(url) : Response.json({});
}, previousFetch);
const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { McpToolPermissionsEditor } = await import('./McpToolPermissionsEditor');
let root: Root;
let changed: McpToolPermissions[];
const catalog: ProjectMcpToolCatalog = { status: 'ready', servers: [
  { name: 'jira', status: 'connected', tools: [{ name: 'search', description: 'Find tickets.' }, { name: 'write', description: 'Update a ticket.' }] },
] };
const saved: McpToolPermissions = [{ server: 'jira', tools: { search: 'allow', removed_tool: 'ask' } }, { server: 'other', tools: { untouched: 'deny' } }];
const Editor = ({ initial, projectId }: { initial: McpToolPermissions; projectId: string }) => {
  const [value, setValue] = React.useState(initial);
  return <McpToolPermissionsEditor projectId={projectId} value={value} onChange={(next) => { changed.push(next); setValue(next); }} />;
};
beforeEach(() => {
  root = createRoot(document.body.appendChild(document.createElement('div')));
  changed = [];
  reply = () => Response.json(catalog);
});
afterEach(async () => { await act(async () => root.unmount()); document.body.replaceChildren(); });
afterAll(async () => { globalThis.fetch = previousFetch; await dom.restore(); });
const render = (initial = saved, projectId = 'app') => act(async () => root.render(<I18nProvider><Editor initial={initial} projectId={projectId} /></I18nProvider>));
const button = (label: string, scope: ParentNode = document) => {
  const found = [...scope.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const serverDetails = (server: string) => {
  const found = [...document.querySelectorAll('details')].find((entry) => entry.querySelector('summary')?.textContent?.trim() === server);
  if (!found) throw new Error(`Missing server: ${server}`);
  found.open = true;
  return found;
};
const permission = (server: string, tool: string) => {
  const found = document.querySelector<HTMLElement>(`[aria-label="Permission for ${server} / ${tool}"]`);
  if (!found) throw new Error(`Missing permission: ${server}/${tool}`);
  return found;
};
const choose = async (control: HTMLElement, label: string) => {
  await clickSuggestedTasksControl(control);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((entry) => entry.textContent?.trim() === label);
  if (!option) throw new Error(`Missing option: ${label}`);
  await clickSuggestedTasksControl(option);
};
const type = async (label: string, value: string) => {
  const field = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!field || !setter) throw new Error(`Missing input: ${label}`);
  await act(async () => { setter.call(field, value); field.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('MCP tool rules', () => {
  test('shows new tools denied without mutating saved or missing tool rules', async () => {
    // Given a saved tool missing from the new catalog.
    await render();

    // When the server is opened.
    const details = serverDetails('jira');

    // Then new tools are denied and marked, while saved unknown tools stay editable.
    expect(permission('jira', 'write').textContent).toContain('Deny');
    expect(details.textContent).toContain('New');
    expect(permission('jira', 'removed_tool').textContent).toContain('Ask');
    expect(changed).toEqual([]);
  });

  test('edits a saved tool absent from the catalog through the real picker', async () => {
    // Given a missing tool whose saved effect is Ask.
    await render();
    serverDetails('jira');

    // When its permission changes.
    await choose(permission('jira', 'removed_tool'), 'Deny');

    // Then only that effect changes; other saved server rules survive.
    expect(changed.at(-1)).toEqual([{ server: 'jira', tools: { search: 'allow', removed_tool: 'deny' } }, saved[1]]);
  });

  test('denies a new tool even when its name matches an inherited object property', async () => {
    // Given an unconfigured catalog tool named like Object.prototype's constructor.
    reply = () => Response.json({ status: 'ready', servers: [{ name: 'jira', status: 'connected', tools: [{ name: 'constructor', description: '' }] }] });

    // When the saved server is shown with this new tool.
    await render();

    // Then an inherited property cannot supply a permission effect.
    expect(permission('jira', 'constructor').textContent).toContain('Deny');
    expect(changed).toEqual([]);
  });

  for (const [label, effect] of [['Allow all', 'allow'], ['Ask for all', 'ask'], ['Deny all', 'deny']] as const) {
    test(`${label} affects only this server's catalog and saved tools`, async () => {
      // Given tools from both the catalog and saved rules.
      await render();

      // When a server-wide action runs.
      await act(async () => button(label, serverDetails('jira')).click());

      // Then every known tool receives the explicit effect, including new and missing tools.
      expect(changed.at(-1)).toEqual([{ server: 'jira', tools: { search: effect, write: effect, removed_tool: effect } }, saved[1]]);
      expect(serverDetails('jira').textContent).not.toContain('New');
    });
  }

  test('keeps saved tools editable when the catalog is still loading', async () => {
    // Given a location whose plugin has not supplied a catalog yet.
    reply = () => Response.json({ status: 'loading', servers: [] });
    await render();

    // When a saved server is opened.
    serverDetails('jira');

    // Then incomplete empty data neither removes rules nor claims there are no servers.
    expect(permission('jira', 'search').textContent).toContain('Allow');
    expect(document.body.textContent).not.toContain('No MCP servers in this project.');
    expect(changed).toEqual([]);
  });

  test('keeps saved rules editable and offers refresh after a failed catalog read', async () => {
    // Given a failed catalog request.
    reply = () => Response.json({ error: 'Unavailable' }, { status: 503 });
    await render();

    // When a saved server's rules change despite the failure.
    await act(async () => button('Deny all', serverDetails('jira')).click());

    // Then existing rules can be saved and catalog recovery remains reachable.
    expect(changed.at(-1)?.[0]?.tools).toEqual({ search: 'deny', removed_tool: 'deny' });
    expect(button('Refresh catalog').disabled).toBe(false);
  });

  test('adds a manually named tool as denied for external OpenCode', async () => {
    // Given an external runtime without a discoverable catalog.
    reply = () => Response.json({ status: 'external', servers: [] });
    await render([]);
    expect(document.body.textContent).toContain('codemode: false');

    // When a server and tool name are entered and added.
    await type('Server name', 'custom-server');
    await type('Tool name', 'lookup_ticket');
    await act(async () => button('Add tool').click());

    // Then the exact names and safe default are written to the controlled value.
    expect(changed.at(-1)).toEqual([{ server: 'custom-server', tools: { lookup_ticket: 'deny' } }]);
  });

  test('ignores an old catalog after switching projects', async () => {
    // Given a project read waiting for its response.
    const old = deferred<Response>();
    reply = (url) => url.includes('/projects/old/') ? old.promise : Response.json(catalog);
    await render([], 'old');

    // When the project changes before the old catalog arrives.
    await render([], 'new');
    await act(async () => old.resolve(Response.json({ status: 'ready', servers: [{ name: 'obsolete', status: 'connected', tools: [] }] })));

    // Then only the selected project's catalog is shown.
    expect(document.body.textContent).toContain('jira');
    expect(document.body.textContent).not.toContain('obsolete');
  });
});
