import { describe, expect, test } from 'bun:test';
import { isFiledInFolder, type SidebarWorkRef } from './sidebarWorks';

describe('isFiledInFolder', () => {
  const ref: SidebarWorkRef = { kind: 'session', key: 'session:s', projectId: 'nested', rootSessionId: 's' };

  test('a folder of the work\'s own project holds it', () => {
    expect(isFiledInFolder(ref, new Map([['s', { folderId: 'f', projectId: 'nested' }]]))).toBe(true);
  });

  test('a folder of the project it left does not, so the work stays listed', () => {
    expect(isFiledInFolder(ref, new Map([['s', { folderId: 'f', projectId: 'repo' }]]))).toBe(false);
  });
});
