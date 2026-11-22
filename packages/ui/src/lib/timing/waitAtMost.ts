export const waitAtMost = async (timeoutMs: number, work: Promise<unknown>): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); });
  try {
    await Promise.race([work.then(() => undefined, () => undefined), deadline]);
  } finally {
    clearTimeout(timer);
  }
};
