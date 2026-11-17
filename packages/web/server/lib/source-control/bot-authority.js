import { isPlainObject, isString } from '../shared/guards.js';

/** Server-built bot authority is independent of the user's repository binding. */
export const isBotMutationAuthority = (value) => isPlainObject(value)
  && Object.keys(value).length === (value.publicationBranch === undefined ? 5 : 6)
  && ['botId', 'itemId', 'identityId'].every((key) => isString(value[key])
    && /^[A-Za-z0-9._:-]{1,200}$/.test(value[key]))
  && ['identityRevision', 'credentialRevision'].every((key) => Number.isSafeInteger(value[key]) && value[key] > 0)
  && (value.publicationBranch === undefined || isString(value.publicationBranch)
    && /^[A-Za-z0-9][A-Za-z0-9_./-]{0,199}$/.test(value.publicationBranch)
    && !value.publicationBranch.includes('..') && !value.publicationBranch.includes('//')
    && !/[/.]$/.test(value.publicationBranch)
    && value.publicationBranch.split('/').every((part) => !part.startsWith('.') && !part.endsWith('.lock')));
