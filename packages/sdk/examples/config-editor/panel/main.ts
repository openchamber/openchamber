import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountList,
  mountSpinner,
  mountTabs,
  mountText,
  mountTextField,
  type Tone,
} from '@openchamber/sdk/ui';

// Reads a file outside the open project (`~/.config/opencode/opencode.json`,
// capability `filesystem`), parses it as JSON, and shows it as a browsable tree
// with a raw editor next to it. Save writes the file back atomically.

const CONFIG_PATH = '~/.config/opencode/opencode.json';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const isRecord = (value: Json): value is { [key: string]: Json } => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isContainer = (value: Json): value is Json[] | { [key: string]: Json } => (
  typeof value === 'object' && value !== null
);

const entriesOf = (value: Json[] | { [key: string]: Json }): Array<[string, Json]> => (
  Array.isArray(value) ? value.map((item, index) => [String(index), item] as [string, Json]) : Object.entries(value)
);

const describe = (value: Json): { text: string; meta: string; tone: Tone } => {
  if (value === null) return { text: 'null', meta: 'null', tone: 'warning' };
  if (typeof value === 'boolean') return { text: value ? 'true' : 'false', meta: 'boolean', tone: value ? 'success' : 'error' };
  if (typeof value === 'number') return { text: String(value), meta: 'number', tone: 'primary' };
  if (typeof value === 'string') return { text: value, meta: 'string', tone: 'neutral' };
  if (Array.isArray(value)) return { text: `${value.length} ${value.length === 1 ? 'item' : 'items'}`, meta: 'array', tone: 'info' };
  const keys = Object.keys(value).length;
  return { text: `${keys} ${keys === 1 ? 'key' : 'keys'}`, meta: 'object', tone: 'info' };
};

const errorText = (error: unknown): string => (
  error instanceof HostRequestError ? `${error.code}: ${error.message}` : String(error)
);

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('no root');

type Disposable = { dispose: () => void };

const column = (parent: Element, gap = '8px'): HTMLElement => {
  const box = document.createElement('div');
  box.style.display = 'flex';
  box.style.flexDirection = 'column';
  box.style.gap = gap;
  parent.append(box);
  return box;
};

const row = (parent: Element): HTMLElement => {
  const box = document.createElement('div');
  box.style.display = 'flex';
  box.style.alignItems = 'center';
  box.style.gap = '8px';
  box.style.flexWrap = 'wrap';
  parent.append(box);
  return box;
};

const clear = (node: Element, mounted: Disposable[]): void => {
  for (const item of mounted.splice(0)) item.dispose();
  while (node.firstChild) node.removeChild(node.firstChild);
};

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  while (root.firstChild) root.removeChild(root.firstChild);
  const page = column(root, '12px');
  page.style.padding = '12px';

  const header = row(page);
  const body = column(page);
  const headerMounted: Disposable[] = [];
  const mounted: Disposable[] = [];

  let raw = '';
  let draft = '';
  let parsed: Json | null = null;
  let parseError: string | null = null;
  let tab: 'explore' | 'raw' = 'explore';
  let path: string[] = [];

  const load = async (): Promise<void> => {
    clear(header, headerMounted);
    clear(body, mounted);
    const spinner = mountSpinner(body, { label: 'Reading opencode.json' });
    try {
      const stat = await host.stat(CONFIG_PATH);
      raw = stat.kind === 'file' ? (await host.readFile(CONFIG_PATH)).content : '';
      draft = raw;
      parsed = null;
      parseError = null;
      if (stat.kind === 'file') {
        try {
          parsed = JSON.parse(raw) as Json;
        } catch (error) {
          parseError = error instanceof Error ? error.message : String(error);
        }
      } else if (stat.kind !== 'missing') {
        parseError = `${CONFIG_PATH} is a ${stat.kind}, not a file.`;
      }
      spinner.dispose();
      paint();
    } catch (error) {
      spinner.dispose();
      mounted.push(mountBanner(body, { tone: 'error', title: 'Could not read config', body: errorText(error) }));
    }
  };

  const save = async (button: { update: (next: { loading?: boolean }) => void }): Promise<void> => {
    try {
      JSON.parse(draft);
    } catch (error) {
      void host.toast({ kind: 'error', message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    button.update({ loading: true });
    try {
      await host.writeFile(CONFIG_PATH, draft);
      await host.toast({ kind: 'success', message: 'Saved opencode.json' });
      await load();
    } catch (error) {
      button.update({ loading: false });
      void host.toast({ kind: 'error', message: errorText(error) });
    }
  };

  const nodeAt = (value: Json, at: string[]): Json => {
    let current: Json = value;
    for (const key of at) {
      if (!isContainer(current)) return null;
      current = Array.isArray(current) ? current[Number(key)] ?? null : current[key] ?? null;
    }
    return current;
  };

  const paintHeader = (): void => {
    clear(header, headerMounted);
    headerMounted.push(mountTabs(header, {
      items: [
        { id: 'explore', label: 'Explore' },
        { id: 'raw', label: 'Raw' },
      ],
      activeId: tab,
      onChange: (id) => {
        tab = id === 'raw' ? 'raw' : 'explore';
        paint();
      },
    }));
    if (parsed !== null && isRecord(parsed) && typeof parsed.$schema === 'string') {
      headerMounted.push(mountBadge(header, { label: 'schema', tone: 'info' }));
    }
    headerMounted.push(mountButton(header, { label: 'Reload', variant: 'ghost', size: 'xs', onClick: () => void load() }));
  };

  const paintExplore = (): void => {
    if (parseError) {
      mounted.push(mountBanner(body, {
        tone: 'error',
        title: 'Cannot parse opencode.json',
        body: parseError,
        action: { label: 'Open raw', onClick: () => { tab = 'raw'; paint(); } },
      }));
      return;
    }
    if (parsed === null) {
      mounted.push(mountEmpty(body, {
        title: 'No config yet',
        body: `${CONFIG_PATH} does not exist. Create it on the Raw tab.`,
        action: { label: 'Open raw', onClick: () => { tab = 'raw'; paint(); } },
      }));
      return;
    }

    const crumbs = row(body);
    mounted.push(mountButton(crumbs, {
      label: 'opencode.json',
      variant: path.length === 0 ? 'secondary' : 'ghost',
      size: 'xs',
      onClick: () => { path = []; paint(); },
    }));
    path.forEach((key, index) => {
      mounted.push(mountText(crumbs, { text: '/' }));
      mounted.push(mountButton(crumbs, {
        label: key,
        variant: index === path.length - 1 ? 'secondary' : 'ghost',
        size: 'xs',
        onClick: () => { path = path.slice(0, index + 1); paint(); },
      }));
    });

    const node = nodeAt(parsed, path);
    if (!isContainer(node)) {
      const info = describe(node);
      mounted.push(mountTextField(body, {
        label: path[path.length - 1] ?? 'value',
        value: info.text,
        multiline: typeof node === 'string' && node.length > 60,
        mono: true,
        disabled: true,
        helper: info.meta,
        onChange: () => {},
      }));
      return;
    }

    const entries = entriesOf(node);
    if (entries.length === 0) {
      mounted.push(mountEmpty(body, { title: 'Empty', body: Array.isArray(node) ? 'This array has no items.' : 'This object has no keys.' }));
      return;
    }
    mounted.push(mountList(body, {
      ariaLabel: path.length === 0 ? 'Top-level keys' : path.join('.'),
      items: entries.map(([key, value]) => {
        const info = describe(value);
        return {
          id: key,
          leading: key,
          title: info.text.length > 80 ? `${info.text.slice(0, 80)}…` : info.text,
          badge: { label: info.meta, tone: info.tone },
          meta: isContainer(value) ? '›' : undefined,
        };
      }),
      onSelect: (id) => {
        path = [...path, id];
        paint();
      },
    }));
  };

  const paintRaw = (): void => {
    mounted.push(mountTextField(body, {
      label: CONFIG_PATH,
      value: draft,
      multiline: true,
      mono: true,
      rows: 18,
      placeholder: '{\n  "$schema": "https://opencode.ai/config.json"\n}',
      helper: parseError ?? undefined,
      onChange: (next) => { draft = next; },
    }));
    const actions = row(body);
    const button = mountButton(actions, { label: 'Save', size: 'sm', onClick: () => void save(button) });
    mounted.push(button);
    mounted.push(mountButton(actions, {
      label: 'Discard changes',
      variant: 'ghost',
      size: 'sm',
      onClick: () => { draft = raw; paint(); },
    }));
  };

  const paint = (): void => {
    paintHeader();
    clear(body, mounted);
    if (tab === 'raw') paintRaw(); else paintExplore();
  };

  void load();
});
