export function createBrowserGlobalStubScope() {
  const originalDescriptors = new Map();

  const install = (property, value) => {
    if (!originalDescriptors.has(property)) {
      originalDescriptors.set(property, Object.getOwnPropertyDescriptor(globalThis, property));
    }
    Object.defineProperty(globalThis, property, {
      configurable: true,
      writable: true,
      value,
    });
  };

  const restore = () => {
    for (const [property, descriptor] of originalDescriptors) {
      if (descriptor) {
        Object.defineProperty(globalThis, property, descriptor);
      } else {
        delete globalThis[property];
      }
    }
    originalDescriptors.clear();
  };

  return { install, restore };
}
