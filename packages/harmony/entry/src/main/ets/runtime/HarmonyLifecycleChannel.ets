type HarmonyLifecycleListener = (active: boolean) => void;

class HarmonyLifecycleChannel {
  private active: boolean = true;
  private listeners: HarmonyLifecycleListener[] = [];

  setActive(active: boolean): void {
    if (this.active === active) {
      return;
    }
    this.active = active;
    for (const listener of this.listeners) {
      listener(active);
    }
  }

  subscribe(listener: HarmonyLifecycleListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }
}

export const harmonyLifecycleChannel: HarmonyLifecycleChannel = new HarmonyLifecycleChannel();
