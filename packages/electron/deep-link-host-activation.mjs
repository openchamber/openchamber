// Starts the host switch requested by an openchamber://host/<id> deep link.
//
// The dispatch is fire-and-forget, but the switch itself awaits window
// navigation, and navigateWindow rethrows non-benign loadURL failures. Left
// unobserved, that rejection is unhandled in the main process, where Node's
// default behavior raises it as an uncaught exception and can terminate the
// app. Route the rejection to the caller's reporter instead, and guard the
// reporter so a failing log call cannot re-arm the rejection.
export const startDeepLinkHostActivation = (activate, reportFailure) => {
  void Promise.resolve()
    .then(activate)
    .catch((error) => {
      try {
        reportFailure(error);
      } catch {
        // Reporting must never turn a handled failure back into an
        // unhandled rejection.
      }
    });
};
