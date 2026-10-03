import { connectHost, HostRequestError } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountList,
  mountSpinner,
  mountSearchField,
  mountTabs,
  mountText,
  mountTextField,
  type Tone,
} from '@openchamber/sdk/ui';
import { card, codeSample, createExample, element, paragraph } from '../../shared.ts';

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

let didMount = false;
host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  if (didMount) return;
  didMount = true;
  const app = createExample(root, { number: '05', title: 'Config Studio', description: 'A clear view of your OpenCode configuration. Explore its structure, edit with intent, and review the change before saving.', api: 'Scoped filesystem' });
  const file = card(app.content, 'opencode.json', CONFIG_PATH);
  const statusRow = row(file);
  const state = mountBadge(statusRow, { label: 'Reading file…' });
  const size = paragraph(statusRow, '', 'inline-note');
  const header = row(file);
  const searchRoot = column(file);
  const body = column(file);
  codeSample(app.content, 'const file = await host.readFile("~/.config/opencode/opencode.json");\nawait host.writeFile(path, draft);\n// Access is limited to the manifest’s filesystem pattern.');
  const headerMounted: Disposable[] = [];
  const mounted: Disposable[] = [];

  let raw = '';
  let draft = '';
  let parsed: Json | null = null;
  let fileExists = false;
  let parseError: string | null = null;
  let tab: 'explore' | 'raw' | 'review' = 'explore';
  let path: string[] = [];
  let saving = false;
  let query = '';
  let reloadControl: ReturnType<typeof mountButton> | undefined;
  const search = mountSearchField(searchRoot, { value: '', placeholder: 'Filter keys in this object…', onChange: (value) => { query = value; search.update({ value }); paintBody(); } });
  const paintState = () => {
    state.update({ label: saving ? 'Saving…' : draft !== raw ? 'Unsaved changes' : fileExists ? 'Saved on this instance' : 'New file', tone: draft !== raw ? 'warning' : 'neutral' });
    size.textContent = `${new TextEncoder().encode(draft).length.toLocaleString()} bytes · JSON`;
    reloadControl?.update({ disabled: saving || draft !== raw });
  };

  const load = async (): Promise<void> => {
    searchRoot.hidden = true;
    clear(header, headerMounted);
    clear(body, mounted);
    const spinner = mountSpinner(body, { label: 'Reading opencode.json' });
    try {
      const stat = await host.stat(CONFIG_PATH);
      fileExists = stat.kind === 'file';
      raw = stat.kind === 'file' ? (await host.readFile(CONFIG_PATH)).content : '';
      draft = raw;
      path = [];
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
      state.update({ label: 'Read failed', tone: 'error' });
      mounted.push(mountBanner(body, { tone: 'error', title: 'Could not read config', body: errorText(error), action: { label: 'Try again', onClick: () => void load() } }));
    }
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    const written = draft;
    try {
      JSON.parse(written);
    } catch (error) {
      void host.toast({ kind: 'error', message: `Not valid JSON: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    saving = true;
    paint();
    try {
      await host.writeFile(CONFIG_PATH, written);
      raw = written;
      // SAFETY: JSON.parse validates the saved JSON; every JSON value fits Json.
      parsed = JSON.parse(written) as Json;
      fileExists = true;
      parseError = null;
      path = [];
      await host.toast({ kind: 'success', message: 'Saved opencode.json' });
    } catch (error) {
      void host.toast({ kind: 'error', message: errorText(error) });
    } finally {
      saving = false;
      paint();
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
        { id: 'review', label: 'Review' },
      ],
      activeId: tab,
      onChange: (id) => {
        tab = id === 'raw' ? 'raw' : id === 'review' ? 'review' : 'explore';
        paint();
      },
    }));
    if (parsed !== null && isRecord(parsed) && typeof parsed.$schema === 'string') {
      headerMounted.push(mountBadge(header, { label: 'schema', tone: 'info' }));
    }
    reloadControl = mountButton(header, { label: 'Reload', variant: 'ghost', size: 'xs', disabled: saving || draft !== raw, onClick: () => void load() });
    headerMounted.push(reloadControl);
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
    if (!fileExists) {
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

    const entries = entriesOf(node).filter(([key]) => key.toLowerCase().includes(query.toLowerCase()));
    if (entries.length === 0) {
      mounted.push(mountEmpty(body, { title: query ? 'No matching keys' : 'Empty', body: query ? 'Try a shorter filter.' : Array.isArray(node) ? 'This array has no items.' : 'This object has no keys.' }));
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
        query = ''; search.update({ value: '' });
        paint();
      },
    }));
  };

  const paintRaw = (): void => {
    const editor = mountTextField(body, {
      label: CONFIG_PATH,
      value: draft,
      multiline: true,
      mono: true,
      rows: 18,
      placeholder: '{\n  "$schema": "https://opencode.ai/config.json"\n}',
      helper: parseError ?? undefined,
      onChange: (next) => { draft = next; editor.update({ value: next }); paintState(); },
    });
    mounted.push(editor);
    const actions = row(body);
    const button = mountButton(actions, { label: 'Review changes', size: 'sm', disabled: saving, onClick: () => { tab = 'review'; paint(); } });
    mounted.push(button);
    mounted.push(mountButton(actions, { label: 'Format JSON', variant: 'outline', disabled: saving, onClick: () => {
      try { draft = JSON.stringify(JSON.parse(draft), null, 2) + '\n'; editor.update({ value: draft }); paintState(); }
      catch (error) { editor.update({ error: error instanceof Error ? error.message : String(error) }); }
    } }));
    mounted.push(mountButton(actions, {
      label: 'Discard changes',
      disabled: saving,
      variant: 'ghost',
      size: 'sm',
      onClick: () => { draft = raw; paint(); },
    }));
  };

  const paintReview = () => {
    let valid = true;
    try { JSON.parse(draft); } catch (error) { valid = false; mounted.push(mountBanner(body, { tone: 'error', title: 'Fix the JSON before saving', body: error instanceof Error ? error.message : String(error) })); }
    const comparison = element('div', 'grid'); body.append(comparison);
    for (const [title, value] of [['On disk', raw], ['Your draft', draft]]) {
      const side = card(comparison, title);
      side.append(element('pre', 'code', value.slice(0, 80000) || 'No file yet'));
      if (value.length > 80000) paragraph(side, 'Preview limited to 80,000 characters. Saving writes the complete draft.');
    }
    const actions = row(body);
    mounted.push(mountButton(actions, { label: 'Save', loading: saving, disabled: !valid || draft === raw, onClick: () => void save() }));
    mounted.push(mountButton(actions, { label: 'Back to editor', variant: 'ghost', onClick: () => { tab = 'raw'; paint(); } }));
    paragraph(body, 'Writes only the declared config file on the connected instance.');
  };
  const paintBody = (): void => {
    clear(body, mounted);
    searchRoot.hidden = tab !== 'explore';
    if (tab === 'raw') paintRaw(); else if (tab === 'review') paintReview(); else paintExplore();
  };
  const paint = (): void => {
    paintState(); paintHeader(); paintBody();
  };

  void load();
});
