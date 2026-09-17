import { connectHost } from '@openchamber/sdk';
import { applyHostReady, mountBadge, mountBanner, mountButton, mountCheckbox, mountEmpty, mountList, mountMenu, mountProgress, mountSearchField, mountSelect, mountSeparator, mountSpinner, mountSwitch, mountTabs, mountTextField } from '@openchamber/sdk/ui';
import { card, codeSample, createExample, element, feedback, metrics, paragraph, row } from '../../shared.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing root');
let mounted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  if (mounted) return;
  mounted = true;
  const app = createExample(root, { number: '01', title: 'SDK Playground', description: 'A small place to try big ideas. Explore the building blocks, watch the host respond, and take the patterns into your own extension.', api: 'No permissions needed' });
  const notice = feedback(app.content);
  const panels = new Map<string, HTMLElement>();
  const tabItems = [{ id: 'components', label: 'Components' }, { id: 'context', label: 'Live context' }, { id: 'actions', label: 'Host actions' }, { id: 'storage', label: 'Storage' }];
  const tabs = mountTabs(app.toolbar, { activeId: 'components', trackBackground: true,
    items: tabItems,
    onChange: (id) => { tabs.update({ activeId: id }); for (const [key, panel] of panels) panel.hidden = key !== id; },
  });
  for (const { id, label } of tabItems) {
    const panel = element('div', 'grid'); panel.hidden = id !== 'components'; panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-label', label); panels.set(id, panel); app.content.append(panel);
  }
  const panel = (id: string) => { const value = panels.get(id); if (!value) throw new Error('Missing tab'); return value; };
  const form = card(panel('components'), 'Make yourself at home', 'Controlled inputs keep their values when the host sends a new snapshot.');
  const name = mountTextField(form, { label: 'Name', value: '', placeholder: 'What should we call your extension?', onChange: (value) => name.update({ value }) });
  const layout = mountSelect(form, { label: 'Starting point', value: 'board', searchable: true,
    options: [{ id: 'board', label: 'A project board', hint: 'Sessions + storage' }, { id: 'explorer', label: 'A service explorer', hint: 'Integration' }, { id: 'utility', label: 'A local utility', hint: 'Service' }], onChange: (value) => layout.update({ value }) });
  const live = mountSwitch(form, { label: 'Live updates', description: 'Keep the view in sync with the host.', checked: true, onChange: (checked) => live.update({ checked }) });
  const check = mountCheckbox(form, { label: 'Remember my selection', checked: false, onChange: (checked) => check.update({ checked }) });
  codeSample(form, 'const field = mountTextField(root, {\n  value: "",\n  onChange: value => field.update({ value }),\n});');

  const preview = card(panel('components'), 'A little momentum', 'The same theme-aware components, composed into a progress card.');
  const counts = metrics(preview, ['Completed', 'Remaining', 'Progress']);
  let done = 3; const progress = mountProgress(preview, { value: 38, label: 'Preparing your extension' });
  const paint = () => { counts([done, 8 - done, `${Math.round(done / 8 * 100)}%`]); progress.update({ value: done / 8 * 100 }); };
  const progressActions = row(preview);
  mountButton(progressActions, { label: 'Complete a step', onClick: () => { done = Math.min(8, done + 1); paint(); } });
  mountButton(progressActions, { label: 'Reset', variant: 'ghost', onClick: () => { done = 0; paint(); } });
  const badges = row(preview);
  for (const tone of ['neutral', 'primary', 'info', 'success', 'warning', 'error'] as const) mountBadge(badges, { label: tone, tone });
  mountMenu(preview, { label: 'More actions', variant: 'outline', items: [{ id: 'copy', label: 'Copy this idea' }, { id: 'disabled', label: 'Not available yet', disabled: true }, { separator: true }, { id: 'reset', label: 'Reset progress', destructive: true }], onSelect: (id) => {
    if (id === 'reset') { done = 0; paint(); } else void notice.run(async () => { await host.writeClipboard('A progress card built with @openchamber/sdk/ui'); notice.show('Copied', 'Now make it your own.', 'success'); });
  } });
  paint();
  const library = card(panel('components'), 'Find your next idea', 'Searchable lists and empty states should feel just as considered as the happy path.');
  const ideas = ['Release companion', 'Issue triage', 'Research notebook', 'Local diagnostics'];
  const list = mountList(library, { ariaLabel: 'Extension ideas', items: ideas.map((title) => ({ id: title, title, subtitle: 'Something you could build with the SDK' })), onSelect: (id) => list.update({ selectedId: id }) });
  const searchBox = element('div'); library.prepend(searchBox);
  const search = mountSearchField(searchBox, { value: '', placeholder: 'Search ideas', onChange: (value) => { search.update({ value }); list.update({ items: ideas.filter((title) => title.toLowerCase().includes(value.toLowerCase())).map((title) => ({ id: title, title })) }); } });
  codeSample(library, 'list.update({ items, selectedId });');
  const states = card(panel('components'), 'States deserve design', 'Loading, useful guidance, and a clear next step.');
  mountSpinner(states, { label: 'Listening for a response' }); mountSeparator(states);
  mountBanner(states, { title: 'Ready when you are', body: 'Use a banner for something the reader needs to know.', tone: 'info' });
  mountEmpty(states, { title: 'A clean slate', body: 'Start small. Add the first item when you have something worth keeping.' });

  const liveContext = card(panel('context'), 'Your host, live', 'Switch projects or sessions in OpenChamber. This view follows without rebuilding the controls.');
  const contextOutput = element('pre', 'code'); liveContext.append(contextOutput);
  let current = context;
  const showContext = () => { contextOutput.textContent = JSON.stringify({ directory: current.directory, session: current.session, surface: current.surface, theme: current.theme.mode, locale: current.locale }, null, 2); };
  host.onReady((next) => { current = next; showContext(); });
  host.onDirectory((directory) => { current = { ...current, directory }; showContext(); });
  host.onSession((session) => { current = { ...current, session }; showContext(); });
  codeSample(liveContext, 'host.onReady(context => applyHostReady(context));\nhost.onSession(session => updateSession(session));');
  const guide = card(panel('context'), 'Try it', 'A few small experiments');
  for (const instruction of ['Open another session and watch its title change.', 'Switch between light and dark themes.', 'Resize the panel. The layout follows the space.', 'Return to Components. Your input is still there.']) paragraph(guide, instruction);

  const actions = card(panel('actions'), 'Give the host a nudge', 'These actions happen only when you click. Composing does not send a message.');
  let draft = 'Help me design an OpenChamber extension.';
  const draftField = mountTextField(actions, { label: 'Text to compose', value: draft, multiline: true, rows: 3, onChange: (value) => { draft = value; draftField.update({ value }); } });
  const actionRow = row(actions);
  mountButton(actionRow, { label: 'Compose', onClick: () => { void notice.run(async () => { await host.compose({ text: draft, mode: 'append' }); notice.show('Added to your draft', 'Review it in the chat before sending.', 'success'); }); } });
  mountButton(actionRow, { label: 'Copy text', variant: 'outline', onClick: () => { void notice.run(async () => { await host.writeClipboard(draft); notice.show('Copied', '', 'success'); }); } });
  mountButton(actionRow, { label: 'Toast', variant: 'ghost', onClick: () => { void notice.run(() => host.toast({ kind: 'success', message: 'Hello from your extension.' })); } });
  mountButton(actionRow, { label: 'Open Files', variant: 'ghost', onClick: () => { void notice.run(() => host.openSurface('file')); } });
  mountButton(actionRow, { label: 'Open docs', variant: 'ghost', onClick: () => { void notice.run(() => host.openUrl('https://docs.openchamber.dev/sdk/')); } });
  codeSample(actions, 'await host.compose({ text, mode: "append" });\nawait host.writeClipboard(text);\nawait host.toast({ kind: "success", message: "Done" });');

  const storage = card(panel('storage'), 'Leave a note for later', 'Saved on the connected instance, under this extension’s own namespace. Reopen the panel to find it again.');
  let note = ''; let edited = false;
  const field = mountTextField(storage, { label: 'Your note', value: note, multiline: true, rows: 5, placeholder: 'An idea worth coming back to…', onChange: (value) => { edited = true; note = value; field.update({ value }); } });
  const storageActions = row(storage);
  const save = mountButton(storageActions, { label: 'Save note', disabled: true, onClick: () => { save.update({ loading: true }); void notice.run(async () => {
    try { await host.storage.set('playground-note', note); notice.show('Note saved', 'Close and reopen the extension to try persistence.', 'success'); } finally { save.update({ loading: false }); }
  }); } });
  mountButton(storageActions, { label: 'Clear saved note', variant: 'ghost', onClick: () => { void notice.run(async () => { await host.storage.delete('playground-note'); notice.show('Saved note cleared', 'The text in your editor is kept.'); }); } });
  codeSample(storage, 'await host.storage.set("playground-note", note);\nconst saved = await host.storage.get("playground-note");');
  const loadNote = async () => {
    await notice.run(async () => { const saved = await host.storage.get('playground-note'); if (!edited) { note = String(saved ?? ''); field.update({ value: note }); } save.update({ disabled: false }); });
  };
  mountButton(storageActions, { label: 'Load saved note', variant: 'ghost', onClick: () => { void loadNote(); } });
  void loadNote();
});
