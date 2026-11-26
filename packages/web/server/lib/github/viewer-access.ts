// external: https://docs.github.com/en/organizations/managing-user-access-to-your-organizations-repositories/managing-repository-roles/repository-roles-for-an-organization Triage closes and assigns issues and pull requests; writing a branch takes Write.
const ITEM_WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE']);
const BRANCH_WRITE_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

type Permission = string | null | undefined;

export const itemAccessOf = (permission: Permission): { writeAccess?: boolean } => (
  permission == null ? {} : { writeAccess: ITEM_WRITE_PERMISSIONS.has(permission) }
);

export const pullAccessOf = (permission: Permission): { writeAccess?: boolean; branchWriteAccess?: boolean } => (
  permission == null ? {} : { writeAccess: ITEM_WRITE_PERMISSIONS.has(permission), branchWriteAccess: BRANCH_WRITE_PERMISSIONS.has(permission) }
);
