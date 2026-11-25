interface SessionWorkSettingsDocument {
  sessionWorkEnabled?: unknown;
  sessionWorkIncludesPinned?: unknown;
}

export const readWorkSettings = (settings: SessionWorkSettingsDocument | null | undefined) => ({
  enabled: settings?.sessionWorkEnabled !== false,
  pinnedInWork: settings?.sessionWorkIncludesPinned === true,
});
