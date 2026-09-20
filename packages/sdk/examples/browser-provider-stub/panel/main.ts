// The extension's page docked above the shared surface: an address field and
// a Go button. It
// talks to the stub service through the host (`host.serviceRequest`), the
// same way any panel reaches its service; the surface below it is the host's.
import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountTextField } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing root');

let mounted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;

  const strip = document.createElement('div');
  strip.style.cssText = 'display:flex;align-items:center;gap:8px;height:100%;padding:0 8px;box-sizing:border-box;';
  root.append(strip);

  let url = '';
  const address = document.createElement('div');
  address.style.flex = '1';
  strip.append(address);
  const field = mountTextField(address, {
    value: url,
    placeholder: 'https://example.com',
    mono: true,
    onChange: (value) => { url = value; field.update({ value }); },
  });
  const go = mountButton(strip, {
    label: 'Go',
    size: 'sm',
    onClick: () => {
      if (!url.trim()) return;
      go.update({ loading: true });
      void host.serviceRequest({ method: 'POST', path: '/navigate', body: JSON.stringify({ url: url.trim() }) })
        .then(() => refresh())
        .finally(() => go.update({ loading: false }));
    },
  });

  // Mirror what the agent did: the address follows the page.
  const refresh = async () => {
    try {
      const result = await host.serviceRequest({ method: 'GET', path: '/state' });
      const state: { url?: unknown } = JSON.parse(result.body);
      if (String(state.url) === state.url && state.url !== url) {
        url = state.url === 'about:blank' ? '' : state.url;
        field.update({ value: url });
      }
    } catch {
      // service asleep; the next action wakes it
    }
  };
  void refresh();
  setInterval(() => { void refresh(); }, 2000);
});
