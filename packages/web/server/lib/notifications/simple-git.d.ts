import 'simple-git';

declare module 'simple-git' {
  interface SimpleGitOptions {
    spawnOptions: Partial<Pick<import('node:child_process').SpawnOptions, 'uid' | 'gid' | 'windowsHide'>>;
  }
}
