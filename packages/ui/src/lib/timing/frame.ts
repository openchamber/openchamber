export const createFrameScheduler = (run: () => void) => {
    let frame = 0;
    return {
        schedule: () => {
            if (frame) {
                return;
            }
            frame = window.requestAnimationFrame(() => {
                frame = 0;
                run();
            });
        },
        cancel: () => {
            if (!frame) {
                return;
            }
            window.cancelAnimationFrame(frame);
            frame = 0;
        },
    };
};
