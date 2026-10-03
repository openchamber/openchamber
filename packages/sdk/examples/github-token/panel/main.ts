import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBadge, mountButton, mountEmpty, mountList, mountSearchField, mountSelect } from '@openchamber/sdk/ui';
import { z } from 'zod';
import { card, codeSample, createExample, element, feedback, metrics, paragraph, row } from '../../shared.ts';

const repositorySchema = z.object({ full_name: z.string(), html_url: z.string().url(), description: z.string().nullable(), stargazers_count: z.number(), private: z.boolean(), language: z.string().nullable().optional(), updated_at: z.string().optional(), default_branch: z.string().optional() });
type Repository = z.infer<typeof repositorySchema>;
const visibilityOf = (value: string | undefined) => value === 'public' || value === 'private' ? value : 'all';
const samples: Repository[] = [
  { full_name: 'northstar/design-system', html_url: 'https://github.com', description: 'The small details that make a product feel coherent.', stargazers_count: 128, private: false, language: 'TypeScript', default_branch: 'main' },
  { full_name: 'northstar/field-notes', html_url: 'https://github.com', description: 'Research, experiments, and things worth remembering.', stargazers_count: 36, private: false, language: 'Markdown', default_branch: 'main' },
  { full_name: 'northstar/agent-workbench', html_url: 'https://github.com', description: 'A place to explore what helpful agents can do.', stargazers_count: 84, private: true, language: 'Python', default_branch: 'main' },
];
const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing root');
let mounted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return; mounted = true;
  const app = createExample(root, { number: '03', title: 'Repository Explorer', description: 'Find the repository you want to work on. Bring its context into the conversation without handing your token to the extension.', api: 'Token integration' });
  const connectionBadge = mountBadge(app.toolbar, { label: 'Not connected' });
  const notice = feedback(app.content);
  const counts = metrics(app.content, ['Repositories loaded', 'Private', 'Stars across loaded repos']);
  const connect = card(app.content, 'Connect your corner of GitHub', 'In Settings → Integrations → Extension accounts, connect GitHub (token). Your token stays on the selected instance.');
  mountButton(connect, { label: 'Explore sample repositories', variant: 'outline', onClick: () => { generation++; sample = true; repos = samples; selectedId = ''; paint(); connectionBadge.update({ label: 'Sample data', tone: 'info' }); } });
  const grid = element('div', 'split'); app.content.append(grid);
  const browser = card(grid, 'Your repositories');
  browser.classList.add('repository-browser');
  const detail = card(grid, 'Repository details', 'Select a repository to see what is inside.');
  const title = element('h2', 'detail-title', 'Pick something interesting'); detail.append(title);
  const description = paragraph(detail, 'Select a repository from the list.');
  const metadata = paragraph(detail, '', 'inline-note');
  const selectedBadge = mountBadge(detail, { label: 'No selection' });
  let connection = context.connection; let settings = context.settings;
  let repos: Repository[] = []; let selectedId = ''; let query = ''; let scope = visibilityOf(settings.visibility); let page = 0; let more = false; let generation = 0; let sample = false;
  const current = () => repos.find((repo) => repo.full_name === selectedId);
  const search = mountSearchField(browser, { value: '', placeholder: 'Search loaded repositories…', onChange: (value) => { query = value; search.update({ value }); paint(); } });
  const controls = row(browser); controls.style.alignItems = 'flex-end';
  const visibility = mountSelect(controls, { label: 'Visibility', value: scope, options: ['all', 'public', 'private'].map((id) => ({ id, label: id[0].toUpperCase() + id.slice(1) })), onChange: (value) => { scope = visibilityOf(value); visibility.update({ value: scope }); if (sample) paint(); else void refresh(); } });
  const refreshButton = mountButton(controls, { label: 'Refresh', variant: 'ghost', onClick: () => { void refresh(); } });
  const list = mountList(browser, { ariaLabel: 'Repositories', items: [], onSelect: (id) => { selectedId = id; paint(); } });
  const emptySlot = element('div'); browser.append(emptySlot);
  const empty = mountEmpty(emptySlot, { title: 'Your next project is here', body: 'Connect GitHub or explore the sample collection above.' });
  const loadMore = mountButton(browser, { label: 'Load more', variant: 'outline', disabled: true, onClick: () => { void fetchPage(page + 1, false); } });
  const actions = row(detail);
  const browse = mountButton(actions, { label: 'Open on GitHub', disabled: true, onClick: () => { const repo = current(); if (repo) void notice.run(() => host.openUrl(repo.html_url)); } });
  const compose = mountButton(actions, { label: 'Add context to chat', variant: 'outline', disabled: true, onClick: () => { const repo = current(); if (repo) void notice.run(async () => {
    await host.compose({ text: `${sample ? 'Sample repository' : 'Repository'}: ${repo.full_name}\n${repo.description ?? ''}\n${repo.html_url}\nDefault branch: ${repo.default_branch ?? 'unknown'}`, mode: 'append' });
    notice.show('Context added', 'Review the draft in your chat before sending.', 'success');
  }); } });
  codeSample(detail, 'const result = await host.request({\n  method: "GET", path: "/user/repos",\n  query: { per_page: "30", sort: "updated" },\n});\n// The host attaches the credential.');
  const paint = () => {
    counts([repos.length, repos.filter((repo) => repo.private).length, repos.reduce((sum, repo) => sum + repo.stargazers_count, 0)]);
    const visible = repos.filter((repo) => `${repo.full_name} ${repo.description ?? ''}`.toLowerCase().includes(query.toLowerCase()) && (scope === 'all' || repo.private === (scope === 'private')));
    list.update({ selectedId, items: visible.map((repo) => ({ id: repo.full_name, title: repo.full_name, subtitle: repo.description ?? 'No description yet', meta: `${repo.stargazers_count} stars`, badge: { label: repo.private ? 'Private' : 'Public', tone: 'neutral' } })) });
    emptySlot.hidden = visible.length > 0;
    if (query && !visible.length) empty.update({ title: 'No matches in this collection', body: 'Try another search or load more repositories.' });
    else if (connection.connected && !repos.length) empty.update({ title: 'No repositories found', body: 'Try a different visibility filter or check the token’s repository access.' });
    else empty.update({ title: 'Your next project is here', body: 'Connect GitHub or explore the sample collection above.' });
    const repo = current();
    title.textContent = repo?.full_name ?? 'Pick something interesting'; description.textContent = repo?.description ?? 'Select a repository from the list.';
    metadata.textContent = repo ? `${repo.language ?? 'No language detected'} · ${repo.default_branch ?? 'Default branch unavailable'}` : '';
    selectedBadge.update({ label: repo ? (repo.private ? 'Private repository' : 'Public repository') : 'No selection', tone: 'neutral' });
    browse.update({ disabled: !repo || sample }); compose.update({ disabled: !repo });
    loadMore.update({ disabled: !more || sample || !connection.connected });
    refreshButton.update({ disabled: !connection.connected });
  };
  const fetchPage = async (nextPage: number, replace: boolean) => {
    if (!connection.connected) return;
    const owner = ++generation; sample = false; refreshButton.update({ loading: true }); loadMore.update({ loading: true });
    try {
      const response = await host.request({ method: 'GET', path: '/user/repos', query: { per_page: '30', page: String(nextPage), sort: 'updated', visibility: ['all', 'public', 'private'].includes(scope) ? scope : 'all' } });
      if (owner !== generation) return;
      if (response.status !== 200) throw new Error(`GitHub returned HTTP ${response.status}. Check the token and repository access, then refresh.`);
      const next = z.array(repositorySchema).parse(JSON.parse(response.body));
      repos = [...new Map([...(replace ? [] : repos), ...next].map((repo) => [repo.full_name, repo])).values()];
      page = nextPage; more = next.length === 30; selectedId = repos.some((repo) => repo.full_name === selectedId) ? selectedId : repos[0]?.full_name ?? '';
      notice.clear(); paint();
    } catch (error) { if (owner === generation) notice.show('Could not load repositories', error instanceof Error ? error.message : String(error), 'error'); }
    finally { if (owner === generation) { refreshButton.update({ loading: false }); loadMore.update({ loading: false }); } }
  };
  const refresh = () => fetchPage(1, true);
  const updateConnection = () => {
    connectionBadge.update({ label: connection.connected ? `Connected as ${connection.account || 'GitHub user'}` : 'Not connected', tone: connection.connected ? 'success' : 'neutral' });
    connect.parentElement!.hidden = connection.connected;
    paint(); if (connection.connected) void refresh();
  };
  host.onConnection((next) => {
    if (next.connected === connection.connected && next.account === connection.account) return;
    generation++; connection = next; repos = []; selectedId = ''; sample = false; more = false;
    refreshButton.update({ loading: false }); loadMore.update({ loading: false }); updateConnection();
  });
  host.onSettings((next) => { if (next.visibility === settings.visibility) return; settings = next; scope = visibilityOf(next.visibility); visibility.update({ value: scope }); if (connection.connected) void refresh(); });
  updateConnection();
});
