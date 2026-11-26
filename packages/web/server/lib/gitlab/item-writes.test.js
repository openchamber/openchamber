import { describe, expect, it } from 'vitest';

import { gitlabBranchFlags, gitlabItemFlags } from './item-writes.js';

const project = (projectLevel, groupLevel) => ({
  permissions: {
    project_access: projectLevel === undefined ? null : { access_level: projectLevel },
    group_access: groupLevel === undefined ? null : { access_level: groupLevel },
  },
});

describe('GitLab write flags', () => {
  it.each([
    ['Planner', project(15), true, false],
    ['Reporter', project(20), true, false],
    ['Developer', project(30), true, true],
    ['Maintainer through the group', project(undefined, 40), true, true],
    ['Guest with a Developer group', project(10, 30), true, true],
  ])('a %s may edit the item, and writes its branch only from Developer up', (_role, raw, writeAccess, branchWriteAccess) => {
    expect(gitlabItemFlags({}, raw).writeAccess).toBe(writeAccess);
    expect(gitlabBranchFlags({}, raw).branchWriteAccess).toBe(branchWriteAccess);
  });

  it('leaves both unknown when GitLab names no access level', () => {
    expect(gitlabBranchFlags({ number: 1 }, {})).toEqual({ number: 1 });
    expect(gitlabBranchFlags({ number: 1 }, project())).toEqual({ number: 1 });
  });
});
