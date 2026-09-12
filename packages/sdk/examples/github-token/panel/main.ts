import { connectHost, HostRequestError, type GuestConnection } from '@openchamber/sdk';
import { applyHostReady, mountBanner, mountButton, mountEmpty, mountList, mountSpinner, mountText } from '@openchamber/sdk/ui';

type Repo = { full_name: string; html_url: string; description: string | null; stargazers_count: number; private: boolean };

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('no root');

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  while (root.firstChild) root.removeChild(root.firstChild);
  const page = document.createElement('div');
  page.style.padding = '12px'; page.style.display = 'flex'; page.style.flexDirection = 'column'; page.style.gap = '10px';
  root.append(page);
  const header = document.createElement('div');
  const body = document.createElement('div');
  page.append(header, body);

  let connection: GuestConnection = ctx.connection;
  let settings = ctx.settings;
  let mounted: Array<{ dispose: () => void }> = [];
  const clear = (): void => { for (const m of mounted) m.dispose(); mounted = []; while (body.firstChild) body.removeChild(body.firstChild); while (header.firstChild) header.removeChild(header.firstChild); };

  const paint = async (): Promise<void> => {
    clear();
    if (!connection.connected) {
      mounted.push(mountEmpty(body, {
        title: 'Not connected',
        body: 'Paste a GitHub personal access token in Settings → Integrations → GitHub (token).',
        action: { label: 'Where do I connect?', onClick: () => void host.toast({ kind: 'info', message: 'Settings → Integrations → GitHub (token) → paste a token → Connect' }) },
      }));
      return;
    }
    mounted.push(mountText(header, { text: `Signed in as ${connection.account}` }));
    mounted.push(mountButton(header, { label: 'Disconnect', size: 'xs', variant: 'ghost', onClick: () => void host.oauthDisconnect() }));
    const spinner = mountSpinner(body, { label: 'Loading repositories…' });
    mounted.push(spinner);
    try {
      const visibility = settings.visibility && ['all', 'public', 'private'].includes(settings.visibility) ? settings.visibility : 'all';
      const result = await host.request({ method: 'GET', path: '/user/repos', query: { per_page: '30', sort: 'updated', visibility } });
      spinner.dispose();
      if (result.status !== 200) {
        mounted.push(mountBanner(body, { tone: 'error', title: `GitHub answered ${result.status}`, body: result.body.slice(0, 200) }));
        return;
      }
      const repos = JSON.parse(result.body) as Repo[];
      mounted.push(mountList(body, {
        items: repos.map((repo) => ({ id: repo.full_name, title: repo.full_name, subtitle: repo.description ?? undefined, meta: `★ ${repo.stargazers_count}`, badge: repo.private ? { label: 'private', tone: 'warning' as const } : undefined })),
        onSelect: (id) => {
          const repo = repos.find((r) => r.full_name === id);
          if (repo) void host.attach({ providerId: 'github-token', id: repo.full_name, title: repo.full_name, url: repo.html_url, text: `Repository ${repo.full_name}: ${repo.description ?? ''}\n${repo.html_url}` });
        },
      }));
    } catch (error) {
      spinner.dispose();
      mounted.push(mountBanner(body, { tone: 'error', title: 'Request failed', body: error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error) }));
    }
  };
  host.onConnection((next) => { connection = next; void paint(); });
  host.onSettings((next) => { settings = next; void paint(); });
  void paint();
});
