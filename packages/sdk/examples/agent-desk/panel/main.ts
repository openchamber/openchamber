// The panel of Agent Desk: what the service sends arrives on its own, and one
// button asks the service to start a session.
import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton, mountText } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Agent Desk: missing root');

const log = document.createElement('div');
const write = (line: string): void => {
  const row = document.createElement('div');
  row.textContent = line;
  log.prepend(row);
};

let mounted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  mountText(root, { text: 'Agent Desk' });
  mountButton(root, {
    label: 'Start a session',
    onClick: () => {
      void host.serviceRequest({ method: 'POST', path: '/start', body: JSON.stringify({ directory: context.directory }) })
        .then((answer) => write(answer.body))
        .catch(() => write('The service did not answer.'));
    },
  });
  root.append(log);
});

host.onServiceEvent(({ topic, data }) => write(`${topic}: ${JSON.stringify(data)}`));
