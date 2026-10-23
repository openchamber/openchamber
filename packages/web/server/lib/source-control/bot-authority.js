import { isPlainObject, isString } from '../shared/guards.js';

/** Server-built bot authority is independent of the user's repository binding. */
export const isBotMutationAuthority = (value) => isPlainObject(value)
  && Object.keys(value).length === 5
  && ['botId', 'itemId', 'identityId'].every((key) => isString(value[key])
    && /^[A-Za-z0-9._:-]{1,200}$/.test(value[key]))
  && ['identityRevision', 'credentialRevision'].every((key) => Number.isSafeInteger(value[key]) && value[key] > 0);
