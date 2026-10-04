import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { SourceControlAuthAccount } from '@/lib/api/types';

type SourceControlAccountGroup = {
  key: string;
  accounts: SourceControlAuthAccount[];
};

const groupSourceControlAccounts = (
  accounts: SourceControlAuthAccount[],
): SourceControlAccountGroup[] => {
  const groups = new Map<string, SourceControlAccountGroup>();
  for (const account of accounts) {
    const key = JSON.stringify([
      account.user.provider,
      account.user.instance,
      account.user.id,
    ]);
    const group = groups.get(key);
    if (group) {
      group.accounts.push(account);
    } else {
      groups.set(key, { key, accounts: [account] });
    }
  }
  return Array.from(groups.values());
};

/**
 * A short handle for one credential of an account that has several.
 *
 * Re-authenticating adds a credential rather than replacing one, because
 * anything already bound to the old credential must keep reading as that
 * credential rather than being silently retargeted. So one person can appear
 * with two rows of the same kind, and only then does a row need a handle; a
 * reference with no short form is internal and never shown.
 */
const credentialHandle = (id: string): string | null =>
  /[0-9a-f]{8}(?=-[0-9a-f]{4}-)/i.exec(id)?.[0] ?? null;

type SourceControlAccountListProps = {
  accounts: SourceControlAuthAccount[];
  avatarAlt: (username: string) => string;
  sourceLabel: (account: SourceControlAuthAccount) => string;
  /** What is wrong with a credential, or null when it works. */
  statusLabel: (account: SourceControlAuthAccount) => string | null;
  /** Marks the credential this account acts as when nothing names another. */
  currentLabel: string;
  renderActions: (account: SourceControlAuthAccount) => React.ReactNode;
};

export const SourceControlAccountList: React.FC<SourceControlAccountListProps> = ({
  accounts,
  avatarAlt,
  sourceLabel,
  statusLabel,
  currentLabel,
  renderActions,
}) => (
  <div className="divide-y divide-[var(--surface-subtle)]">
    {groupSourceControlAccounts(accounts).map((group) => {
      const user = group.accounts[0].user;
      return (
        <div key={group.key} className="py-3 first:pt-0 last:pb-0">
          <div className="flex min-w-0 items-center gap-3">
            {user.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={avatarAlt(user.username)}
                className="size-9 shrink-0 rounded-full border border-border bg-muted object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted">
                <Icon
                  name={user.provider === 'github' ? 'github-fill' : user.provider === 'gitlab' ? 'gitlab' : 'git-branch'}
                  className="size-4 text-muted-foreground"
                />
              </div>
            )}
            <div className="min-w-0">
              <div className="truncate typography-ui-label text-foreground">
                {user.name?.trim() || user.username}
              </div>
              <div className="truncate font-mono typography-micro text-muted-foreground">
                {user.username}
              </div>
            </div>
          </div>
          <div className="ml-12 mt-2 divide-y divide-[var(--surface-subtle)]">
            {group.accounts.map((account) => {
              const source = sourceLabel(account);
              const status = statusLabel(account);
              // Rows of different kinds already tell themselves apart.
              const handle = group.accounts.some((other) => other !== account && sourceLabel(other) === source)
                ? credentialHandle(account.id) : null;
              return (
                <div
                  key={account.id}
                  className="flex flex-col gap-2 py-2 first:pt-0 last:pb-0 @xl:flex-row @xl:items-center @xl:justify-between"
                >
                  <div className="flex flex-wrap items-center gap-1.5 typography-micro text-muted-foreground">
                    <span>{source}</span>
                    {status ? <>
                      <span aria-hidden="true">·</span>
                      <span className="text-[var(--status-warning)]">{status}</span>
                    </> : null}
                    {handle ? <>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{handle}</span>
                    </> : null}
                    {group.accounts.length > 1 && account.current
                      ? <span className="rounded-full border border-border px-1.5">{currentLabel}</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">{renderActions(account)}</div>
                </div>
              );
            })}
          </div>
        </div>
      );
    })}
  </div>
);
