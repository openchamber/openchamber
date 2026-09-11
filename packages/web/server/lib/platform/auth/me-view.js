// Current-user view for GET /api/platform/me (plan section 9.1).
//
// The view deliberately exposes only presence, never internals (plan section
// 7.3): the bound Linux identity is reported as a boolean, not uid/gid/home
// values, and no credentials, upstream keys or internal addresses appear
// anywhere in the payload. Workspace scheduling lands in a later task, so the
// workspace field is a stable placeholder shape for now.

const USER_CAPABILITIES = Object.freeze([
  'workspace.read',
  'workspace.start',
  'workspace.stop',
  'session.use',
  'preferences.read',
  'preferences.write',
  'models.use',
]);

const ADMIN_CAPABILITIES = Object.freeze([
  ...USER_CAPABILITIES,
  'admin.users.read',
  'admin.workspaces.read',
  'admin.workspaces.stop',
  'admin.workspaces.rebuild',
  'admin.limits.write',
  'admin.models.write',
  'admin.audit.read',
]);

const DEFAULT_LOCALE = 'en';

export function capabilitiesForRole(role) {
  return role === 'admin' ? [...ADMIN_CAPABILITIES] : [...USER_CAPABILITIES];
}

export async function buildMeView(db, { user }) {
  const { rows } = await db.query(
    'SELECT locale FROM user_preferences WHERE user_id = $1',
    [user.id],
  );
  const locale = typeof rows[0]?.locale === 'string' && rows[0].locale
    ? rows[0].locale
    : DEFAULT_LOCALE;

  // A Linux binding is valid when the imported identity carries a non-root
  // uid/gid and an absolute home path (DB constraints enforce the same).
  const linuxIdentityBound =
    Number.isInteger(user.linuxUid) && user.linuxUid > 0 &&
    Number.isInteger(user.linuxGid) && user.linuxGid > 0 &&
    typeof user.homePath === 'string' && /^\/.*[^/]$/.test(user.homePath);

  return {
    user: {
      id: user.id,
      display_name: user.displayName,
      role: user.role,
      status: user.status,
      linux_identity: { bound: linuxIdentityBound },
    },
    capabilities: capabilitiesForRole(user.role),
    locale,
    // Workspace lifecycle state is deliberately NOT joined here (keep the me
    // view lean): clients read it from GET /api/platform/workspace.
    workspace: null,
  };
}
