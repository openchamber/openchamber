// Platform admin guard (plan section 7.2).
//
// Admin authorization MUST be re-read from the database on every request: the
// session cookie only proves authentication, and a role change (or account
// removal) must take effect immediately, without waiting for sessions to
// expire. There is intentionally no caching here.
//
// Non-admin callers receive the SAME 404 as for a missing route so the
// response cannot be used to enumerate which endpoints exist (plan section
// 7.2: unauthorized access is indistinguishable from a missing resource -
// never 403).

export function requirePlatformAdmin(db) {
  return async (req, res, next) => {
    try {
      const { rows } = await db.query(
        'SELECT role, status FROM users WHERE id = $1',
        [req.platformUser.id],
      );
      // Unknown, demoted or non-admin accounts all answer with the same 404.
      if (!rows[0] || rows[0].status !== 'active' || rows[0].role !== 'admin') {
        return res.status(404).json({
          error: 'not_found',
          request_id: req.platformRequestId,
        });
      }
      return next();
    } catch (error) {
      req.platformLogger?.error?.(`[platform-admin] admin check failed: ${error?.message || error}`);
      return res.status(500).json({
        error: 'internal_error',
        request_id: req.platformRequestId,
      });
    }
  };
}
