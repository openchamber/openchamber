import { connectHost } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountCheckbox,
  mountEmpty,
  mountList,
  mountMenu,
  mountProgress,
  mountSearchField,
  mountSelect,
  mountSeparator,
  mountSpinner,
  mountSwitch,
  mountTabs,
  mountText,
  mountTextField,
} from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('no root');

const section = (title: string): HTMLElement => {
  const box = document.createElement('div');
  box.style.padding = '12px';
  const heading = document.createElement('div');
  heading.textContent = title;
  heading.style.font = '600 0.8125rem var(--font-sans)';
  heading.style.marginBottom = '8px';
  heading.style.color = 'var(--surface-muted-foreground)';
  box.append(heading);
  root.append(box);
  return box;
};

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  while (root.firstChild) root.removeChild(root.firstChild);

  const status = section('Host state');
  const statusText = mountText(status, { text: '' });
  const paintStatus = (directory: string | null, session: { id: string; title: string; busy: boolean } | null): void => {
    statusText.update({
      text: `Directory: ${directory ?? '—'}\nSession: ${session ? `${session.title} (${session.busy ? 'busy' : 'idle'})` : 'none'}\nTheme: ${ctx.theme.mode}, surface: ${ctx.surface}`,
    });
  };
  paintStatus(ctx.directory, ctx.session);
  host.onDirectory((directory) => paintStatus(directory, ctx.session));
  host.onSession((session) => paintStatus(ctx.directory, session));

  const tabsBox = section('Tabs');
  let activeTab = 'one';
  const tabs = mountTabs(tabsBox, {
    items: [{ id: 'one', label: 'Overview' }, { id: 'two', label: 'Checks', count: 3 }, { id: 'three', label: 'Comments', count: 12 }],
    activeId: activeTab,
    trackBackground: true,
    onChange: (id) => { activeTab = id; tabs.update({ activeId: id }); },
  });

  const buttons = section('Buttons and host actions');
  const row = document.createElement('div');
  row.style.display = 'flex'; row.style.gap = '8px'; row.style.flexWrap = 'wrap';
  buttons.append(row);
  mountButton(row, { label: 'Toast', onClick: () => void host.toast({ kind: 'success', message: 'Hello from the kit' }) });
  mountButton(row, { label: 'Copy text', variant: 'secondary', onClick: () => void host.writeClipboard('copied from hello-kit') });
  mountButton(row, { label: 'Open docs', variant: 'outline', onClick: () => void host.openUrl('https://openchamber.dev') });
  mountButton(row, { label: 'Compose', variant: 'ghost', onClick: () => void host.compose({ text: 'Text appended by hello-kit', mode: 'append' }) });
  mountButton(row, { label: 'Open Files', variant: 'ghost', size: 'sm', onClick: () => void host.openSurface('file') });
  mountButton(row, { label: 'Loading', loading: true, onClick: () => {} });
  mountButton(row, { label: 'Delete', variant: 'destructive', size: 'xs', onClick: () => void host.toast({ kind: 'error', message: 'Nothing was deleted' }) });
  mountMenu(row, {
    label: 'Menu',
    variant: 'outline',
    items: [{ id: 'a', label: 'First action' }, { id: 'b', label: 'Disabled', disabled: true }, { separator: true }, { id: 'c', label: 'Remove', destructive: true }],
    onSelect: (id) => void host.toast({ kind: 'info', message: `Menu: ${id}` }),
  });

  const fields = section('Fields');
  let name = '';
  mountTextField(fields, { label: 'Name', value: name, placeholder: 'Type something', onChange: (v) => { name = v; } });
  mountTextField(fields, { label: 'Secret', value: '', password: true, helper: 'Masked input', onChange: () => {} });
  mountTextField(fields, { label: 'Notes', value: '', multiline: true, rows: 3, mono: true, onChange: () => {} });
  mountTextField(fields, { label: 'With error', value: 'oops', error: 'This value is not valid', onChange: () => {} });
  let picked: string | null = 'b';
  const select = mountSelect(fields, {
    label: 'Searchable select',
    value: picked,
    searchable: true,
    options: [{ id: 'a', label: 'Alpha', hint: 'A' }, { id: 'b', label: 'Beta' }, { id: 'c', label: 'Gamma', hint: 'G' }, { id: 'd', label: 'Delta' }],
    onChange: (id) => { picked = id; select.update({ value: id }); },
  });
  let checked = true;
  const box = mountCheckbox(fields, { label: 'Checkbox', description: 'With a description line', checked, onChange: (v) => { checked = v; box.update({ checked: v }); } });
  let on = false;
  const sw = mountSwitch(fields, { label: 'Switch', checked: on, onChange: (v) => { on = v; sw.update({ checked: v }); } });

  const feedback = section('Feedback');
  const badges = document.createElement('div'); badges.style.display = 'flex'; badges.style.gap = '6px'; feedback.append(badges);
  for (const tone of ['neutral', 'primary', 'success', 'warning', 'error', 'info'] as const) mountBadge(badges, { label: tone, tone });
  mountSeparator(feedback, { label: 'banners' });
  mountBanner(feedback, { tone: 'info', title: 'Info banner', body: 'Something you should know.' });
  mountBanner(feedback, { tone: 'warning', title: 'Warning', body: 'With an action.', action: { label: 'Fix', onClick: () => void host.toast({ kind: 'success', message: 'Fixed' }) } });
  mountSeparator(feedback);
  mountProgress(feedback, { value: 42, label: 'Progress 42%' });
  mountSpinner(feedback, { label: 'Loading…' });

  const listBox = section('Search + list');
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: `t${i + 1}`, key: `ACME-${100 + i}`, title: `Task number ${i + 1}`, updated: `${i + 1}d` }));
  let query = '';
  let selected: string | null = null;
  const listRoot = document.createElement('div');
  const emptyRoot = document.createElement('div');
  const list = mountList(listRoot, {
    items: [],
    selectedId: selected,
    onSelect: (id) => { selected = id; paintList(); void host.toast({ kind: 'info', message: `Selected ${id}` }); },
  });
  let empty: { dispose: () => void } | null = null;
  const paintList = (): void => {
    const rows = tasks
      .filter((t) => t.title.toLowerCase().includes(query.toLowerCase()) || t.key.toLowerCase().includes(query.toLowerCase()))
      .map((t) => ({ id: t.id, leading: t.key, title: t.title, subtitle: 'Fake task from hello-kit', meta: t.updated, badge: { label: 'open', tone: 'success' as const } }));
    list.update({ items: rows, selectedId: selected });
    empty?.dispose(); empty = null;
    if (rows.length === 0) empty = mountEmpty(emptyRoot, { title: 'No tasks match', body: 'Try a shorter search.' });
  };
  mountSearchField(listBox, { value: query, placeholder: 'Search tasks', onChange: (v) => { query = v; paintList(); } });
  listBox.append(listRoot, emptyRoot);
  paintList();
});
