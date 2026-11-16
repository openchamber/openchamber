// One call to the DeskChart component. The arguments are written by a model,
// so this page only draws them: it never acts on them.
import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountButton } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector<HTMLElement>('#root');
if (!root) throw new Error('DeskChart: missing root');
root.style.padding = '12px';

host.onReady((context) => applyHostReady(context, document.documentElement));

host.onBlock(({ args, answered }) => {
  const values = (args.values ?? '').split(',').map(Number).filter(Number.isFinite);
  const top = Math.max(1, ...values);
  root.replaceChildren();
  const title = document.createElement('div');
  title.textContent = args.title ?? '';
  title.style.font = '600 13px var(--oc-font, system-ui)';
  const bars = document.createElement('div');
  bars.style.cssText = 'display:flex;align-items:flex-end;gap:6px;height:96px;margin-top:8px';
  for (const value of values) {
    const bar = document.createElement('div');
    bar.style.cssText = `flex:1;height:${(value / top) * 100}%;background:currentColor;opacity:.6;border-radius:3px 3px 0 0`;
    bar.title = String(value);
    bars.append(bar);
  }
  root.append(title, bars);
  // An answer goes to the agent only from this click. The kit's button has
  // the app's look and grows to a touch size on a phone.
  const actions = document.createElement('div');
  actions.style.marginTop = '10px';
  root.append(actions);
  mountButton(actions, {
    label: answered ?? 'Explain this',
    variant: 'outline',
    size: 'sm',
    disabled: answered !== null,
    onClick: () => { void host.answerBlock('Explain this chart'); },
  });
});

// The height follows the content, which settles after the first draw.
new ResizeObserver(() => { void host.setHeight(Math.ceil(root.getBoundingClientRect().height)); }).observe(root);
