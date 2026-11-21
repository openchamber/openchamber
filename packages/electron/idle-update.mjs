const IDLE_UPDATE_COUNTDOWN_MS = 30_000;
const IDLE_UPDATE_POLL_MS = 2_000;

const idleFailure = { state: 'unknown', reason: 'unreadable' };

export const createIdleUpdateQueue = ({
  readIdle,
  onChange,
  openCountdown,
  updateCountdown,
  closeCountdown,
  install,
  countdownMs = IDLE_UPDATE_COUNTDOWN_MS,
  pollMs = IDLE_UPDATE_POLL_MS,
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
  let restartRequest = null;
  let suspended = false;
  let stopped = false;

  const snapshot = () => ({
    phase,
    reason,
    remainingMs,
    version: queued?.version ?? null,
    channel: queued?.channel ?? null,
  });

  const emit = () => {
    onChange?.(snapshot());
  };

  const later = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };

  const clearPoll = () => {
    if (pollTimer === null) return;
    clearTimer(pollTimer);
    pollTimer = null;
  };

  const clearCount = () => {
    if (countTimer === null) return;
    clearTimer(countTimer);
    countTimer = null;
  };

  const schedulePoll = (gen) => {
    clearPoll();
    pollTimer = setTimer(() => {
      void later(() => tick(gen));
    }, pollMs);
  };

  const scheduleCount = (gen) => {
    clearCount();
    const step = Math.min(1_000, remainingMs);
    countTimer = setTimer(() => {
      void later(() => onSecond(gen, step));
    }, step);
  };

  const read = async () => {
    try {
      const status = await readIdle();
      if (status?.state === 'idle' || status?.state === 'busy' || status?.state === 'unknown') return status;
    } catch {
    }
    return idleFailure;
  };

  const becomeWaiting = (gen, nextReason) => {
    clearCount();
    if (phase === 'counting') closeCountdown();
    phase = 'waiting';
    reason = nextReason || 'unreadable';
    remainingMs = 0;
    emit();
    schedulePoll(gen);
  };

  const tick = async (gen) => {
    if (gen !== generation || suspended || !queued || phase === 'installing') return;
    const status = await read();
    if (gen !== generation || !queued || phase === 'installing') return;
    if (status.state !== 'idle') {
      becomeWaiting(gen, status.reason);
      return;
    }
    reason = null;
    if (phase !== 'counting') {
      phase = 'counting';
      remainingMs = countdownMs;
      openCountdown(snapshot());
      emit();
      scheduleCount(gen);
    }
    schedulePoll(gen);
  };

  const startInstall = () => {
    if (installPromise) return installPromise;
    generation += 1;
    clearPoll();
    clearCount();
    if (phase === 'counting') closeCountdown();
    queued = null;
    phase = 'installing';
    reason = null;
    remainingMs = 0;
    emit();
    installPromise = Promise.resolve()
      .then(() => install())
      .then(() => {
        phase = 'idle';
        emit();
      })
      .catch((error) => {
        phase = 'idle';
        reason = 'install-failed';
        remainingMs = 0;
        emit();
        throw error;
      })
      .finally(() => {
        installPromise = null;
      });
    return installPromise;
  };

  const onSecond = async (gen, step) => {
    if (gen !== generation || phase !== 'counting') return;
    remainingMs = Math.max(0, remainingMs - step);
    if (remainingMs > 0) {
      updateCountdown(snapshot());
      emit();
      scheduleCount(gen);
      return;
    }
    const status = await read();
    if (gen !== generation || !queued) return;
    if (status.state !== 'idle') {
      becomeWaiting(gen, status.reason);
      return;
    }
    await startInstall();
  };

  const drop = (gen) => {
    clearPoll();
    clearCount();
    if (phase === 'counting') closeCountdown();
    queued = null;
    phase = 'idle';
    reason = null;
    remainingMs = 0;
    generation = gen;
    emit();
  };

  const queue = (release) => later(async () => {
    if (stopped || phase === 'installing') return snapshot();
    const version = typeof release?.version === 'string' ? release.version : '';
    const channel = typeof release?.channel === 'string' ? release.channel : '';
    if (!version || !channel) throw new Error('No downloaded update');
    if (queued?.version === version && queued?.channel === channel && (phase === 'waiting' || phase === 'counting')) {
      return snapshot();
    }
    generation += 1;
    const gen = generation;
    clearPoll();
    clearCount();
    if (phase === 'counting') closeCountdown();
    queued = { version, channel };
    phase = 'waiting';
    reason = null;
    remainingMs = 0;
    emit();
    await tick(gen);
    return snapshot();
  });

  const cancel = () => {
    generation += 1;
    return later(() => {
      if (phase !== 'installing') drop(generation + 1);
      return snapshot();
    });
  };

  const resetCountdown = (nextSuspended) => {
    suspended = nextSuspended;
    const gen = ++generation;
    return later(async () => {
      if (gen !== generation || !queued || phase === 'installing') return snapshot();
      becomeWaiting(gen, 'unreadable');
      if (!suspended) await tick(gen);
      return snapshot();
    });
  };

  const matchesRelease = (release) => release?.version === queued?.version && release?.channel === queued?.channel;
  const noteRelease = (release) => {
    if (queued && !matchesRelease(release)) generation += 1;
    return later(() => {
      if (queued && !matchesRelease(release)) drop(generation + 1);
      return snapshot();
    });
  };

  const beginInstall = () => {
    if (installPromise) return installPromise;
    if (restartRequest) return restartRequest;
    generation += 1;
    restartRequest = later(() => {
      if (stopped) throw new Error('OpenChamber is quitting');
      return startInstall();
    }).finally(() => {
      restartRequest = null;
    });
    return restartRequest;
  };

  const stop = () => {
    stopped = true;
    return cancel();
  };

  return {
    queue,
    cancel,
    noteSuspend: () => resetCountdown(true),
    noteResume: () => resetCountdown(false),
    noteRelease,
    beginInstall,
    stop,
    snapshot,
    settled: () => chain,
  };
};
