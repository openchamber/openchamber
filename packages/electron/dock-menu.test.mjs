import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDockMenuTemplate, buildUnreadJumpList, isJumpListSessionId } from './dock-menu.mjs';

test('empty and invalid snapshots have no Dock actions', () => {
  for (const snapshot of [null, {}, { dockUnreadSessions: [] }, { dockUnreadSessions: [null, { id: 'bad' }] }]) {
    assert.deepEqual(buildDockMenuTemplate(snapshot, { onAction() {} }), []);
  }
});

test('lists at most ten unread titles and routes session and mark-all actions', () => {
  const actions = [];
  const sessions = Array.from({ length: 15 }, (_, index) => ({ id: `s${index}`, title: index ? 'x'.repeat(80) : 'Research & development', directory: '/project' }));
  const menu = buildDockMenuTemplate({ dockUnreadSessions: sessions }, { onAction: (action) => actions.push(action) });
  assert.equal(menu.length, 12);
  assert.equal(menu[0].label, 'Research && development');
  assert.equal(menu[1].label, `${'x'.repeat(39)}…`);
  assert.equal(menu[10].type, 'separator');
  assert.equal(menu[11].label, 'Mark all as read');
  menu[0].click();
  menu[11].click();
  assert.deepEqual(actions, [{ type: 'focus-session', sessionId: 's0', directory: '/project' }, { type: 'mark-all-read' }]);
});

test('localizes native actions and untitled fallback', () => {
  const menu = buildDockMenuTemplate({ dockUnreadSessions: [{ id: 's', title: '', directory: '' }] }, { locale: 'uk', onAction() {} });
  assert.equal(menu[0].label, 'Сесія без назви');
  assert.equal(menu[2].label, 'Позначити все прочитаним');
});

test('jump list shares the cap and order and launches the existing session deep-link route', () => {
  const sessions = Array.from({ length: 15 }, (_, index) => ({ id: `ses_${index}`, title: `Session ${index}`, directory: '/project' }));
  const list = buildUnreadJumpList({ dockUnreadSessions: sessions }, { execPath: 'C:\\Program Files\\OpenChamber.exe', locale: 'uk' });
  assert.equal(list[0].name, 'Непрочитані');
  assert.equal(list[0].items.length, 10);
  assert.equal(list[0].items[0].program, 'C:\\Program Files\\OpenChamber.exe');
  assert.equal(list[0].items[0].args, '"openchamber://session/ses_0?source=jump-list"');
  assert.equal(list[0].items[9].title, 'Session 9');
  assert.equal(list[1].items[0].args, '--mark-all-read');
  assert.equal(list[1].items[0].title, 'Позначити все прочитаним');
  assert.equal(buildUnreadJumpList({}, { execPath: '/app' }), null);
});

test('command-line session IDs reject paths, quotes, whitespace and other prefixes', () => {
  for (const value of ['ses_a1', 'ses_test_2']) assert.equal(isJumpListSessionId(value), true);
  for (const value of ['', 's1', 'ses_', 'ses_a/b', 'ses_a"', 'ses_a b', 'ses_a?x', 'ses_💥', 'ses_' + 'a'.repeat(121)]) {
    assert.equal(isJumpListSessionId(value), false);
    assert.equal(buildUnreadJumpList({ dockUnreadSessions: [{ id: value, title: 'bad' }] }, { execPath: '/app' }), null);
  }
});

test('jump lists omit user-removed arguments before deriving their dedupe key', () => {
  const snapshot = { dockUnreadSessions: [
    { id: 'ses_a', title: 'First' }, { id: 'ses_b', title: 'Second' },
  ] };
  const options = { execPath: '/app' };
  const original = buildUnreadJumpList(snapshot, options);
  const removedItems = [{ args: original[0].items[0].args }];
  const filtered = buildUnreadJumpList(snapshot, { ...options, removedItems });
  assert.deepEqual(filtered[0].items.map((item) => item.title), ['Second']);
  assert.notEqual(JSON.stringify(filtered), JSON.stringify(original));
  assert.equal(JSON.stringify(filtered), JSON.stringify(buildUnreadJumpList(snapshot, { ...options, removedItems })));
  const allRemoved = buildUnreadJumpList(snapshot, {
    ...options, removedItems: original[0].items.map((item) => ({ args: item.args })),
  });
  assert.equal(allRemoved.length, 1);
  assert.equal(allRemoved[0].type, 'tasks');
  assert.equal(allRemoved[0].items[0].args, '--mark-all-read');
});
