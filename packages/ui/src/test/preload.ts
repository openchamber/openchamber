// happy-dom implements Element.getAnimations(), so Base UI waits for open and
// close animations through MutationObserver and animation frames, which most
// suites do not install. Nothing animates in happy-dom; this flag is Base UI's
// switch for test environments and takes the same path happy-dom 18 took.
Object.assign(globalThis, { BASE_UI_ANIMATIONS_DISABLED: true });
