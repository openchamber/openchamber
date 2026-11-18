
import { z } from 'zod';

const SSH_DESTINATION = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}(?::[1-9]\d{0,4})?$/;

export const sshHostSchema = z.string().trim().max(320).refine((value) => value === '' || SSH_DESTINATION.test(value), 'an SSH destination, [user@]host[:port]');

export const dockerHostOf = (setting: string | null | undefined) => {
  const parsed = sshHostSchema.safeParse(setting ?? '');
  return parsed.success && parsed.data !== '' ? `ssh://${parsed.data}` : null;
};
