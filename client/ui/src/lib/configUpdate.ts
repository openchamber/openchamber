const DEFAULT_MESSAGE = "Updating OpenCode configuration...";

type ConfigUpdateListener = (state: {
  isUpdating: boolean;
  message: string;
}) => void;

let pendingCount = 0;
let currentMessage = DEFAULT_MESSAGE;
const listeners = new Set<ConfigUpdateListener>();

function notify() {
  const snapshot = {
    isUpdating: pendingCount > 0,
    message: currentMessage,
  };
  listeners.forEach((listener) => listener(snapshot));
}

export function startConfigUpdate(message?: string) {
  pendingCount += 1;
  if (pendingCount === 1) {
    currentMessage = message || DEFAULT_MESSAGE;
    notify();
  } else if (message) {
    currentMessage = message;
    notify();
  }
}

export function finishConfigUpdate() {
  if (pendingCount === 0) {
    return;
  }

  pendingCount -= 1;
  if (pendingCount === 0) {
    currentMessage = DEFAULT_MESSAGE;
    notify();
  }
}

export function updateConfigUpdateMessage(message: string) {
  if (currentMessage === message && pendingCount > 0) {
    return;
  }
  currentMessage = message;
  if (pendingCount > 0) {
    notify();
  }
}

export function subscribeConfigUpdate(listener: ConfigUpdateListener) {
  listeners.add(listener);
  listener({
    isUpdating: pendingCount > 0,
    message: currentMessage,
  });
  return () => {
    listeners.delete(listener);
  };
}

export function getConfigUpdateSnapshot() {
  return {
    isUpdating: pendingCount > 0,
    message: currentMessage,
  };
}
