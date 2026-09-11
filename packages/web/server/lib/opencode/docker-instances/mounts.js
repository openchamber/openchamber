/**
 * Mount plan builder for OpenChamber-managed Docker OpenCode instances.
 *
 * Pure function: same inputs always produce the same mount list, which makes
 * the security audit trivial — a container receives exactly the mounts below
 * and nothing else:
 *
 * | mount       | host source                          | container path                            | mode | default |
 * |-------------|--------------------------------------|-------------------------------------------|------|---------|
 * | workspace   | user-selected project directory      | `/workspace` (the mapping target)         | rw   | always  |
 * | skills      | shared skills dir (default: host SKILL_DIR) | `/home/opencode/.config/opencode/skills` | rw | opt-in |
 * | config      | host OpenCode config dir             | `/home/opencode/.config/opencode`         | rw   | opt-in  |
 * | credentials | host OpenCode auth.json              | `/home/opencode/.local/share/opencode/auth.json` | ro | separate opt-in, off |
 *
 * Nothing else is ever mounted: no Docker socket, no SSH keys, no git
 * credentials. The nested skills mount (child of the config mount) is
 * intentional — the more-specific bind shadows the parent so both stay
 * writable in both directions when the user opts into sharing.
 */

const CONTAINER_HOME = '/home/opencode';
const CONTAINER_CONFIG_DIR = `${CONTAINER_HOME}/.config/opencode`;
const CONTAINER_SKILLS_DIR = `${CONTAINER_CONFIG_DIR}/skills`;
const CONTAINER_AUTH_FILE = `${CONTAINER_HOME}/.local/share/opencode/auth.json`;

const isForbiddenHostPath = (hostPath) => {
  const normalized = String(hostPath).replaceAll('\\', '/').toLowerCase();
  if (normalized.endsWith('docker.sock')) return true;
  if (normalized.includes('/.ssh/') || normalized.endsWith('/.ssh')) return true;
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base === 'id_rsa' || base === 'id_ed25519' || base === '.git-credentials' || base === '.netrc';
};

/**
 * @param {object} params
 * @param {{ workspaceHostPath: string, workspaceContainerPath: string, sharing: { config: boolean, skills: boolean, credentials: boolean, skillsHostDir?: string|null } }} params.instance
 * @param {{ openCodeConfigDir: string, skillDir: string, authFile: string }} params.paths - host paths resolved at wiring time.
 * @returns {Array<{ host: string, container: string, mode: 'rw'|'ro' }>}
 */
export const buildInstanceMounts = ({ instance, paths }) => {
  const mounts = [];
  const workspaceHostPath = String(instance.workspaceHostPath ?? '').trim();
  if (!workspaceHostPath) {
    throw new Error('Instance is missing a workspace host path');
  }

  for (const candidate of [workspaceHostPath, instance.sharing?.skillsHostDir, paths.openCodeConfigDir, paths.skillDir, paths.authFile]) {
    if (candidate && isForbiddenHostPath(candidate)) {
      throw new Error(`Refusing to mount forbidden host path: ${candidate}`);
    }
  }

  mounts.push({
    host: workspaceHostPath,
    container: instance.workspaceContainerPath || '/workspace',
    mode: 'rw',
  });

  if (instance.sharing?.skills === true) {
    mounts.push({
      host: instance.sharing.skillsHostDir || paths.skillDir,
      container: CONTAINER_SKILLS_DIR,
      mode: 'rw',
    });
  }

  if (instance.sharing?.config === true) {
    // Two-way by explicit user choice (approved risk): config changes made
    // inside the container propagate to the host and vice versa.
    mounts.push({
      host: paths.openCodeConfigDir,
      container: CONTAINER_CONFIG_DIR,
      mode: 'rw',
    });
  }

  if (instance.sharing?.credentials === true) {
    mounts.push({
      host: paths.authFile,
      container: CONTAINER_AUTH_FILE,
      mode: 'ro',
    });
  }

  return mounts;
};

export const CONTAINER_OPENCODE_PORT = 4096;
