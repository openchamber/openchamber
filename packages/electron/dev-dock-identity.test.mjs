import assert from 'node:assert/strict';
import test from 'node:test';

import { devDockBadgeFromBranch, selectDockBadge } from './dev-dock-identity.mjs';

test('takes the issue or PR number from the branch name', () => {
  assert.equal(devDockBadgeFromBranch('fix-4515-browser-scroll-timeout'), '4515');
  assert.equal(devDockBadgeFromBranch('fix/4330-browser-click-events'), '4330');
  assert.equal(devDockBadgeFromBranch('pr-4376'), '4376');
  assert.equal(devDockBadgeFromBranch('iuliia/finish-pr-4605'), '4605');
});

test('gives no badge when the branch has no number', () => {
  assert.equal(devDockBadgeFromBranch('fix/usage-claude-sign-in'), '');
  assert.equal(devDockBadgeFromBranch('main'), '');
  assert.equal(devDockBadgeFromBranch('HEAD'), '');
  assert.equal(devDockBadgeFromBranch(''), '');
});

test('ignores short numbers that are not issue numbers', () => {
  assert.equal(devDockBadgeFromBranch('feat/v2-ui'), '');
  assert.equal(devDockBadgeFromBranch('stage-7d'), '');
});

test('also takes a year or version number, which is fine for a dev aid', () => {
  assert.equal(devDockBadgeFromBranch('release-2026-10'), '2026');
});

test('the dev number keeps the badge over the unread count', () => {
  assert.deepEqual(selectDockBadge({ devNumber: '4515', unreadCount: 0 }), { text: '4515' });
  assert.deepEqual(selectDockBadge({ devNumber: '4515', unreadCount: 3 }), { text: '4515' });
});

test('without a dev number the unread count drives the badge', () => {
  assert.deepEqual(selectDockBadge({ devNumber: '', unreadCount: 3 }), { count: 3 });
  assert.deepEqual(selectDockBadge({ devNumber: '', unreadCount: 0 }), { count: 0 });
});
