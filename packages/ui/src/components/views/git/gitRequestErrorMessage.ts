import { GitNetworkOperationRequestError } from '@/lib/api/types';
import type { I18nKey, I18nParams } from '@/lib/i18n';

type Translate = (key: I18nKey, params?: I18nParams) => string;

/** What a refused Git network request tells the user: the fix when its code names one, else the server's reason. */
export const gitRequestErrorMessage = (error: Error, t: Translate): string => (
  error instanceof GitNetworkOperationRequestError && error.code === 'REMOTE_URL_USERINFO'
    ? t('gitView.toast.remoteUrlUserinfo')
    : error.message
);
