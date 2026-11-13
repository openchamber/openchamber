import { z } from 'zod'

const missingFormMessage = z.string().regex(/Form(?:\.)?NotFoundError|Form request not found/i)

/**
 * The server no longer has this form. The reply or cancel cannot be retried:
 * the request was already settled, or it was never on this directory.
 * Callers must not present that as "submit failed, try again".
 */
export const isFormRequestNotFoundError = z.union([
  z.object({ status: z.literal(404) }),
  z.instanceof(Error).transform((error) => error.message).pipe(missingFormMessage),
  missingFormMessage,
]).transform(() => true).catch(false).parse
