import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_SIZE,
  SettingsControlGroup,
  SettingsStackedField,
} from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { GitPublishContext, GitPublishTargets } from '@/lib/boundGitNetworkOperation';

/** Dialog controls fill their stacked field; the settings width cap is for wide pages. */
const CONTROL_CLASS = 'max-w-none';

export function PublishDialog({ context, onSelect }: {
  context: GitPublishContext;
  onSelect: (targets: GitPublishTargets | null) => void;
}) {
  const { t } = useI18n();
  const id = React.useId();
  const remotes = context.bindingRead.binding.remotes;
  const trackedRemote = remotes.find((remote) => context.status.tracking?.startsWith(`${remote.name}/`));
  const [pushRemote, setPushRemote] = React.useState('');
  const [pushBranch, setPushBranch] = React.useState(context.status.current);
  const [fetchRemote, setFetchRemote] = React.useState(trackedRemote?.name ?? '');
  const [fetchBranch, setFetchBranch] = React.useState(trackedRemote
    ? context.status.tracking?.slice(trackedRemote.name.length + 1) ?? '' : '');
  const isSync = context.action === 'sync';
  const remoteBranches = (name: string) => context.branches.all
    .filter((ref) => ref.startsWith(`remotes/${name}/`))
    .map((ref) => ref.slice(`remotes/${name}/`.length))
    .filter((ref) => ref !== 'HEAD');
  const fetchBranches = remoteBranches(fetchRemote);
  const destinationBranches = remoteBranches(pushRemote);
  const canSubmit = Boolean(pushRemote && pushBranch.trim() && pushBranch.trim() !== 'HEAD'
    && remotes.find((remote) => remote.name === pushRemote)?.mode !== 'anonymous'
    && (!isSync || (fetchRemote && fetchBranches.includes(fetchBranch))));
  const fetchUrl = remotes.find((remote) => remote.name === fetchRemote)?.fetch.displayUrl;
  const pushUrl = remotes.find((remote) => remote.name === pushRemote)?.push.displayUrl;

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onSelect(null); }}>
      <DialogContent className="@container max-w-lg max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t(isSync ? 'gitView.publish.syncTitle' : 'gitView.publish.title')}</DialogTitle>
          <DialogDescription>{t('gitView.publish.description', { branch: context.status.current })}</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-4" onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          const targets: GitPublishTargets = {
            push: { remoteName: pushRemote, ref: `refs/heads/${pushBranch.trim()}` },
          };
          if (isSync) targets.fetch = { remoteName: fetchRemote, ref: `refs/heads/${fetchBranch}` };
          onSelect(targets);
        }}>
          {isSync ? (
            <SettingsControlGroup title={t('gitView.publish.fetchSource')} contentClassName={SETTINGS_FIELDS_STACK_CLASS}>
              <SettingsStackedField
                label={t('settings.sourceControl.transport.remoteLabel')}
                description={fetchUrl}
                descriptionPlacement="after"
                controlClassName={CONTROL_CLASS}
              >
                <Select value={fetchRemote} onValueChange={(value) => { setFetchRemote(value); setFetchBranch(''); }}>
                  <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-full" aria-label={t('gitView.publish.fetchSource')}>
                    <SelectValue placeholder={t('gitView.publish.selectRemote')} />
                  </SelectTrigger>
                  <SelectContent>{remotes.map((remote) => <SelectItem key={remote.name} value={remote.name}>{remote.name}</SelectItem>)}</SelectContent>
                </Select>
              </SettingsStackedField>
              <SettingsStackedField
                label={t('gitView.publish.sourceBranch')}
                description={fetchRemote && !fetchBranches.length ? t('gitView.publish.fetchFirst') : undefined}
                descriptionPlacement="after"
                controlClassName={CONTROL_CLASS}
              >
                <Select value={fetchBranch} onValueChange={setFetchBranch} disabled={!fetchBranches.length}>
                  <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-full" aria-label={t('gitView.publish.sourceBranch')}>
                    <SelectValue placeholder={t('gitView.publish.sourceBranch')} />
                  </SelectTrigger>
                  <SelectContent>{fetchBranches.map((branch) => <SelectItem key={branch} value={branch}>{branch}</SelectItem>)}</SelectContent>
                </Select>
              </SettingsStackedField>
            </SettingsControlGroup>
          ) : null}
          <SettingsControlGroup
            title={t('gitView.publish.pushDestination')}
            className={isSync ? 'border-t border-border/60 pt-4' : undefined}
            contentClassName={SETTINGS_FIELDS_STACK_CLASS}
          >
            <SettingsStackedField
              label={t('settings.sourceControl.transport.remoteLabel')}
              description={pushUrl}
              descriptionPlacement="after"
              controlClassName={CONTROL_CLASS}
            >
              <Select value={pushRemote} onValueChange={setPushRemote}>
                <SelectTrigger size={SETTINGS_SELECT_SIZE} className="w-full" aria-label={t('gitView.publish.pushDestination')}>
                  <SelectValue placeholder={t('gitView.publish.selectRemote')} />
                </SelectTrigger>
                <SelectContent>{remotes.map((remote) => <SelectItem key={remote.name} value={remote.name} disabled={remote.mode === 'anonymous'}>
                  {remote.name}{remote.mode === 'anonymous' ? ` · ${t('settings.sourceControl.transport.anonymous')}` : ''}
                </SelectItem>)}</SelectContent>
              </Select>
            </SettingsStackedField>
            <SettingsStackedField
              label={<label htmlFor={`${id}-branch`}>{t('gitView.publish.destinationBranch')}</label>}
              description={<code className="break-all">{`refs/heads/${context.status.current} → ${pushRemote || '?'}:refs/heads/${pushBranch.trim()}`}</code>}
              descriptionPlacement="after"
              controlClassName={CONTROL_CLASS}
            >
              <Input id={`${id}-branch`} list={`${id}-branches`} className="h-8 rounded-md" value={pushBranch} onChange={(event) => setPushBranch(event.target.value)} />
              <datalist id={`${id}-branches`}>{destinationBranches.map((branch) => <option key={branch} value={branch} />)}</datalist>
            </SettingsStackedField>
          </SettingsControlGroup>
          {!remotes.length ? <p role="status" className={cn(SETTINGS_HELPER_CLASS, 'text-[var(--status-warning)]')}>{t('gitView.publish.noGrants')}</p> : null}
          <DialogFooter>
            <Button type="button" size="sm" variant="ghost" onClick={() => onSelect(null)}>{t('gitView.common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={!canSubmit}>{t(isSync ? 'gitView.sync.syncChanges' : 'gitView.publish.title')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
