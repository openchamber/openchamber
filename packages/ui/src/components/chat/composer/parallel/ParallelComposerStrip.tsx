import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Icon } from '@/components/icon/Icon';
import { FusionIcon } from '@/components/icons/FusionIcon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Textarea } from '@/components/ui/textarea';
import { BranchSelector, useBranchOptions } from '@/components/multirun/BranchSelector';
import { ModelMultiSelect, type ModelSelectionWithId } from '@/components/multirun/ModelMultiSelect';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { resolveWorktreeSetupCommands } from '@/lib/sharedTrustConfirmation';
import { ModelEffortMenu } from '@/components/multirun/ModelEffortMenu';
import { SettingsRadioGroup, SettingsRadioOption } from '@/components/sections/shared/SettingsSection';
import type { ParallelComposer } from './useParallelComposer';

function SettingsColumnBlock({ title, children }: { title: string; children: React.ReactNode }): React.ReactNode {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="typography-meta font-semibold text-foreground">{title}</h3>
      {children}
    </section>
  );
}

/**
 * Launch settings of a parallel run in two fixed columns: where the lanes
 * work on the left, how they are fused and varied on the right. Controls that
 * do not apply are disabled rather than hidden, so the dialog keeps its size
 * whatever is chosen.
 */
function LaunchSettingsDialog({
  parallel,
  project,
  isGitRepository,
  open,
  onOpenChange,
}: {
  parallel: ParallelComposer;
  project: { id: string; path: string } | null;
  isGitRepository: boolean | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.ReactNode {
  const { t } = useI18n();
  const state = parallel.state;
  const [setupDraft, setSetupDraft] = React.useState('');
  const setupCommands = state?.setupCommands;
  React.useEffect(() => {
    if (open) setSetupDraft((setupCommands ?? []).join('\n'));
  }, [open, setupCommands]);
  if (!state) return null;
  const firstModel = state.variants[state.active]?.models[0];
  // The judge shown while fusion is off is the one "Automatic" would pick.
  const judge = state.fuse ?? (firstModel
    ? { providerID: firstModel.providerID, modelID: firstModel.modelID, variant: firstModel.variant, displayName: firstModel.displayName }
    : null);
  const judgeSelection: ModelSelectionWithId[] = judge ? [{ ...judge, instanceId: `${judge.providerID}:${judge.modelID}` }] : [];
  const close = () => {
    if (state.isolate) parallel.setSetupCommands(setupDraft.split('\n').map((line) => line.trim()).filter(Boolean));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-w-3xl overflow-visible">
        <DialogHeader>
          <DialogTitle>{t('chat.parallel.settings.title')}</DialogTitle>
          <DialogDescription className="sr-only">{t('chat.parallel.settings.title')}</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-x-10 gap-y-6 md:grid-cols-2">
          <div className="flex flex-col gap-5">
            <SettingsColumnBlock title={t('chat.parallel.settings.whereTitle')}>
              <SettingsRadioGroup aria-label={t('chat.parallel.settings.whereTitle')}>
                <SettingsRadioOption
                  selected={!state.isolate}
                  onSelect={() => parallel.setIsolate(false)}
                  label={t('chat.parallel.settings.whereShared')}
                  description={t('chat.parallel.settings.whereSharedHint')}
                />
                <SettingsRadioOption
                  selected={state.isolate}
                  onSelect={() => parallel.setIsolate(true)}
                  disabled={isGitRepository === false}
                  label={t('chat.parallel.settings.whereWorktrees')}
                  description={t('chat.parallel.settings.whereWorktreesHint')}
                />
              </SettingsRadioGroup>
            </SettingsColumnBlock>
            <SettingsColumnBlock title={t('chat.parallel.settings.baseBranchTitle')}>
              <BranchSelector
                directory={project?.path ?? null}
                value={state.baseBranch}
                onChange={parallel.setBaseBranch}
                disabled={!state.isolate}
                className="w-full"
              />
            </SettingsColumnBlock>
            <SettingsColumnBlock title={t('chat.parallel.settings.setupTitle')}>
              <p className="typography-micro text-muted-foreground">{t('chat.parallel.setup.dialogDescription')}</p>
              <Textarea
                value={setupDraft}
                onChange={(event) => setSetupDraft(event.target.value)}
                disabled={!state.isolate}
                placeholder="bun install"
                className="min-h-[72px] font-mono typography-micro"
              />
            </SettingsColumnBlock>
          </div>

          <div className="flex flex-col gap-5">
            <SettingsColumnBlock title={t('chat.parallel.settings.fusionTitle')}>
              <SettingsRadioGroup aria-label={t('chat.parallel.settings.fusionTitle')}>
                <SettingsRadioOption
                  selected={!state.fuse}
                  onSelect={() => parallel.setFuse(null)}
                  label={t('chat.parallel.settings.fusionOff')}
                  description={t('chat.parallel.settings.fusionOffHint')}
                />
                <SettingsRadioOption
                  selected={Boolean(state.fuse)}
                  onSelect={() => { if (!state.fuse && judge) parallel.setFuse(judge); }}
                  disabled={!judge}
                  label={t('chat.parallel.settings.fusionAuto')}
                  description={t('chat.parallel.settings.fusionAutoHint')}
                />
              </SettingsRadioGroup>
            </SettingsColumnBlock>
            <SettingsColumnBlock title={t('chat.parallel.settings.judgeTitle')}>
              <div className={cn('flex flex-wrap items-center gap-1.5', !state.fuse && 'pointer-events-none opacity-50')} aria-disabled={!state.fuse}>
                <ModelMultiSelect
                  selectedModels={judgeSelection}
                  onAdd={(model) => parallel.setFuse({ providerID: model.providerID, modelID: model.modelID, displayName: model.displayName })}
                  onUpdate={(_, model) => parallel.setFuse({ providerID: model.providerID, modelID: model.modelID, displayName: model.displayName })}
                  onRemove={() => parallel.setFuse(null)}
                  maxModels={1}
                  showChips={false}
                  dropdownSide="bottom"
                  addButtonLabel={judge ? judge.displayName || judge.modelID : t('multirun.fusion.model.placeholder')}
                  triggerIcon={judge ? <ProviderLogo providerId={judge.providerID} className="mr-1 size-3.5" /> : undefined}
                />
                {judge ? (
                  <ModelEffortMenu
                    appearance="trigger"
                    providerID={judge.providerID}
                    modelID={judge.modelID}
                    variant={judge.variant}
                    disabled={!state.fuse}
                    onChange={(variant) => { if (state.fuse) parallel.setFuse({ ...state.fuse, variant }); }}
                  />
                ) : null}
              </div>
            </SettingsColumnBlock>
            <SettingsColumnBlock title={t('chat.parallel.settings.variantsTitle')}>
              <p className="typography-micro text-muted-foreground">{t('chat.parallel.settings.variantsDescription')}</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => {
                  close();
                  parallel.addVariant();
                }}
              >
                <Icon name="add" className="size-3.5" />
                {t('chat.parallel.settings.addVariant')}
              </Button>
            </SettingsColumnBlock>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={close}>{t('chat.parallel.settings.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The composer's "Run in parallel" controls, above the editor inside the
 * composer box, so entering the mode grows the box upward and the text field
 * never moves. One row: the active variant's models, then a summary of the
 * launch settings that opens them. Variant tabs get a row only when there are
 * two or more variants.
 */
export function ParallelComposerStrip({
  parallel,
  project,
}: {
  parallel: ParallelComposer;
  project: { id: string; path: string } | null;
}): React.ReactNode {
  const { t } = useI18n();
  const state = parallel.state;
  const { isGitRepository } = useBranchOptions(project?.path ?? null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const { setIsolate, setSetupCommands } = parallel;

  // A project that is not a git repository cannot have worktrees.
  React.useEffect(() => {
    if (isGitRepository === false && state?.isolate) setIsolate(false);
  }, [isGitRepository, setIsolate, state?.isolate]);

  const needsSetupCommands = Boolean(state?.isolate) && state?.setupCommands === null;
  React.useEffect(() => {
    if (!project || !needsSetupCommands) return;
    let cancelled = false;
    // Reading the commands may ask to trust the shared ones first, the same
    // way preparing a worktree does.
    resolveWorktreeSetupCommands(project).then(
      (commands) => { if (!cancelled) setSetupCommands(commands); },
      () => { if (!cancelled) setSetupCommands([]); },
    );
    return () => { cancelled = true; };
  }, [needsSetupCommands, project, setSetupCommands]);

  if (!state) return null;
  const active = state.variants[state.active];
  const summary = [
    state.isolate ? t('chat.parallel.isolation.worktrees') : t('chat.parallel.isolation.shared'),
    state.fuse ? t('chat.parallel.fuse.judge', { model: state.fuse.displayName || state.fuse.modelID }) : t('chat.parallel.fuse.off'),
  ].join(' · ');

  return (
    <div className="relative z-10 flex flex-col gap-1.5 px-3 pt-2.5" data-parallel-composer="true">
      {state.variants.length > 1 ? (
        <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label={t('chat.parallel.variant.tabsAria')}>
          {state.variants.map((variant, index) => {
            const runs = variant.models.reduce((total, model) => total + model.count, 0);
            const selected = index === state.active;
            return (
              <span
                key={variant.id}
                className={cn(
                  'group/tab inline-flex h-6 items-center gap-1 rounded-md border pl-2 pr-1 typography-micro',
                  selected ? 'border-[var(--interactive-border-hover)] bg-interactive-selection/40 text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  onClick={() => parallel.switchVariant(index)}
                  className="inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="font-semibold">{variant.id}</span>
                  <span className="text-muted-foreground">
                    {runs === 1 ? t('chat.parallel.variant.runsSingle', { count: runs }) : t('chat.parallel.variant.runsPlural', { count: runs })}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => parallel.removeVariant(index)}
                  className="inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
                  aria-label={t('chat.parallel.variant.removeAria', { variant: variant.id })}
                >
                  <Icon name="close" className="size-3" />
                </button>
              </span>
            );
          })}
          <Button type="button" variant="ghost" size="icon" className="size-6" onClick={parallel.addVariant} aria-label={t('chat.parallel.settings.addVariant')}>
            <Icon name="add" className="size-3.5" />
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {active.models.map((model, index) => (
          <span
            key={`${model.providerID}:${model.modelID}:${model.variant ?? ''}`}
            className="group/chip inline-flex h-6 items-center gap-1 rounded-md border border-border bg-[var(--surface-elevated)] pl-1.5 pr-0.5 typography-micro text-foreground"
          >
            <ProviderLogo providerId={model.providerID} className="size-3.5" />
            <span className="max-w-[10rem] truncate">{model.displayName || model.modelID}</span>
            <ModelEffortMenu
              providerID={model.providerID}
              modelID={model.modelID}
              variant={model.variant}
              onChange={(variant) => parallel.setModelVariant(index, variant)}
            />
            {model.count > 1 ? <span className="font-semibold text-[var(--primary-base)]">×{model.count}</span> : null}
            <button
              type="button"
              onClick={() => parallel.incrementModel(index)}
              className="inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              aria-label={t('chat.parallel.models.increment', { model: model.displayName || model.modelID })}
            >
              <Icon name="add" className="size-3" />
            </button>
            <button
              type="button"
              onClick={() => parallel.decrementModel(index)}
              className="inline-flex size-4 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              aria-label={t('chat.parallel.models.decrement', { model: model.displayName || model.modelID })}
            >
              <Icon name="close" className="size-3" />
            </button>
          </span>
        ))}
        <ModelMultiSelect
          selectedModels={[]}
          onAdd={(model) => parallel.addModel({ providerID: model.providerID, modelID: model.modelID, variant: model.variant, displayName: model.displayName })}
          onRemove={() => undefined}
          maxModels={1}
          showChips={false}
          dropdownSide="top"
          portal
          addButtonClassName="h-6 min-h-6 w-6 justify-center px-0"
          addButtonLabel=""
          addButtonAriaLabel={t('chat.parallel.models.add')}
          triggerIcon={<Icon name="add" className="size-3.5" />}
        />
        <span className="flex-1" />
        <button
          type="button"
          className={cn(dropdownTriggerVariants(), 'max-w-[18rem] gap-1.5')}
          onClick={() => setSettingsOpen(true)}
          aria-label={t('chat.parallel.settings.openAria', { summary })}
        >
          {state.fuse ? <FusionIcon className="size-3.5 text-[var(--primary-base)]" /> : <Icon name="settings-3" />}
          <span className="truncate">{summary}</span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={parallel.exit}
          aria-label={t('chat.parallel.exit')}
          title={t('chat.parallel.exit')}
        >
          <Icon name="close" className="size-3.5" />
        </Button>
      </div>

      <LaunchSettingsDialog
        parallel={parallel}
        project={project}
        isGitRepository={isGitRepository}
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
