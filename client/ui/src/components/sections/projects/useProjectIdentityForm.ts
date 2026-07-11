import React from 'react';
import { toast } from '@/components/ui';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import { useProjectsStore } from '@/stores/useProjectsStore';

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

export const normalizeProjectIconBackground = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return HEX_COLOR_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
};

export type ProjectIdentitySaveData = {
  label: string;
  icon: string | null;
  color: string | null;
  iconBackground: string | null;
  defaultModel: string | null;
};

type EditableProject = Pick<
  ProjectEntry,
  'id' | 'label' | 'icon' | 'color' | 'iconBackground' | 'defaultModel' | 'iconImage' | 'path'
>;

export const useProjectIdentityForm = (project: EditableProject | null) => {
  const { t } = useI18n();
  const uploadProjectIcon = useProjectsStore((state) => state.uploadProjectIcon);
  const removeProjectIcon = useProjectsStore((state) => state.removeProjectIcon);
  const discoverProjectIcon = useProjectsStore((state) => state.discoverProjectIcon);
  const currentIconImage = useProjectsStore((state) =>
    project ? state.projects.find((entry) => entry.id === project.id)?.iconImage ?? null : null,
  );

  const [name, setName] = React.useState('');
  const [icon, setIcon] = React.useState<string | null>(null);
  const [color, setColor] = React.useState<string | null>(null);
  const [iconBackground, setIconBackground] = React.useState<string | null>(null);
  const [defaultModel, setDefaultModel] = React.useState<string | undefined>(undefined);
  const [isUploadingIcon, setIsUploadingIcon] = React.useState(false);
  const [isRemovingCustomIcon, setIsRemovingCustomIcon] = React.useState(false);
  const [isDiscoveringIcon, setIsDiscoveringIcon] = React.useState(false);
  const [pendingRemoveImageIcon, setPendingRemoveImageIcon] = React.useState(false);
  const [pendingUploadIconFile, setPendingUploadIconFile] = React.useState<File | null>(null);
  const [pendingUploadIconPreviewUrl, setPendingUploadIconPreviewUrl] = React.useState<string | null>(null);
  const [previewImageFailed, setPreviewImageFailed] = React.useState(false);
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const clearPendingUploadIcon = React.useCallback(() => {
    setPendingUploadIconFile(null);
    setPendingUploadIconPreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return null;
    });
  }, []);

  const projectId = project?.id ?? null;

  React.useEffect(() => {
    if (!project) {
      setName('');
      setIcon(null);
      setColor(null);
      setIconBackground(null);
      setDefaultModel(undefined);
      return;
    }
    setName(project.label ?? '');
    setIcon(project.icon ?? null);
    setColor(project.color ?? null);
    setIconBackground(project.iconBackground ?? null);
    setDefaultModel(project.defaultModel);
    setPendingRemoveImageIcon(false);
    clearPendingUploadIcon();
    setPreviewImageFailed(false);
  }, [project, clearPendingUploadIcon]);

  React.useEffect(() => {
    return () => {
      clearPendingUploadIcon();
    };
  }, [clearPendingUploadIcon]);

  const parsedDefaultModel = React.useMemo(() => {
    const parsed = parseModelIdentifier(defaultModel);
    return parsed ?? { providerId: '', modelId: '' };
  }, [defaultModel]);

  const hasStoredImageIcon = Boolean(project?.iconImage);
  const hasPendingUploadImageIcon = Boolean(pendingUploadIconFile && pendingUploadIconPreviewUrl);
  const hasCustomIcon = project?.iconImage?.source === 'custom';
  const effectiveHasImageIcon = (hasStoredImageIcon && !pendingRemoveImageIcon) || hasPendingUploadImageIcon;
  const hasRemovableImageIcon = effectiveHasImageIcon;
  const showStoredImagePreview = Boolean(project && hasStoredImageIcon && !pendingRemoveImageIcon);
  const showImagePreview = !previewImageFailed && (hasPendingUploadImageIcon || showStoredImagePreview);

  const hasChanges = Boolean(project) && (
    name.trim() !== (project?.label ?? '').trim()
    || icon !== (project?.icon ?? null)
    || color !== (project?.color ?? null)
    || iconBackground !== (project?.iconBackground ?? null)
    || (defaultModel ?? undefined) !== (project?.defaultModel ?? undefined)
    || pendingRemoveImageIcon
    || Boolean(pendingUploadIconFile)
  );

  const handleDefaultModelChange = React.useCallback((providerId: string, modelId: string) => {
    setDefaultModel(providerId && modelId ? `${providerId}/${modelId}` : undefined);
  }, []);

  const handleUploadIcon = React.useCallback((file: File | null) => {
    if (!project || !file || isUploadingIcon) {
      return;
    }

    setPendingRemoveImageIcon(false);
    setPreviewImageFailed(false);
    setPendingUploadIconFile(file);
    setPendingUploadIconPreviewUrl((previousUrl) => {
      if (previousUrl) {
        URL.revokeObjectURL(previousUrl);
      }
      return URL.createObjectURL(file);
    });
  }, [isUploadingIcon, project]);

  const handleRemoveImageIcon = React.useCallback(() => {
    if (!project || !hasRemovableImageIcon || isRemovingCustomIcon) {
      return;
    }

    if (hasPendingUploadImageIcon) {
      clearPendingUploadIcon();
    }
    if (hasStoredImageIcon) {
      setPendingRemoveImageIcon(true);
    } else {
      setPendingRemoveImageIcon(false);
    }
    setPreviewImageFailed(false);
  }, [
    clearPendingUploadIcon,
    hasPendingUploadImageIcon,
    hasRemovableImageIcon,
    hasStoredImageIcon,
    isRemovingCustomIcon,
    project,
  ]);

  const handleDiscoverIcon = React.useCallback(async () => {
    if (!project || isDiscoveringIcon) {
      return;
    }

    clearPendingUploadIcon();
    setPendingRemoveImageIcon(false);
    setPreviewImageFailed(false);

    setIsDiscoveringIcon(true);
    try {
      const result = await discoverProjectIcon(project.id);
      if (!result.ok) {
        toast.error(result.error || t('settings.projects.page.toast.discoverIconFailed'));
        return;
      }
      if (result.skipped) {
        toast.success(t('settings.projects.page.toast.customIconAlreadySet'));
        return;
      }
      toast.success(t('settings.projects.page.toast.iconDiscovered'));
    } finally {
      setIsDiscoveringIcon(false);
    }
  }, [clearPendingUploadIcon, discoverProjectIcon, isDiscoveringIcon, project, t]);

  const prepareSaveData = React.useCallback(async (options?: { silent?: boolean }): Promise<ProjectIdentitySaveData | null> => {
    const silent = options?.silent === true;
    if (!project) {
      return null;
    }

    const trimmed = name.trim();
    if (!trimmed) {
      return null;
    }

    if (pendingUploadIconFile) {
      setIsUploadingIcon(true);
      const uploadResult = await uploadProjectIcon(project.id, pendingUploadIconFile);
      setIsUploadingIcon(false);
      if (!uploadResult.ok) {
        toast.error(uploadResult.error || t('settings.projects.page.toast.uploadIconFailed'));
        return null;
      }
      if (!silent) {
        toast.success(t('settings.projects.page.toast.iconUpdated'));
      }
      clearPendingUploadIcon();
      setPendingRemoveImageIcon(false);
    }

    const willRemoveImageIcon = pendingRemoveImageIcon && Boolean(project.iconImage);

    if (willRemoveImageIcon) {
      setIsRemovingCustomIcon(true);
      const removeResult = await removeProjectIcon(project.id);
      setIsRemovingCustomIcon(false);
      if (!removeResult.ok) {
        toast.error(removeResult.error || t('settings.projects.page.toast.removeIconFailed'));
        return null;
      }
      if (!silent) {
        toast.success(t('settings.projects.page.toast.iconRemoved'));
      }
      setPendingRemoveImageIcon(false);
      setIconBackground(null);
    }

    return {
      label: trimmed,
      icon,
      color,
      iconBackground: normalizeProjectIconBackground(willRemoveImageIcon ? null : iconBackground),
      defaultModel: defaultModel ?? null,
    };
  }, [
    clearPendingUploadIcon,
    color,
    defaultModel,
    icon,
    iconBackground,
    name,
    pendingRemoveImageIcon,
    pendingUploadIconFile,
    project,
    removeProjectIcon,
    t,
    uploadProjectIcon,
  ]);

  React.useEffect(() => {
    setPreviewImageFailed(false);
  }, [projectId, currentIconImage?.updatedAt]);

  return {
    name,
    setName,
    icon,
    setIcon,
    color,
    setColor,
    iconBackground,
    setIconBackground,
    defaultModel,
    parsedDefaultModel,
    handleDefaultModelChange,
    isUploadingIcon,
    isRemovingCustomIcon,
    isDiscoveringIcon,
    pendingRemoveImageIcon,
    setPendingRemoveImageIcon,
    pendingUploadIconFile,
    pendingUploadIconPreviewUrl,
    previewImageFailed,
    setPreviewImageFailed,
    hasStoredImageIcon,
    hasPendingUploadImageIcon,
    hasCustomIcon,
    effectiveHasImageIcon,
    hasRemovableImageIcon,
    showStoredImagePreview,
    showImagePreview,
    fileInputRef,
    clearPendingUploadIcon,
    handleUploadIcon,
    handleRemoveImageIcon,
    handleDiscoverIcon,
    hasChanges,
    prepareSaveData,
    currentIconImage,
    project,
  };
};
