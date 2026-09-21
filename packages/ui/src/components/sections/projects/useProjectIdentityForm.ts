import React from 'react';
import { toast } from '@/components/ui';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import { useProjectsStore } from '@/stores/useProjectsStore';

const HEX_COLOR_PATTERN = /^#(?:[\da-fA-F]{3}|[\da-fA-F]{6})$/;

const normalizeProjectIconBackground = (value: string | null | undefined): string | null => {
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
  defaultAgent: string | null;
  defaultModel: string | null;
  defaultVariant: string | null;
};

type EditableProject = Pick<
  ProjectEntry,
  'id' | 'label' | 'icon' | 'color' | 'iconBackground' | 'defaultAgent' | 'defaultModel' | 'defaultVariant' | 'iconImage' | 'path'
>;

/** The editable identity fields, in the shape the form state holds them. */
type ProjectIdentity = {
  label: string;
  icon: string | null;
  color: string | null;
  iconBackground: string | null;
  defaultAgent: string | undefined;
  defaultModel: string | undefined;
  defaultVariant: string | undefined;
};

const EMPTY_IDENTITY: ProjectIdentity = { label: '', icon: null, color: null, iconBackground: null, defaultAgent: undefined, defaultModel: undefined, defaultVariant: undefined };

const identityOf = (project: EditableProject): ProjectIdentity => ({
  label: project.label ?? '',
  icon: project.icon ?? null,
  color: project.color ?? null,
  iconBackground: project.iconBackground ?? null,
  defaultAgent: project.defaultAgent,
  defaultModel: project.defaultModel,
  defaultVariant: project.defaultVariant,
});

const sameIdentity = (left: ProjectIdentity, right: ProjectIdentity): boolean => (
  left.label === right.label
  && left.icon === right.icon
  && left.color === right.color
  && left.iconBackground === right.iconBackground
  && left.defaultAgent === right.defaultAgent
  && left.defaultModel === right.defaultModel
  && left.defaultVariant === right.defaultVariant
);

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
  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>(undefined);
  const [defaultModel, setDefaultModel] = React.useState<string | undefined>(undefined);
  const [defaultVariant, setDefaultVariant] = React.useState<string | undefined>(undefined);
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

  // What the form shows versus what the store holds. The form follows the
  // store only while it still matches what it was last seeded with; a form
  // the user has changed keeps their text. The store hands out a fresh
  // project object on every settings round trip, including the echo of this
  // form's own auto-save, and re-seeding on each of those wiped the name
  // mid-typing (#3552).
  const formIdentityRef = React.useRef<ProjectIdentity>(EMPTY_IDENTITY);
  formIdentityRef.current = { label: name, icon, color, iconBackground, defaultAgent, defaultModel, defaultVariant };
  const seededRef = React.useRef<{ projectId: string | null; identity: ProjectIdentity }>({ projectId: null, identity: EMPTY_IDENTITY });

  React.useEffect(() => {
    if (!project) {
      seededRef.current = { projectId: null, identity: EMPTY_IDENTITY };
      setName('');
      setIcon(null);
      setColor(null);
      setIconBackground(null);
      setDefaultAgent(undefined);
      setDefaultModel(undefined);
      setDefaultVariant(undefined);
      return;
    }
    const incoming = identityOf(project);
    const seeded = seededRef.current;
    const switchedProject = seeded.projectId !== project.id;
    if (!switchedProject) {
      if (sameIdentity(formIdentityRef.current, incoming)) {
        // The store caught up with the form (a save landed): new baseline.
        seededRef.current = { projectId: project.id, identity: incoming };
        return;
      }
      if (!sameIdentity(formIdentityRef.current, seeded.identity)) {
        // The user is editing; an external change does not overwrite them.
        return;
      }
    }
    seededRef.current = { projectId: project.id, identity: incoming };
    setName(incoming.label);
    setIcon(incoming.icon);
    setColor(incoming.color);
    setIconBackground(incoming.iconBackground);
    setDefaultAgent(incoming.defaultAgent);
    setDefaultModel(incoming.defaultModel);
    setDefaultVariant(incoming.defaultVariant);
    if (switchedProject) {
      setPendingRemoveImageIcon(false);
      clearPendingUploadIcon();
      setPreviewImageFailed(false);
    }
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
    || (defaultAgent ?? undefined) !== (project?.defaultAgent ?? undefined)
    || (defaultModel ?? undefined) !== (project?.defaultModel ?? undefined)
    || (defaultVariant ?? undefined) !== (project?.defaultVariant ?? undefined)
    || pendingRemoveImageIcon
    || Boolean(pendingUploadIconFile)
  );

  const handleDefaultModelChange = React.useCallback((providerId: string, modelId: string) => {
    setDefaultModel(providerId && modelId ? `${providerId}/${modelId}` : undefined);
    // Variants belong to a model. Carrying the old one over would pin a name
    // the new model may not have.
    setDefaultVariant(undefined);
  }, []);

  const handleDefaultVariantChange = React.useCallback((variant: string | undefined) => {
    setDefaultVariant(variant);
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
      defaultAgent: defaultAgent ?? null,
      defaultModel: defaultModel ?? null,
      defaultVariant: defaultModel ? defaultVariant ?? null : null,
    };
  }, [
    clearPendingUploadIcon,
    color,
    defaultAgent,
    defaultModel,
    defaultVariant,
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
    projectId,
    name,
    setName,
    icon,
    setIcon,
    color,
    setColor,
    iconBackground,
    setIconBackground,
    defaultAgent,
    setDefaultAgent,
    defaultModel,
    defaultVariant,
    parsedDefaultModel,
    handleDefaultModelChange,
    handleDefaultVariantChange,
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
