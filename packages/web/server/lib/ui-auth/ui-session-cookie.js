const DEFAULT_UI_SESSION_COOKIE_NAME = 'oc_ui_session';

export const resolveUiSessionCookieName = (env = process.env) =>
  env.OPENCHAMBER_SESSION_COOKIE_NAME || DEFAULT_UI_SESSION_COOKIE_NAME;
