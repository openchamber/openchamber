// Runs a command as its own responsible process.
//
// macOS attributes privacy decisions (Local Network among them) to the
// responsible process: for anything OpenChamber starts, that is OpenChamber.
// macOS never asks the user about OpenChamber, so its terminals and the
// managed OpenCode server are refused the local network without a prompt
// (#4191). Disclaiming responsibility makes the command answer for itself, the
// way a command started by launchd or by Claude's `disclaimer` helper does.
//
// POSIX_SPAWN_SETEXEC replaces this process instead of forking, so the command
// keeps this pid, process group, controlling terminal and file descriptors.
#include <spawn.h>
#include <stdio.h>
#include <string.h>

extern char **environ;

// libsystem, not in the public SDK headers.
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: disclaim command [argument ...]\n");
    return 64;
  }
  posix_spawnattr_t attrs;
  posix_spawnattr_init(&attrs);
  responsibility_spawnattrs_setdisclaim(&attrs, 1);
  posix_spawnattr_setflags(&attrs, POSIX_SPAWN_SETEXEC);
  int error = posix_spawnp(NULL, argv[1], NULL, &attrs, argv + 1, environ);
  fprintf(stderr, "disclaim: %s: %s\n", argv[1], strerror(error));
  return 127;
}
