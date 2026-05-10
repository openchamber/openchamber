import type { DirectoryPermissionRequest, PermissionsAPI, StartAccessingResult } from '@alias-ade/ui/lib/api/types';

export const createWebPermissionsAPI = (): PermissionsAPI => ({
  async requestDirectoryAccess(request: DirectoryPermissionRequest) {
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
