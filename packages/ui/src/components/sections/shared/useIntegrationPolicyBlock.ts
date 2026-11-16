import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { findIntegrationPolicy, isIntegrationDenied, type IntegrationPolicy } from '@/lib/opencode/projection';

const NO_POLICIES: IntegrationPolicy[] = [];

/**
 * The layer that carries OpenChamber's plugin switches: `opencode.managed.json`,
 * or `OPENCODE_CONFIG_CONTENT`, the one document without a path, when the user
 * owns `OPENCODE_CONFIG`.
 */
const isSwitchLayer = (path: string | null): boolean => path === null || /[\\/]opencode\.managed\.json$/.test(path);

type IntegrationPolicyReadStatus =
  /** The config has not been read yet, so nothing may read as blocked or enabled. */
  | 'loading'
  /** The config was read. An empty list is an authoritative "nothing is denied". */
  | 'ready'
  /** The read failed. No row may claim to be enabled, because denied rows look the same. */
  | 'error';

interface IntegrationPolicyState {
  status: IntegrationPolicyReadStatus;
  /** Whether a read ever succeeded. Until it has, the page has no policy facts. */
  hasRead: boolean;
  isBlocked: (resource: string) => boolean;
  /** `isBlocked` without OpenChamber's own exact plugin denial, which outlives its switch until OpenCode reads the new layer. */
  isBlockedByRule: (resource: string) => boolean;
  /** Whether a statement OpenCode applies decides this resource as allowed; no matching statement is false. */
  isAllowedByRule: (resource: string) => boolean;
}

/**
 * Whether OpenCode's config blocks an MCP server (`mcp:<name>`), a skill
 * (`skill:<id>`) or a plugin (`plugin:<id>`) in a directory through an `mcp.use`,
 * `skill.use` or `plugin.use` policy. OpenCode drops a blocked entry from its own
 * lists, while these pages list what the config files hold, so the row would
 * otherwise sit there and never load. Nothing reads as blocked until the config
 * has been read.
 *
 * `status` carries what the boolean cannot: a failed read leaves every row
 * unmarked, and a control that flips a policy has to know that before it shows
 * itself as enabled. A failed re-read keeps the last policies that did arrive,
 * so a known blocked row does not turn into an enabled-looking one; a different
 * directory clears them first, so one project's rules never describe another.
 *
 * Bump `revision` after writing a policy so the page re-reads what OpenCode now
 * applies.
 */
export const useIntegrationPolicyState = (directory: string | null, revision = 0): IntegrationPolicyState => {
  const [read, setRead] = React.useState<{
    status: IntegrationPolicyReadStatus;
    hasRead: boolean;
    policies: IntegrationPolicy[];
    /** The directory the policies describe; null before the first read. */
    owner: string | null;
  }>({ status: 'loading', hasRead: false, policies: NO_POLICIES, owner: null });

  React.useEffect(() => {
    let cancelled = false;
    // A re-read of the same directory keeps the last answer so a known blocked
    // row does not flicker. A different directory has different policies: the
    // previous project's rules must not describe it while the read is pending
    // or after it fails.
    setRead((previous) => (
      previous.owner === directory
        ? { ...previous, status: 'loading' }
        : { status: 'loading', hasRead: false, policies: NO_POLICIES, owner: directory }
    ));
    opencodeClient.getIntegrationPolicies(directory)
      .then((next) => {
        if (!cancelled) setRead({ status: 'ready', hasRead: true, policies: next, owner: directory });
      })
      .catch((error) => {
        console.warn('[settings] could not read OpenCode integration policies:', error instanceof Error ? error.message : String(error));
        if (cancelled) return;
        setRead((previous) => (
          previous.owner === directory
            ? { status: 'error', hasRead: previous.hasRead, policies: previous.policies, owner: directory }
            : { status: 'error', hasRead: false, policies: NO_POLICIES, owner: directory }
        ));
      });
    return () => { cancelled = true; };
  }, [directory, revision]);

  const isBlocked = React.useCallback(
    (resource: string) => isIntegrationDenied(read.policies, resource),
    [read.policies],
  );

  const isBlockedByRule = React.useCallback(
    (resource: string) => isIntegrationDenied(
      read.policies.filter((policy) => !(policy.effect === 'deny' && policy.resource === resource && isSwitchLayer(policy.path))),
      resource,
    ),
    [read.policies],
  );

  const isAllowedByRule = React.useCallback(
    (resource: string) => findIntegrationPolicy(read.policies, resource)?.effect === 'allow',
    [read.policies],
  );

  return { status: read.status, hasRead: read.hasRead, isBlocked, isBlockedByRule, isAllowedByRule };
};

/** The boolean alone, for pages whose rows have no control that could lie. */
export const useIntegrationPolicyBlock = (directory: string | null, revision = 0): ((resource: string) => boolean) => (
  useIntegrationPolicyState(directory, revision).isBlocked
);
