import { GUEST_PROJECT_ICON_MAX_BYTES, type GuestProjectIcon } from '@openchamber/sdk';

import { PROJECT_ICON_MAP, resolveProjectColor } from '@/lib/projectMeta';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { guestProject } from '@/lib/guests/workspace';
import { toDataUrl } from '@/lib/guests/relay-document';

type ProjectIconTheme = 'light' | 'dark';

export type GuestProjectIconOptions = {
  themeVariant?: ProjectIconTheme;
  iconColor?: string;
};

/**
 * The icon the sidebar draws for a registered project. A custom image is fetched
 * through the same themed route the sidebar uses and returned as a data URL; a
 * project without one, or an image too large to send, falls back to the preset
 * symbol and colour.
 */
export const readGuestProjectIcon = async (
  projectId: string,
  options: GuestProjectIconOptions = {},
): Promise<GuestProjectIcon> => {
  const project = guestProject(projectId);
  const preset = project.icon && PROJECT_ICON_MAP[project.icon] ? project.icon : 'folder';
  const fallback: GuestProjectIcon = {
    kind: 'symbol',
    symbol: preset,
    color: resolveProjectColor(project.color),
  };
  if (!project.iconImage) return fallback;

  const query = new URLSearchParams({ v: String(project.iconImage.updatedAt) });
  if (options.themeVariant) query.set('theme', options.themeVariant);
  if (options.iconColor) query.set('iconColor', options.iconColor);

  try {
    const response = await runtimeFetch(`/api/projects/${encodeURIComponent(project.id)}/icon`, {
      method: 'GET',
      headers: { Accept: 'image/*' },
      query,
    });
    if (!response.ok) return fallback;
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > GUEST_PROJECT_ICON_MAX_BYTES) return fallback;
    const mime = (blob.type || project.iconImage.mime || 'application/octet-stream').split(';')[0].trim();
    if (!mime) return fallback;
    return {
      kind: 'image',
      mime,
      dataUrl: await toDataUrl(blob),
      background: project.iconBackground ?? null,
    };
  } catch {
    return fallback;
  }
};
