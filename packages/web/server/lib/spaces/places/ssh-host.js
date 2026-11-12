// The machine of the Docker over SSH place, as the user names it in `settings.json` under
// `isolatedSpacesSshHost`: an SSH destination, `[user@]host[:port]`, that the user's own `ssh`
// resolves, an alias from `~/.ssh/config` among them. The empty string means no such place.
//
// Only what `ssh` itself takes is accepted: a destination can carry no option, no space and no
// shell character, so the setting can never become an argument the docker CLI did not expect.

import { z } from 'zod';

// Neither part may start with a dash: `-Jhost` is an option to ssh, whatever the CLI puts before it.
const SSH_DESTINATION = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}(?::[1-9]\d{0,4})?$/;

export const sshHostSchema = z.string().trim().max(320).refine((value) => value === '' || SSH_DESTINATION.test(value), 'an SSH destination, [user@]host[:port]');

/** The `docker --host` value for a destination, or null when the setting is empty or not one. */
export const dockerHostOf = (setting) => {
  const parsed = sshHostSchema.safeParse(setting ?? '');
  return parsed.success && parsed.data !== '' ? `ssh://${parsed.data}` : null;
};
