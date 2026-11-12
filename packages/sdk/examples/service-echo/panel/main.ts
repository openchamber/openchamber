import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBadge, mountButton, mountSelect, mountTextField } from '@openchamber/sdk/ui';
import { card, codeSample, createExample, element, feedback, metrics, paragraph, row } from '../../shared.ts';

const host = connectHost(); const root = document.querySelector('#root'); if (!root) throw new Error('Missing root');
let mounted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement); if (mounted) return; mounted = true;
  const app = createExample(root, { number: '04', title: 'Local Service Lab', description: 'A tiny process, a visible conversation. Send a request through the host and see what happens on the other side of the sandbox.', api: 'Local service' });
  const badge = mountBadge(app.toolbar, { label: 'Checking service…', tone: 'neutral' });
  const notice = feedback(app.content);
  const counters = metrics(app.content, ['Requests this visit', 'Last round trip', 'Last HTTP status']);
  let calls = 0; let message = 'Hello from the other side.'; let endpoint = 'echo';
  const grid = element('div', 'split'); app.content.append(grid);
  const request = card(grid, 'Send a request', 'The first request starts the service. The host owns its lifecycle and private loopback credential.');
  const response = card(grid, 'Response', 'Responses stay here until you make another request.');
  const resultMeta = paragraph(response, 'No requests yet', 'inline-note');
  const output = element('pre', 'code', 'Your response will appear here.'); response.append(output);
  const select = mountSelect(request, { label: 'Experiment', value: endpoint, options: [{ id: 'echo', label: 'POST /echo', hint: 'Round-trip a message' }, { id: 'uname', label: 'GET /uname', hint: 'Unix system information' }, { id: 'invalid', label: 'A path outside the service', hint: 'See the boundary reject it' }], onChange: (value) => { endpoint = value; select.update({ value }); field.update({ disabled: value !== 'echo' }); } });
  const field = mountTextField(request, { label: 'Message to echo', value: message, multiline: true, rows: 5, onChange: (value) => { message = value; field.update({ value }); } });
  const refresh = async () => {
    const state = await host.serviceStatus(); badge.update({ label: `Service ${state.status}`, tone: state.status === 'ready' ? 'success' : state.status === 'failed' ? 'error' : 'neutral' });
  };
  const actions = row(request);
  const send = mountButton(actions, { label: 'Send request', onClick: () => {
    const current = endpoint; const body = message; send.update({ loading: true }); const started = performance.now();
    void notice.run(async () => {
      try {
        const result = await host.serviceRequest(current === 'echo' ? { method: 'POST', path: '/echo', query: { via: 'service-lab' }, body: JSON.stringify({ message: body }) } : { method: 'GET', path: current === 'uname' ? '/uname' : '/../outside' });
        calls++; counters([calls, `${Math.round(performance.now() - started)} ms`, result.status]);
        resultMeta.textContent = `${current === 'echo' ? 'POST /echo' : 'GET /uname'} · HTTP ${result.status}`;
        try { output.textContent = JSON.stringify(JSON.parse(result.body), null, 2); } catch { output.textContent = result.body; }
        notice.show(result.status < 400 ? 'Round trip complete' : 'The service returned an error', current === 'uname' && result.status >= 400 ? 'This experiment needs uname on the server. Echo works without it.' : '', result.status < 400 ? 'success' : 'warning');
      } catch (error) {
        calls++; counters([calls, `${Math.round(performance.now() - started)} ms`, 'Rejected']);
        resultMeta.textContent = 'Request rejected'; output.textContent = error instanceof Error ? error.message : String(error);
        notice.show(current === 'invalid' ? 'Boundary working as intended' : 'Request failed', output.textContent, current === 'invalid' ? 'info' : 'error');
      } finally { send.update({ loading: false }); await refresh(); }
    });
  } });
  mountButton(actions, { label: 'Refresh status', variant: 'ghost', onClick: () => { void notice.run(refresh); } });
  mountButton(response, { label: 'Copy response', variant: 'ghost', size: 'xs', onClick: () => { void notice.run(async () => { await host.writeClipboard(output.textContent ?? ''); notice.show('Response copied', '', 'success'); }); } });
  const pipeline = card(app.content, 'Follow the request', 'Three responsibilities, one explicit action.');
  const steps = element('div', 'grid'); pipeline.append(steps);
  for (const [title, body] of [['01 · Panel', 'Collects input and calls the public SDK. It cannot reach the service directly.'], ['02 · Host', 'Checks approval, starts the process, and authenticates the loopback request.'], ['03 · Service', 'Runs the operation and returns a normal HTTP response.']]) {
    const step = element('div', 'stack'); step.append(element('h3', '', title)); paragraph(step, body); steps.append(step);
  }
  paragraph(pipeline, 'A local service runs with your user permissions. This example only echoes input and optionally runs uname.');
  codeSample(pipeline, 'await host.serviceRequest({\n  method: "POST", path: "/echo",\n  body: JSON.stringify({ message }),\n});');
  counters([0, '—', '—']); void notice.run(refresh);
});
