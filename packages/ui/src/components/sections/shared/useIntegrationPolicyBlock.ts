import React from 'react';
import { opencodeClient } from '@/lib/opencode/client';
import { findIntegrationPolicy, isIntegrationDenied, type IntegrationPolicy } from '@/lib/opencode/projection';

const NO_POLICIES: IntegrationPolicy[] = [];

const isSwitchLayer = (path: string | null): boolean => path === null || /[\\/]opencode\.managed\.json$/.test(path);

type IntegrationPolicyReadStatus =
  | 'loading'
  | 'ready'
  | 'error';

interface IntegrationPolicyState {
  status: IntegrationPolicyReadStatus;
  hasRead: boolean;
  isBlocked: (resource: string) => boolean;
  isBlockedByRule: (resource: string) => boolean;
  isAllowedByRule: (resource: string) => boolean;
}

export const useIntegrationPolicyState = (directory: string | null, revision = 0): IntegrationPolicyState => {
  const [read, setRead] = React.useState<{
    status: IntegrationPolicyReadStatus;
    hasRead: boolean;
    policies: IntegrationPolicy[];
    owner: string | null;
  }>({ status: 'loading', hasRead: false, policies: NO_POLICIES, owner: null });

  React.useEffect(() => {
    let cancelled = false;
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

export const useIntegrationPolicyBlock = (directory: string | null, revision = 0): ((resource: string) => boolean) => (
  useIntegrationPolicyState(directory, revision).isBlocked
);
