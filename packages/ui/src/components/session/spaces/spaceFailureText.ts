// What a refusal or failure of the spaces journey says to the user. The codes the user can act on
// have a sentence of their own in every language; any other shows the server's message, in
// English, rather than nothing.

import type { I18nKey, I18nParams } from '@/lib/i18n';
import { SpacesRequestError, type SpaceFailure } from '@/lib/spaces/spaces-api';

const KNOWN: ReadonlyMap<string, I18nKey> = new Map<string, I18nKey>([
  ['docker_cli_missing', 'spaces.failure.dockerMissing'],
  ['docker_cli_unusable', 'spaces.failure.dockerUnusable'],
  ['docker_daemon_unreachable', 'spaces.failure.dockerNotRunning'],
  ['docker_seccomp_missing', 'spaces.failure.dockerSeccomp'],
  ['place_cannot_restrict_network', 'spaces.failure.cannotRestrictNetwork'],
  ['project_not_registered', 'spaces.failure.projectNotRegistered'],
  ['isolated_spaces_off', 'spaces.failure.featureOff'],
  ['secret_source_missing', 'spaces.failure.envNotSet'],
  ['space_preparing', 'spaces.failure.stillPreparing'],
  ['place_missing', 'spaces.failure.placeMissing'],
]);

type Translate = (key: I18nKey, params?: I18nParams) => string;

export const spaceFailureText = (t: Translate, failure: SpaceFailure): string => {
  const key = KNOWN.get(failure.code);
  return key ? t(key) : t('spaces.failure.unexpected', { message: failure.message || failure.code });
};

/** A thrown error as a failure: the journey's own refusals keep their code, anything else is unexpected. */
export const failureOfError = (error: Error): SpaceFailure => (error instanceof SpacesRequestError
  ? { code: error.code, message: error.message }
  : { code: 'space_request_failed', message: error.message });
