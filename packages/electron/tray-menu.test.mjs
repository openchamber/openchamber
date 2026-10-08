import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeTrayIconState,
  computeTrayTitle,
  computeTrayTooltip,
  buildTrayMenu,
  trayMenuKey,
  trayCounts,
} from './tray-menu.mjs';

const collectLabels = (items, out = []) => {
  for (const item of items) {
    if (!item) continue;
    if (item.label) out.push(item.label);
    if (Array.isArray(item.submenu)) collectLabels(item.submenu, out);
  }
  return out;
};

const session = (over = {}) => ({
  id: 's1', title: 'Task', status: 'idle', branch: '', unseen: 0, hasError: false, directory: '', subtitle: '', ...over,
});

test('buildTrayMenu localizes headers, actions and session rows', () => {
  const labels = collectLabels(buildTrayMenu({
    instanceName: '本机 OpenChamber',
    sessions: [session({ title: '任务一' })],
    approvals: [{ kind: 'permission', id: 'a1', sessionId: 's1', sessionTitle: '任务一', label: '', directory: '' }],
    usage: { mode: 'remaining', groups: [] },
  }, 'zh-CN'));

  assert.ok(labels.includes('需要你处理'), JSON.stringify(labels));
  assert.ok(labels.includes('允许一次'), JSON.stringify(labels));
  assert.ok(labels.includes('始终允许'), JSON.stringify(labels));
  assert.ok(labels.includes('拒绝'), JSON.stringify(labels));
  assert.ok(labels.includes('在应用中打开'), JSON.stringify(labels));
  assert.ok(labels.includes('会话'), JSON.stringify(labels));
  assert.ok(labels.includes('新建会话'), JSON.stringify(labels));
  assert.ok(labels.includes('显示窗口'), JSON.stringify(labels));
  assert.ok(labels.includes('关闭'), JSON.stringify(labels));
});

test('buildTrayMenu uses the macOS tail when quitOnClose is false', () => {
  const labels = collectLabels(buildTrayMenu({ sessions: [], approvals: [] }, 'en', { quitOnClose: false }));
  assert.ok(labels.includes('Show OpenChamber'), JSON.stringify(labels));
  assert.ok(labels.includes('Quit OpenChamber'), JSON.stringify(labels));
  assert.ok(!labels.includes('Show Window'));
});

test('buildTrayMenu shows empty state and overflow in the active locale', () => {
  const empty = collectLabels(buildTrayMenu({ sessions: [], approvals: [] }, 'de'));
  assert.ok(empty.includes('Keine aktiven Sitzungen'), JSON.stringify(empty));

  const many = buildTrayMenu({ sessions: Array.from({ length: 11 }, (_, i) => session({ id: `s${i}`, title: `T${i}` })), approvals: [] }, 'en');
  assert.ok(collectLabels(many).includes('3 more…'), JSON.stringify(collectLabels(many)));
});

test('session rows carry the status icon key and a focus action', () => {
  const menu = buildTrayMenu({ sessions: [session({ status: 'busy', hasError: true, unseen: 2 })], approvals: [] }, 'en');
  const row = menu.find((item) => item.label === 'Task');
  assert.equal(row.statusIconKey, 'busy');
  assert.deepEqual(row.action, { type: 'focus-session', sessionId: 's1', directory: '' });
});

test('usage submenu localizes the mode label', () => {
  const menu = buildTrayMenu({
    sessions: [],
    approvals: [],
    usage: { mode: 'remaining', groups: [{ provider: 'Acme', status: null, rows: [{ label: 'Window', value: '50%' }] }] },
  }, 'ja');
  const usage = menu.find((item) => typeof item.label === 'string' && item.label.startsWith('使用量'));
  assert.ok(usage, JSON.stringify(collectLabels(menu)));
  assert.match(usage.label, /残り/);
});

test('counts and tooltip localize with correct plurals', () => {
  const counts = trayCounts([session({ status: 'busy', unseen: 2 }), session({ id: 's2', hasError: true })], [{ id: 'a' }]);
  assert.deepEqual(counts, { busy: 1, error: 1, approvals: 1, unseen: 2 });

  assert.match(computeTrayTooltip(counts, 2, 'en'), /2 sessions/);
  assert.match(computeTrayTooltip(counts, 2, 'en'), /1 awaiting approval/);
  assert.match(computeTrayTooltip({ busy: 0, error: 0, approvals: 0, unseen: 0 }, 1, 'en'), /1 session/);
  assert.match(computeTrayTooltip({ busy: 0, error: 0, approvals: 0, unseen: 0 }, 1, 'en'), /idle$/);
  assert.equal(computeTrayTooltip({ busy: 0, error: 0, approvals: 0, unseen: 0 }, 0, 'zh-CN'), 'OpenChamber — 没有活动会话');
  assert.match(computeTrayTooltip({ busy: 1, error: 0, approvals: 0, unseen: 0 }, 1, 'zh-CN'), /1 个进行中/);
});

test('trayMenuKey changes with locale so a language switch rebuilds the menu', () => {
  const snapshot = { sessions: [], approvals: [] };
  assert.notEqual(trayMenuKey(snapshot, 'en'), trayMenuKey(snapshot, 'de'));
});

test('title and icon state reflect the actionable counts', () => {
  assert.equal(computeTrayTitle({ approvals: 0, error: 0 }), '');
  assert.equal(computeTrayTitle({ approvals: 2, error: 0 }), '◆ 2');
  assert.equal(computeTrayTitle({ approvals: 0, error: 1 }), '▲ 1');
  assert.equal(computeTrayIconState({ busy: 1, unseen: 5 }), 'busy');
  assert.equal(computeTrayIconState({ busy: 0, unseen: 5 }), 'unseen');
  assert.equal(computeTrayIconState({ busy: 0, unseen: 0 }), 'idle');
});
