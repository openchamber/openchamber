import type { DirectoryPermissionRequest, PermissionsAPI, StartAccessingResult } from '@openchamber/ui/lib/api/types';

export const createVSCodePermissionsAPI = (): PermissionsAPI => ({
  async requestDirectoryAccess(request: DirectoryPermissionRequest) {
    // VS Code handles permissions via workspace
    return { success: true, path: request.path };
  },
  async startAccessingDirectory(path: string): Promise<StartAccessingResult> {
    void path;
    return { success: true };
  },
  async stopAccessingDirectory(path: string): Promise<StartAccessingResult> {
    void path;
    return { success: true };
  },
});
