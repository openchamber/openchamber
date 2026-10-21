/**
 * The source-control providers the UI knows how to name.
 *
 * Runtime gates live in the server's `source-control/providers.js`; this list
 * exists so the union, the zod enums and the labels cannot drift from each
 * other. A parity test keeps both lists equal.
 */
export const SOURCE_CONTROL_PROVIDERS = ['github', 'gitlab', 'gitea'] as const;

export type SourceControlProvider = (typeof SOURCE_CONTROL_PROVIDERS)[number];

export const PROVIDER_LABELS: Record<SourceControlProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  gitea: 'Gitea',
};

/** GitLab addresses merge requests as `!N`; GitHub and Gitea as `#N`. */
export const PROVIDER_CHANGE_REQUEST_PREFIX: Record<SourceControlProvider, '#' | '!'> = {
  github: '#',
  gitlab: '!',
  gitea: '#',
};
