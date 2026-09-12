import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady, mountBadge, mountButton, mountText, mountTextField } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('no root');

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  while (root.firstChild) root.removeChild(root.firstChild);
  const page = document.createElement('div');
  page.style.padding = '12px'; page.style.display = 'flex'; page.style.flexDirection = 'column'; page.style.gap = '10px';
  root.append(page);

  const statusRow = document.createElement('div');
  statusRow.style.display = 'flex'; statusRow.style.gap = '8px'; statusRow.style.alignItems = 'center';
  page.append(statusRow);
  const badge = mountBadge(statusRow, { label: 'service: unknown' });
  const refresh = async (): Promise<void> => {
    const result = await host.serviceStatus();
    const tone = result.status === 'ready' ? 'success' : result.status === 'failed' ? 'error' : 'neutral';
    badge.update({ label: `service: ${result.status}`, tone });
  };
  mountButton(statusRow, { label: 'Refresh status', size: 'sm', variant: 'ghost', onClick: () => void refresh().catch(() => {}) });

  let message = 'hello from the panel';
  mountTextField(page, { label: 'Message to echo', value: message, onChange: (v) => { message = v; } });
  const output = mountText(page, { text: 'No calls yet. The first request spawns the service process (needs approval).' });

  const call = async (label: string, run: () => Promise<{ status: number; body: string }>): Promise<void> => {
    try {
      const result = await run();
      output.update({ text: `${label} → HTTP ${result.status}\n${result.body}` });
    } catch (error) {
      output.update({ text: `${label} failed: ${error instanceof HostRequestError ? `${error.code} ${error.message}` : String(error)}` });
    }
    await refresh().catch(() => {});
  };
  const row = document.createElement('div'); row.style.display = 'flex'; row.style.gap = '8px'; row.style.flexWrap = 'wrap';
  page.append(row);
  mountButton(row, { label: 'Echo (POST)', onClick: () => void call('POST /echo', () => host.serviceRequest({ method: 'POST', path: '/echo', query: { via: 'panel' }, body: JSON.stringify({ message }) })) });
  mountButton(row, { label: 'uname -a', variant: 'outline', onClick: () => void call('GET /uname', () => host.serviceRequest({ method: 'GET', path: '/uname' })) });
  mountButton(row, { label: 'Bad path', variant: 'ghost', onClick: () => void call('GET ../x', () => host.serviceRequest({ method: 'GET', path: '/../x' })) });
  void refresh().catch(() => {});
});
