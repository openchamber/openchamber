
import type { I18nKey, I18nParams } from '@/lib/i18n';
import { SpacesRequestError, type SpaceFailure } from '@/lib/spaces/spaces-api';

const KNOWN: ReadonlyMap<string, I18nKey> = new Map<string, I18nKey>([
  ['docker_cli_missing', 'spaces.failure.dockerMissing'],
  ['docker_cli_unusable', 'spaces.failure.dockerUnusable'],
  ['docker_daemon_unreachable', 'spaces.failure.dockerNotRunning'],
  ['docker_seccomp_missing', 'spaces.failure.dockerSeccomp'],
  ['docker_permission_denied', 'spaces.failure.dockerPermission'],
  ['docker_setup_not_offered', 'spaces.failure.dockerSetupNotOffered'],
  ['docker_setup_running', 'spaces.failure.dockerSetupRunning'],
  ['place_cannot_restrict_network', 'spaces.failure.cannotRestrictNetwork'],
  ['project_not_registered', 'spaces.failure.projectNotRegistered'],
  ['isolated_spaces_off', 'spaces.failure.featureOff'],
  ['secret_source_missing', 'spaces.failure.envNotSet'],
  ['stored_key_missing', 'spaces.failure.storedKeyMissing'],
  ['host_catalog_unreadable', 'spaces.failure.hostCatalogUnreadable'],
  ['login_not_found', 'spaces.failure.loginNotFound'],
  ['login_expired', 'spaces.failure.loginExpired'],
  ['login_not_supported', 'spaces.failure.loginNotSupported'],
  ['provider_not_found', 'spaces.failure.providerNotFound'],
  ['provider_not_supported', 'spaces.failure.providerNotSupported'],
  ['space_preparing', 'spaces.failure.stillPreparing'],
  ['place_missing', 'spaces.failure.placeMissing'],
  ['place_unreachable', 'spaces.failure.placeUnreachable'],
  ['place_has_spaces', 'spaces.failure.placeHasSpaces'],
  ['invalid_machine', 'spaces.failure.invalidMachine'],
  ['space_not_running', 'spaces.failure.notRunning'],
  ['space_busy', 'spaces.failure.busy'],
  ['invalid_domain', 'spaces.failure.invalidDomain'],
  ['network_is_open', 'spaces.failure.networkIsOpen'],
  ['too_many_domains', 'spaces.failure.tooManyDomains'],
  ['gatekeeper_missing', 'spaces.failure.gatekeeperGone'],
  ['space_code_never_arrived', 'spaces.failure.codeNeverArrived'],
  ['opencode_restart_failed', 'spaces.failure.openCodeRestart'],
  ['space_setup_running', 'spaces.failure.setupRunning'],
  ['space_setup_no_commands', 'spaces.group.setup.noCommands'],
  ['space_setup_shared_skipped', 'spaces.group.setup.sharedSkipped'],
  ['image_pull_failed', 'spaces.failure.imagePull'],
  ['image_pulling', 'spaces.failure.imagePulling'],
]);

const ON_MACHINE: ReadonlyMap<string, I18nKey> = new Map<string, I18nKey>([
  ['docker_cli_missing', 'spaces.failure.dockerMissingOn'],
  ['docker_daemon_unreachable', 'spaces.failure.dockerNotRunningOn'],
]);

type Translate = (key: I18nKey, params?: I18nParams) => string;

export const spaceFailureText = (t: Translate, failure: SpaceFailure, params?: I18nParams): string => {
  const key = (params?.machine ? ON_MACHINE.get(failure.code) : undefined) ?? KNOWN.get(failure.code);
  return key ? t(key, params) : t('spaces.failure.unexpected', { message: failure.message || failure.code });
};

export const failureOfError = (error: Error): SpaceFailure => (error instanceof SpacesRequestError
  ? { code: error.code, message: error.message }
  : { code: 'space_request_failed', message: error.message });
