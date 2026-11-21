export const createIdleUpdateQueue = ({
  readIdle,
  onChange,
  openCountdown,
  updateCountdown,
  closeCountdown,
  install,
  countdownMs = 30_000,
  pollMs = 2_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  let generation = 0;
  let queued = null;
  let phase = 'idle';
  let reason = null;
  let remainingMs = 0;
  let pollTimer = null;
  let countTimer = null;
  let chain = Promise.resolve();
  let installPromise = null;
  let suspended = false;
  let stopped = false;

  const snapshot = () => ({
    phase,
    reason,
    remainingMs,
    version: queued?.version ?? null,
    channel: queued?.channel ?? null,
  });

  const emit = () => onChange?.(snapshot());

  const later = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {});
    return run;
  };

  const transition = (next, release = null) => {
    generation += 1;
    clearTimer(pollTimer);
    clearTimer(countTimer);
    if (phase === 'counting') closeCountdown();
    queued = release;
    phase = next;
    reason = null;
    remainingMs = 0;
    emit();
  };

  const scheduleCount = (gen) => {
    const step = Math.min(1_000, remainingMs);
    countTimer = setTimer(() => later(() => {
      if (gen !== generation) return;
      remainingMs -= step;
      if (!remainingMs) return checkIdle(gen, true);
      updateCountdown(snapshot());
      emit();
      scheduleCount(gen);
    }), step);
  };

  const checkIdle = async (gen, final = false) => {
    if (gen !== generation || suspended) return;
    let idle = false;
    try { idle = (await readIdle())?.state === 'idle'; } catch {}
    if (gen !== generation) return;
    if (!idle) {
      transition('waiting', queued);
    } else if (final) {
      return beginInstall();
    } else if (phase !== 'counting') {
      phase = 'counting';
      remainingMs = countdownMs;
      openCountdown(snapshot());
      emit();
      scheduleCount(gen);
    }
    const current = generation;
    pollTimer = setTimer(() => later(() => checkIdle(current)), pollMs);
  };

  const beginInstall = () => {
    if (installPromise) return installPromise;
    if (stopped) return Promise.reject(new Error('OpenChamber is quitting'));
    transition('installing');
    installPromise = Promise.resolve().then(() => {
      if (stopped) throw new Error('OpenChamber is quitting');
      return install();
    }).catch((error) => {
      reason = 'install-failed';
      throw error;
    }).finally(() => {
      phase = 'idle';
      installPromise = null;
      emit();
    });
    return installPromise;
  };

  const cancel = () => {
    if (phase !== 'installing') transition('idle');
    return snapshot();
  };

  const checkCurrent = () => {
    const gen = generation;
    return later(() => checkIdle(gen)).then(snapshot);
  };
  const resetCountdown = (nextSuspended) => {
    suspended = nextSuspended;
    if (!queued) return snapshot();
    transition('waiting', queued);
    return suspended ? snapshot() : checkCurrent();
  };

  const matchesRelease = (release) => release?.version === queued?.version && release?.channel === queued?.channel;
  return {
    queue: async (release) => {
      if (stopped || phase === 'installing') return snapshot();
      const { version, channel } = release ?? {};
      if (typeof version !== 'string' || !version || typeof channel !== 'string' || !channel) throw new Error('No downloaded update');
      if (matchesRelease(release)) return snapshot();
      transition('waiting', { version, channel });
      return checkCurrent();
    },
    cancel,
    noteSuspend: () => resetCountdown(true),
    noteResume: () => resetCountdown(false),
    noteRelease: (release) => queued && !matchesRelease(release) ? cancel() : snapshot(),
    beginInstall,
    stop: () => { stopped = true; return cancel(); },
    snapshot,
    settled: () => chain,
  };
};
