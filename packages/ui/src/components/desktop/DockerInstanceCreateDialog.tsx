import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';
import { toast } from '@/components/ui';
import { isDesktopShell, requestDirectoryAccess } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { Switch } from '@/components/ui/switch';
import {
  buildDockerInstanceImage,
  createDockerInstance,
  DockerApiError,
  notifyUpstreamChanged,
  pullDockerInstanceImage,
  type DockerInstancesSnapshot,
} from '@/lib/dockerInstances';

const DOCKER_INSTANCE_DEFAULT_IMAGE = 'opencode-instance:local';

interface DockerInstanceCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: DockerInstancesSnapshot | null;
  onCreated: () => void;
}

/**
 * Guided creation flow for a Docker-backed OpenCode instance. Collects the
 * workspace, the sharing opt-ins, and optional image/port overrides; states
 * the exact host directory a container may write to BEFORE submission; and
 * recovers from a missing image through the explicit build action.
 */
export function DockerInstanceCreateDialog({ open, onOpenChange, snapshot, onCreated }: DockerInstanceCreateDialogProps) {
  const { t } = useI18n();
  const [label, setLabel] = React.useState('');
  const [workspacePath, setWorkspacePath] = React.useState('');
  const [image, setImage] = React.useState('');
  const [shareConfig, setShareConfig] = React.useState(true);
  const [shareSkills, setShareSkills] = React.useState(true);
  const [shareCredentials, setShareCredentials] = React.useState(false);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [isBuildingImage, setIsBuildingImage] = React.useState(false);
  const [isPullingImage, setIsPullingImage] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState('');
  const [errorCode, setErrorCode] = React.useState('');
  const [workspaceError, setWorkspaceError] = React.useState<string | null>(null);
  const [isBrowsing, setIsBrowsing] = React.useState(false);
  const canBrowse = React.useState(() => isDesktopShell())[0];

  const reset = React.useCallback(() => {
    setLabel('');
    setWorkspacePath('');
    setImage('');
    setShareConfig(true);
    setShareSkills(true);
    setShareCredentials(false);
    setIsSubmitting(false);
    setIsBuildingImage(false);
    setErrorMessage('');
    setErrorCode('');
    setWorkspaceError(null);
  }, []);

  const validateWorkspace = React.useCallback((value: string): string | null => {
    const trimmed = value.trim();
    if (!trimmed) {
      return t('dockerInstances.create.field.workspaceRequired');
    }
    // Windows drive/UNC or POSIX absolute — the server re-validates
    // authoritatively for its own platform.
    const isAbsolute = /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\') || trimmed.startsWith('/');
    if (!isAbsolute) {
      return t('dockerInstances.create.field.workspaceInvalid');
    }
    return null;
  }, [t]);

  const browse = React.useCallback(async () => {
    setIsBrowsing(true);
    try {
      const result = await requestDirectoryAccess(workspacePath);
      if (result.success && result.path) {
        setWorkspacePath(result.path);
        setWorkspaceError(null);
      }
      // Cancelled: leave the field as-is, silently.
    } catch {
      // Picker unavailable — the text input remains the way to enter a path.
    } finally {
      setIsBrowsing(false);
    }
  }, [workspacePath]);

  const close = React.useCallback((nextOpen: boolean) => {
    if (!nextOpen && isSubmitting) return;
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  }, [isSubmitting, onOpenChange, reset]);

  const effectiveImage = image.trim() || DOCKER_INSTANCE_DEFAULT_IMAGE;
  const sharedSkillsPath = snapshot?.sharedSkillsHostPath || null;

  const buildImage = React.useCallback(async () => {
    setIsBuildingImage(true);
    setErrorMessage('');
    setErrorCode('');
    try {
      await buildDockerInstanceImage(effectiveImage);
      toast.success(t('dockerInstances.create.toast.imageBuilt', { image: effectiveImage }));
      setErrorCode('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t('dockerInstances.create.error.generic'));
      setErrorCode('BUILD_FAILED');
    } finally {
      setIsBuildingImage(false);
    }
  }, [effectiveImage, t]);

  const pullImage = React.useCallback(async () => {
    setIsPullingImage(true);
    setErrorMessage('');
    setErrorCode('');
    try {
      await pullDockerInstanceImage(effectiveImage);
      toast.success(t('dockerInstances.create.toast.imageBuilt', { image: effectiveImage }));
      setErrorCode('');
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : t('dockerInstances.create.error.generic'));
      setErrorCode('PULL_FAILED');
    } finally {
      setIsPullingImage(false);
    }
  }, [effectiveImage, t]);

  const submit = React.useCallback(async () => {
    if (isSubmitting) return;
    const workspaceProblem = validateWorkspace(workspacePath);
    if (workspaceProblem) {
      setWorkspaceError(workspaceProblem);
      return;
    }
    setIsSubmitting(true);
    setErrorMessage('');
    setErrorCode('');
    setWorkspaceError(null);
    try {
      await createDockerInstance({
        label: label.trim() || undefined,
        workspaceHostPath: workspacePath.trim(),
        sharing: {
          config: shareConfig,
          skills: shareSkills,
          credentials: shareCredentials,
        },
        image: image.trim() || undefined,
      });
      toast.success(t('dockerInstances.create.toast.created'));
      reset();
      onOpenChange(false);
      onCreated();
      notifyUpstreamChanged();
    } catch (error) {
      if (error instanceof DockerApiError) {
        setErrorCode(error.code);
        setErrorMessage(error.message);
      } else {
        setErrorMessage(error instanceof Error ? error.message : t('dockerInstances.create.error.generic'));
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [image, isSubmitting, label, onCreated, onOpenChange, reset, shareConfig, shareCredentials, shareSkills, t, validateWorkspace, workspacePath]);

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="w-[min(34rem,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="server" className="h-5 w-5" />
            {t('dockerInstances.create.title')}
          </DialogTitle>
          <DialogDescription>
            {t('dockerInstances.create.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="docker-instance-label" className="typography-ui-label text-foreground">{t('dockerInstances.create.field.label')}</label>
              <Input
                id="docker-instance-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder={t('dockerInstances.create.field.labelPlaceholder')}
                disabled={isSubmitting}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="docker-instance-image" className="typography-ui-label text-foreground">{t('dockerInstances.create.field.image')}</label>
              <Input
                id="docker-instance-image"
                value={image}
                onChange={(event) => setImage(event.target.value)}
                placeholder={DOCKER_INSTANCE_DEFAULT_IMAGE}
                disabled={isSubmitting || isBuildingImage}
              />
            </div>
          </div>

          <div className="space-y-1">
            <label htmlFor="docker-instance-workspace" className="typography-ui-label text-foreground">{t('dockerInstances.create.field.workspace')}</label>
            <div className="flex gap-2">
              <Input
                id="docker-instance-workspace"
                value={workspacePath}
                onChange={(event) => {
                  setWorkspacePath(event.target.value);
                  if (workspaceError) setWorkspaceError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submit();
                }}
              placeholder={t('dockerInstances.create.field.workspacePlaceholder')}
              disabled={isSubmitting}
              className="font-mono flex-1"
            />
              {canBrowse && (
                <Button
                  type="button"
                  variant="outline"
                  className="flex-shrink-0"
                  disabled={isSubmitting || isBrowsing}
                  onClick={() => void browse()}
                >
                  {isBrowsing ? <Icon name="loader-4" className="h-4 w-4 animate-spin" /> : <Icon name="folder-open" className="h-4 w-4" />}
                  {t('dockerInstances.create.actions.browse')}
                </Button>
              )}
            </div>
            {workspaceError && (
              <p className="typography-micro text-[var(--status-error)]">{workspaceError}</p>
            )}
            <p className="typography-micro text-muted-foreground">
              {t('dockerInstances.create.field.workspaceHint')}
            </p>
          </div>

          <div className="rounded-lg border border-border/50 bg-muted/20 p-3 space-y-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="typography-ui-label text-foreground">{t('dockerInstances.create.sharing.configTitle')}</div>
                <div className="typography-micro text-muted-foreground">{t('dockerInstances.create.sharing.configHint')}</div>
              </div>
              <Switch checked={shareConfig} onCheckedChange={setShareConfig} disabled={isSubmitting} aria-label={t('dockerInstances.create.sharing.configTitle')} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="typography-ui-label text-foreground">{t('dockerInstances.create.sharing.skillsTitle')}</div>
                <div className="typography-micro text-muted-foreground">{t('dockerInstances.create.sharing.skillsHint')}</div>
                {shareSkills && sharedSkillsPath && (
                  <div className="typography-micro mt-1 break-all font-mono text-[var(--status-warning)]">
                    {t('dockerInstances.create.sharing.skillsWritablePath', { path: sharedSkillsPath })}
                  </div>
                )}
              </div>
              <Switch checked={shareSkills} onCheckedChange={setShareSkills} disabled={isSubmitting} aria-label={t('dockerInstances.create.sharing.skillsTitle')} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="typography-ui-label text-foreground">{t('dockerInstances.create.sharing.credentialsTitle')}</div>
                <div className="typography-micro text-muted-foreground">{t('dockerInstances.create.sharing.credentialsHint')}</div>
              </div>
              <Switch checked={shareCredentials} onCheckedChange={setShareCredentials} disabled={isSubmitting} aria-label={t('dockerInstances.create.sharing.credentialsTitle')} />
            </div>
            <div className="typography-micro text-muted-foreground border-t border-border/50 pt-2">
              {t('dockerInstances.create.sharing.neverShared')}
            </div>
          </div>

          {errorMessage && (
            <div className="rounded-md border border-[var(--status-error)]/40 bg-[var(--status-error)]/10 p-2.5">
              <div className="typography-meta text-[var(--status-error)] break-words">{errorMessage}</div>
              {(errorCode === 'IMAGE_MISSING' || errorCode === 'BUILD_FAILED' || errorCode === 'PULL_FAILED') && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isBuildingImage || isPullingImage || isSubmitting}
                    onClick={() => void buildImage()}
                  >
                    {isBuildingImage ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" /> : <Icon name="server" className="h-3.5 w-3.5" />}
                    {t('dockerInstances.create.actions.buildImage', { image: effectiveImage })}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isBuildingImage || isPullingImage || isSubmitting}
                    onClick={() => void pullImage()}
                  >
                    {isPullingImage ? <Icon name="loader-4" className="h-3.5 w-3.5 animate-spin" /> : <Icon name="download" className="h-3.5 w-3.5" />}
                    {t('dockerInstances.create.actions.pull', { image: effectiveImage })}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => close(false)} disabled={isSubmitting}>
            {t('dockerInstances.create.actions.cancel')}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => void submit()}
            disabled={isSubmitting || isBuildingImage}
          >
            {isSubmitting ? <Icon name="loader-4" className={cn('h-4 w-4 animate-spin')} /> : <Icon name="add" className="h-4 w-4" />}
            {isSubmitting ? t('dockerInstances.create.actions.creating') : t('dockerInstances.create.actions.create')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
