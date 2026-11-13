import { InspectorError } from './inspector.js';
import { cssSize } from './viewports.js';

const DEFAULT_MAX_SCOPES = 4;
const DEFAULT_IDLE_MS = 5 * 60_000;
const IDLE_SWEEP_INTERVAL_MS = 60_000;
// A scope can make room for a new one after this long without activity.
const EVICTABLE_AFTER_MS = 60_000;

const scopeId = ({ directory, sessionId }) => JSON.stringify([directory, sessionId]);
const HELP_TIMEOUT_DEFAULT_S = 300;
const LOGIN_NOT_SAVED_NOTE = 'This chat\'s browser does not run on a saved profile, so the login was not saved anywhere: it lasts only as long as this chat\'s browser. To keep logins across chats, the user binds this project to a profile on the Server Browser page; a chat browser opened after that uses it.';
// A dock opens a profile for signing in under this pseudo-project; agents
// never send it, because the host fills their context from the chat.
const SIGN_IN_PREFIX = 'profile:';
const SIGN_IN_SESSION = 'sign-in';

const knownScope = (context) => (
  context
  && typeof context.directory === 'string'
  && context.directory.length > 0
  && typeof context.sessionId === 'string'
  && context.sessionId.length > 0
);

// `profiles` is the profile store. A chat whose project is bound to a profile
// browses on its own copy of it, so chats never share a live cookie jar. A
// copy goes back into the profile only when the agent saves it
// (browser.saveProfile) or, for the profile's sign-in browser, when it
// closes. Saves run one at a time, and a copy taken before another save is
// refused rather than allowed to drop that save.
export const createBrowserManager = ({
  createRuntime,
  profiles = null,
  chromeStatus = () => ({ status: 'ready', message: '' }),
  maxScopes = DEFAULT_MAX_SCOPES,
  idleMs = DEFAULT_IDLE_MS,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  if (typeof createRuntime !== 'function') throw new Error('createBrowserManager requires a runtime factory');
  if (!Number.isInteger(maxScopes) || maxScopes < 1) throw new Error('maxScopes must be a positive integer');

  const scopes = new Map();
  let selectedScopeId = null;
  let controller = 'none';
  // The scope the agent last worked in. The host holds the picture for the
  // agent a while after each action; only that scope's page is the agent's.
  let agentScopeId = null;
  // The viewer holding control, from the host's control notices and its input.
  let controllingViewer = null;
  let operationQueue = Promise.resolve();
  let frameState = null;
  let frameSequence = 0;
  let viewGeneration = 0;
  // Frame and sound requests waiting on the selected scope; a switch cancels them.
  const frameControllers = new Set();
  // Where the host's sound requests stand in one browser's packets, and our
  // own numbering of the answers across browsers. Kept per runtime, not per
  // scope: a browser reopened under the same scope (a saved profile, a
  // crash) numbers its packets from the start again.
  let audioCursor = null;
  let audioSequence = 0;
  const selectionWaiters = new Set();
  // The host reports the panel in device pixels when its CSS size changes; the
  // dock reports the ratio. Pages keep the CSS size worked out when the host
  // measured, so a ratio change alone (a window moving to another display)
  // does not shrink them. Only a panel measured before the first ratio report
  // is worked out again when that report arrives.
  let surfaceViewport = null;
  let surfaceSize = null;
  let devicePixelRatio = null;
  let viewerTheme = null;
  let closed = false;
  let notice = null;
  // What the agent asked the person to do, while it waits for them.
  let help = null;
  const controlWaiters = new Set();
  const notifyControl = () => {
    for (const waiter of controlWaiters) waiter();
  };

  const enqueue = (operation) => {
    const pending = operationQueue.catch(() => {}).then(operation);
    operationQueue = pending;
    return pending;
  };

  // Agent actions, dock commands, input, and a viewer's frame requests keep a
  // scope alive; the idle sweep and the scope bound look at this.
  const touch = (entry) => {
    if (entry) entry.lastActivityAt = now();
  };

  const selected = () => selectedScopeId ? scopes.get(selectedScopeId) ?? null : null;

  // Viewers act on the picture they last drew, named by our frame sequence. A
  // view is the visible scope and its active tab; input or a dock command made
  // on a frame of an earlier view is refused so it cannot land in this one.
  let view = { key: null, firstSequence: 1 };
  const observeView = () => {
    const entry = selected();
    const key = entry ? JSON.stringify([entry.id, entry.runtime.tabs?.find((tab) => tab.active)?.id ?? null]) : null;
    if (key !== view.key) view = { key, firstSequence: frameSequence + 1 };
  };
  const shownEarlierView = (frameSeq) => {
    observeView();
    // 0 means the viewer has drawn nothing yet, so it acted on no picture.
    return Number.isInteger(frameSeq) && frameSeq > 0 && frameSeq < view.firstSequence;
  };

  const finishSelectionWaiter = (waiter, error = null) => {
    if (!selectionWaiters.delete(waiter)) return;
    clearTimeout(waiter.timer);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    if (error) waiter.reject(error);
    else waiter.resolve(null);
  };

  const select = (entry) => {
    if (selectedScopeId === entry.id) return;
    for (const pending of frameControllers) pending.abort();
    selectedScopeId = entry.id;
    frameState = null;
    viewGeneration += 1;
    for (const waiter of selectionWaiters) finishSelectionWaiter(waiter);
  };

  const isSignIn = (entry) => entry.directory.startsWith(SIGN_IN_PREFIX);
  // The last version each profile was saved at by this service, so a chat
  // waiting for someone to sign in knows when they saved.
  const savedVersions = new Map();
  const noteSaved = (profileId, version) => {
    if (Number.isInteger(version)) savedVersions.set(profileId, version);
    notifyControl();
  };

  // A sign-in browser is the profile being edited by hand, so it is saved
  // when it closes; an agent's copy is saved only on request.
  const removeScope = (entry, { save = isSignIn(entry) } = {}) => {
    scopes.delete(entry.id);
    notifyControl();
    if (selectedScopeId === entry.id) {
      for (const pending of frameControllers) pending.abort();
      selectedScopeId = null;
      frameState = null;
      viewGeneration += 1;
    }
    return Promise.resolve(entry.runtime.close({ save })).then((version) => {
      if (save && entry.profile) noteSaved(entry.profile.id, version);
      return version;
    });
  };

  // Closing a browser in the background: a sign-in browser that cannot be
  // saved says so in the dock instead of failing the work that closed it.
  const dropScope = (entry) => removeScope(entry).catch((error) => {
    notice = {
      directory: entry.directory,
      sessionId: entry.sessionId,
      message: `The browser profile "${entry.profile?.name ?? ''}" could not be saved: ${error instanceof Error ? error.message : error}`,
    };
  });

  // Other browsers on the same profile, so an agent can tell whose changes are whose.
  const profileUsers = (entry) => [...scopes.values()]
    .filter((other) => other !== entry && entry.profile && other.profile?.id === entry.profile.id)
    .map((other) => (isSignIn(other) ? { signIn: true } : { directory: other.directory, sessionId: other.sessionId }));

  const makeRoom = async () => {
    if (scopes.size >= maxScopes) {
      const oldest = [...scopes.values()]
        .filter((candidate) => now() - candidate.lastActivityAt >= EVICTABLE_AFTER_MS)
        .reduce((best, candidate) => (!best || candidate.lastActivityAt < best.lastActivityAt ? candidate : best), null);
      if (!oldest) {
        throw new Error(`The browser scope limit (${maxScopes}) is in use by chats active in the last minute; try again shortly`);
      }
      await dropScope(oldest);
      // Shutdown may have begun meanwhile, and it closes only the scopes it saw.
      if (closed) throw new Error('Browser manager is closed');
    }
  };

  const ensureScope = async (context, { profile: requestedProfile } = {}) => {
    if (!knownScope(context)) {
      throw new Error('Browser actions require both project and chat context; this host did not provide them');
    }
    const id = scopeId(context);
    const existing = scopes.get(id);
    if (existing) {
      return existing;
    }
    const signIn = context.directory.startsWith(SIGN_IN_PREFIX);
    if (signIn && !requestedProfile) throw new Error('Open a profile for signing in from the Server Browser page');
    const profile = requestedProfile ?? (profiles ? await profiles.resolve(context.directory) : null);
    await makeRoom();
    const entry = {
      id,
      directory: context.directory,
      sessionId: context.sessionId,
      profile: profile ? { id: profile.id, name: profile.name } : null,
      runtime: createRuntime(context, profile),
      lastActivityAt: now(),
      helpPending: 0,
    };
    scopes.set(id, entry);
    if (notice && scopeId(notice) === id) notice = null;
    entry.runtime.onDead(() => enqueue(async () => {
      if (scopes.get(id) !== entry) return;
      notice = {
        directory: entry.directory,
        sessionId: entry.sessionId,
        message: 'Chrome stopped unexpectedly. The next browser action in this chat starts a new browser.',
      };
      await removeScope(entry, { save: false });
    }).catch(() => {}));
    // A tab switch changes what the dock commands act on, like a scope switch.
    entry.runtime.onTabsChanged(() => {
      if (selectedScopeId === entry.id) viewGeneration += 1;
    });
    if (!selectedScopeId) {
      select(entry);
      // The viewer's panel may have been measured before this scope existed.
      if (surfaceSize) await entry.runtime.surfaceResize(surfaceSize);
    }
    return entry;
  };

  const describeCopy = (entry) => ({
    name: entry.profile.name,
    copyVersion: entry.runtime.profileVersion,
    alsoUsedBy: profileUsers(entry),
  });

  // Starts the chat's browser again on a fresh copy of its profile and
  // reopens its pages, the active one in front.
  const reopen = async (context, pages, wasSelected, signal) => {
    const fresh = await ensureScope(context);
    const ordered = [...pages.filter((page) => page.active), ...pages.filter((page) => !page.active)];
    for (const page of ordered) {
      await fresh.runtime.perform('browser.open', { url: page.url }, signal).catch(() => null);
    }
    if (ordered.length === 0) await fresh.runtime.ensurePage();
    if (wasSelected) {
      if (surfaceSize) await fresh.runtime.surfaceResize(surfaceSize);
      select(fresh);
    }
    touch(fresh);
    return fresh;
  };

  const waitFor = (check, timeoutSeconds, signal) => new Promise((resolve, reject) => {
    let timer = null;
    const finish = (settle) => {
      controlWaiters.delete(waiter);
      if (timer) clearTimer(timer);
      signal?.removeEventListener('abort', onAbort);
      settle();
    };
    const waiter = () => {
      try {
        const result = check();
        if (result) finish(() => resolve(result));
      } catch (error) {
        finish(() => reject(error));
      }
    };
    const onAbort = () => finish(() => reject(signal.reason ?? new DOMException('Browser action was cancelled', 'AbortError')));
    controlWaiters.add(waiter);
    timer = setTimer(() => finish(() => resolve('timeout')), timeoutSeconds * 1000);
    timer?.unref?.();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });

  // A login the chat needs goes into the profile itself: the person signs in
  // on the profile's sign-in browser, opened on the chat's page, and saves
  // it; the chat then continues on a fresh copy. A chat without a profile
  // gets the ordinary hand-over of its own page (null here).
  const signInForHelp = async ({ tabId, reason, timeoutSeconds }, signal, context, startedAt) => {
    const prepared = await enqueue(async () => {
      if (closed) throw new Error('Browser manager is closed');
      if (controller === 'user') throw new Error('The user controls the browser. Wait for them to hand control back.');
      const entry = await ensureScope(context);
      if (!entry.profile) return null;
      const page = entry.runtime.tabs.find((tab) => (tabId === undefined ? tab.active : tab.id === tabId)) ?? null;
      if (tabId !== undefined && !page) {
        throw new Error(`This chat's browser has no tab ${JSON.stringify(String(tabId))}. Use an id from browser.snapshot's tabs.`);
      }
      const profile = await profiles.get(entry.profile.id);
      const signIn = await ensureScope({ directory: `${SIGN_IN_PREFIX}${profile.id}`, sessionId: SIGN_IN_SESSION }, { profile });
      await signIn.runtime.ensurePage();
      // The person signs in on the page the chat was stuck on.
      if (page && /^https?:/.test(page.url)) await signIn.runtime.command('navigate', { url: page.url }).catch(() => null);
      if (surfaceSize) await signIn.runtime.surfaceResize(surfaceSize);
      select(signIn);
      notice = null;
      touch(entry);
      touch(signIn);
      return { entry, signIn, startVersion: await profiles.version(profile.id) };
    });
    if (!prepared) return null;
    const { entry, signIn, startVersion } = prepared;
    entry.helpPending += 1;
    signIn.helpPending += 1;
    help = { scopeId: signIn.id, forScopeId: entry.id, kind: 'login', reason: String(reason ?? ''), tabId: null, since: startedAt };
    try {
      const outcome = await waitFor(() => {
        if ((savedVersions.get(entry.profile.id) ?? startVersion) > startVersion) return 'signed-in';
        if (scopes.get(entry.id) !== entry) throw new Error('This chat\'s browser closed while waiting for the sign-in');
        return null;
      }, timeoutSeconds, signal);
      if (outcome !== 'signed-in') {
        return { outcome, url: entry.runtime.url ?? 'about:blank', title: entry.runtime.title ?? '', waitedSeconds: Math.round((now() - startedAt) / 1000) };
      }
      const fresh = await enqueue(async () => {
        const pages = entry.runtime.tabs.filter((tab) => /^https?:/.test(tab.url)).map((tab) => ({ url: tab.url, active: tab.active }));
        if (scopes.get(entry.id) === entry) await removeScope(entry, { save: false });
        return reopen(context, pages, true, signal);
      });
      const active = fresh.runtime.tabs.find((tab) => tab.active);
      return {
        outcome,
        tabId: active?.id,
        url: fresh.runtime.url ?? 'about:blank',
        title: fresh.runtime.title ?? '',
        waitedSeconds: Math.round((now() - startedAt) / 1000),
      };
    } finally {
      entry.helpPending -= 1;
      signIn.helpPending -= 1;
      if (help?.forScopeId === entry.id) help = null;
    }
  };

  // The person's answer to the profile request on screen: 'approved' or 'declined'.
  let profileAnswer = null;

  // The agent asks to keep this chat's logins in a saved profile: `profileName`
  // is created (or reused, matched case-insensitively) and bound to the
  // chat's project. Nothing changes until the person approves in the Browser
  // panel. Then the chat's cookies move onto a copy of that profile, the copy
  // is saved, and the chat continues on a fresh copy with its tabs.
  const profileForHelp = async ({ reason, timeoutSeconds, profileName }, signal, context, startedAt) => {
    if (!profiles) throw new Error('Saved profiles are not available in this browser service');
    const prepared = await enqueue(async () => {
      if (closed) throw new Error('Browser manager is closed');
      if (controller === 'user') throw new Error('The user controls the browser. Wait for them to hand control back.');
      const entry = await ensureScope(context);
      const name = (profileName ?? entry.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? '').trim();
      if (!name) throw new Error('Name the profile with profileName');
      const existing = (await profiles.list()).find((candidate) => candidate.name.toLowerCase() === name.toLowerCase()) ?? null;
      if (existing && entry.profile?.id === existing.id) return { entry, name: existing.name, already: true };
      await entry.runtime.ensurePage();
      if (surfaceSize) await entry.runtime.surfaceResize(surfaceSize);
      select(entry);
      notice = null;
      touch(entry);
      return { entry, name: existing?.name ?? name, existing, already: false };
    });
    const { entry, name, existing, already } = prepared;
    const waited = () => Math.round((now() - startedAt) / 1000);
    if (already) {
      return { outcome: 'approved', profile: name, profileSaved: false, note: `This chat's browser already runs on the profile "${name}". Call browser.saveProfile to save changes into it.`, url: entry.runtime.url ?? 'about:blank', title: entry.runtime.title ?? '', waitedSeconds: 0 };
    }
    entry.helpPending += 1;
    profileAnswer = null;
    help = { scopeId: entry.id, kind: 'profile', reason: String(reason ?? ''), tabId: null, since: startedAt, profile: { name, exists: Boolean(existing) } };
    let outcome;
    try {
      outcome = await waitFor(() => {
        if (scopes.get(entry.id) !== entry) throw new Error('This chat\'s browser closed while waiting for the profile request');
        return profileAnswer;
      }, timeoutSeconds, signal);
    } finally {
      entry.helpPending -= 1;
      if (help?.scopeId === entry.id && help.kind === 'profile') help = null;
      profileAnswer = null;
    }
    if (outcome !== 'approved') {
      return { outcome, profile: name, profileSaved: false, url: entry.runtime.url ?? 'about:blank', title: entry.runtime.title ?? '', waitedSeconds: waited() };
    }
    return enqueue(async () => {
      if (scopes.get(entry.id) !== entry) throw new Error('This chat\'s browser closed before the profile could be set up');
      const profile = existing ?? await profiles.create(name);
      await profiles.bind(profile.id, entry.directory);
      const cookies = await entry.runtime.exportCookies();
      const pages = entry.runtime.tabs.filter((tab) => /^https?:/.test(tab.url)).map((tab) => ({ url: tab.url, active: tab.active }));
      const wasSelected = selectedScopeId === entry.id;
      await removeScope(entry, { save: false });
      const copy = await ensureScope(context);
      await copy.runtime.importCookies(cookies);
      const version = await removeScope(copy, { save: true });
      const fresh = await reopen(context, pages, wasSelected, signal);
      return {
        outcome: 'approved',
        profile: profile.name,
        profileSaved: version !== null,
        carriedCookies: cookies.length,
        note: `The project is now bound to the profile "${profile.name}" and this chat's ${cookies.length} cookies (its logins) were saved into it. Other chats of this project use it once their browser starts again. Site storage other than cookies (localStorage) was not carried over.`,
        tabs: fresh.runtime.tabs.map(({ id, title, url, active }) => ({ id, title, url, active })),
        url: fresh.runtime.url ?? 'about:blank',
        title: fresh.runtime.title ?? '',
        waitedSeconds: waited(),
      };
    });
  };

  const requireSelected = () => {
    const entry = selected();
    if (!entry) throw new Error('No browser scope is available yet');
    return entry;
  };

  const requireInspectable = () => {
    const entry = selected();
    if (!entry) throw new InspectorError('UNAVAILABLE');
    touch(entry);
    return entry;
  };

  // Dock commands run while nobody holds the picture, or for the viewer that
  // does, and never for a toolbar that acted on a picture of an earlier view.
  // While the agent holds it, the viewer still drives every chat's browser
  // but the agent's own, and may always choose what it looks at (a chat, a
  // tab), which changes the picture and not the page the agent works on, or
  // close a chat's browser, which waits for the running action.
  const requireDockAccess = ({ viewer = null, frameSeq = null } = {}, { agentMayHold = false } = {}) => {
    const agentHolds = controller === 'agent' && !agentMayHold && selectedScopeId === agentScopeId;
    const userHolds = controller === 'user' && !(viewer !== null && viewer === controllingViewer);
    if (agentHolds || userHolds) {
      throw new Error('Dock controls are available only while the shared surface is idle or to the viewer in control');
    }
    if (shownEarlierView(frameSeq)) throw new Error('The browser view changed before the dock command ran');
  };

  // Answering what a page asks (a dialog, a file) is what lets it run again,
  // so it is open to anyone while nobody or the agent holds the picture, and
  // to the viewer in control while a person does.
  const requireAnswerAccess = ({ viewer = null } = {}) => {
    if (controller === 'user' && !(viewer !== null && viewer === controllingViewer)) {
      throw new Error('Dock controls are available only while the shared surface is idle or to the viewer in control');
    }
  };

  const requireGeneration = (expectedGeneration) => {
    if (expectedGeneration !== viewGeneration) {
      throw new Error('The browser view changed before the dock command ran');
    }
  };

  // Puts an open scope in front. The size follows on the queue: the page keeps
  // its own viewport unless it fills the panel, so the first frames are right.
  const showScope = (entry, expectedGeneration, access) => {
    requireDockAccess({ ...access, frameSeq: null }, { agentMayHold: true });
    requireGeneration(expectedGeneration);
    touch(entry);
    if (selectedScopeId === entry.id) return;
    select(entry);
    notice = null;
    if (surfaceSize) {
      void enqueue(() => (scopes.get(entry.id) === entry ? entry.runtime.surfaceResize(surfaceSize) : undefined)).catch(() => {});
    }
  };

  const dockCommand = (name, parameters, expectedGeneration, access) => enqueue(async () => {
    requireDockAccess(access);
    requireGeneration(expectedGeneration);
    const entry = requireSelected();
    touch(entry);
    await entry.runtime.command(name, parameters);
  });

  let sweepTimer = null;
  const sweepIdleScopes = () => enqueue(async () => {
    const cutoff = now() - idleMs;
    await Promise.all([...scopes.values()].filter((entry) => entry.lastActivityAt <= cutoff && entry.helpPending === 0).map(dropScope));
  });
  const scheduleSweep = () => {
    if (closed) return;
    sweepTimer = setTimer(() => {
      sweepTimer = null;
      void sweepIdleScopes().catch(() => {}).finally(scheduleSweep);
    }, IDLE_SWEEP_INTERVAL_MS);
    sweepTimer?.unref?.();
  };
  scheduleSweep();

  return {
    get agentActive() {
      return selected()?.runtime.agentActive === true;
    },
    perform(action, parameters, signal, context) {
      return enqueue(async () => {
        if (closed) throw new Error('Browser manager is closed');
        if (controller === 'user') {
          throw new Error('The user controls the browser. Wait for them to hand control back.');
        }
        const entry = await ensureScope(context);
        touch(entry);
        agentScopeId = entry.id;
        try {
          const data = await entry.runtime.perform(action, parameters, signal);
          return action === 'browser.snapshot' && entry.profile ? { ...data, profile: describeCopy(entry) } : data;
        } finally {
          touch(entry);
        }
      });
    },
    // Saves this chat's copy into its profile, one save at a time. Chrome
    // writes its cookie jar only when it exits, so the chat's browser is
    // closed, saved, and started again on the saved profile with its tabs.
    saveProfile(parameters, signal, context) {
      return enqueue(async () => {
        if (closed) throw new Error('Browser manager is closed');
        if (controller === 'user') {
          throw new Error('The user controls the browser. Wait for them to hand control back.');
        }
        const entry = scopes.get(knownScope(context) ? scopeId(context) : '');
        if (!entry?.profile) {
          const boundLater = entry && profiles ? await profiles.resolve(entry.directory) : null;
          if (boundLater) {
            throw new Error(`This chat's browser started before its project was bound to the browser profile "${boundLater.name}", so it does not run on that profile and nothing was saved. Close this chat's browser (Browser panel ⋯ menu, "Close this chat's browser") and open a page again: the new browser starts on the profile. Logins made in the current browser are lost when it closes, so sign in again after that and call browser.saveProfile.`);
          }
          throw new Error('This chat\'s browser does not use a saved profile: its project is not bound to one. The user binds projects to profiles on the Server Browser page.');
        }
        const pages = entry.runtime.tabs.filter((tab) => /^https?:/.test(tab.url)).map((tab) => ({ url: tab.url, active: tab.active }));
        const wasSelected = selectedScopeId === entry.id;
        const current = await profiles.version(entry.profile.id);
        let version = null;
        let stale = current !== entry.runtime.profileVersion ? current : null;
        if (stale === null) {
          try {
            version = await removeScope(entry, { save: true });
          } catch (error) {
            if (error?.code !== 'STALE_PROFILE') throw error;
            stale = true;
          }
        } else {
          await removeScope(entry, { save: false });
        }
        const fresh = await reopen(context, pages, wasSelected, signal);
        if (stale !== null) {
          throw new Error(`Another chat saved the browser profile "${entry.profile.name}" after this chat's copy was taken, so this copy was not saved: it would have dropped that change. This chat's browser now runs on a fresh copy that has it (tabs reopened, with new ids: ${JSON.stringify(fresh.runtime.tabs.map(({ id, url }) => ({ id, url })))}). Redo your change and call browser.saveProfile again.`);
        }
        if (version === null) throw new Error(`The browser profile "${entry.profile.name}" was deleted, so there was nothing to save into`);
        return {
          saved: true,
          profile: entry.profile.name,
          version,
          reopenedTabs: pages.length,
          tabs: fresh.runtime.tabs.map(({ id, title, url, active }) => ({ id, title, url, active })),
        };
      });
    },
    state({ viewer = null } = {}, { problems = false } = {}) {
      return {
        controller,
        // Whether the viewer asking holds control, so its dock can act.
        viewerInControl: controller === 'user' && viewer !== null && viewer === controllingViewer,
        selectedScopeId,
        // The chat the agent holds the picture for; other chats' pages are free.
        agentScopeId: controller === 'agent' ? agentScopeId : null,
        generation: viewGeneration,
        notice: notice ? { ...notice } : null,
        help: help ? { ...help } : null,
        chrome: chromeStatus(),
        copy: selected()?.runtime.copyRequest ?? null,
        // The visible tab's errors and warnings, only for a dock whose console is open.
        ...(problems ? { consoleProblems: selected()?.runtime.consoleProblems?.() ?? [] } : {}),
        scopes: Array.from(scopes.values(), (entry) => ({
          id: entry.id,
          directory: entry.directory,
          sessionId: entry.sessionId,
          profile: entry.profile ? { ...entry.profile, copyVersion: entry.runtime.profileVersion ?? null, users: profileUsers(entry).length } : null,
          signIn: isSignIn(entry),
          selected: entry.id === selectedScopeId,
          url: entry.runtime.url ?? 'about:blank',
          title: entry.runtime.title ?? '',
          isLoading: entry.runtime.isLoading === true,
          canGoBack: entry.runtime.canGoBack === true,
          canGoForward: entry.runtime.canGoForward === true,
          nativeSelectCompatibility: entry.runtime.nativeSelectCompatibility === true,
          nativeSelectCompatibilityError: entry.runtime.nativeSelectCompatibilityError ?? '',
          tabs: entry.runtime.tabs ?? [],
          // Where the agent works, and whether an action runs there now.
          agentTabId: entry.runtime.agentTabId ?? null,
          agentActive: entry.runtime.agentActive === true,
          downloads: entry.runtime.downloads ?? [],
          audioUnavailable: entry.runtime.audioUnavailable === true,
          viewport: entry.runtime.viewportState ?? null,
          problems: entry.runtime.problemCounts ?? { errors: 0, warnings: 0 },
          zoomLevel: entry.runtime.zoomLevel ?? 0,
          colorScheme: entry.runtime.colorScheme ?? 'system',
        })),
      };
    },
    // A viewer opens the browser of the chat it is looking at, before any agent
    // action. The dock reports that chat; the host does not attest it per request.
    // Opening or picking a scope chooses the view rather than acting on the
    // picture, so the viewer's last frame (of a scope that may be gone, with
    // nothing on screen since) is no reason to refuse it.
    // A chat whose browser is already open is shown at once, outside the
    // operation queue: an agent action running in another chat must not
    // keep the viewer on that chat's browser. Only creating one waits.
    async openScope(context, expectedGeneration, access) {
      if (closed) throw new Error('Browser manager is closed');
      const existing = knownScope(context) ? scopes.get(scopeId(context)) : null;
      if (existing) {
        showScope(existing, expectedGeneration, access);
        return;
      }
      await enqueue(async () => {
        if (closed) throw new Error('Browser manager is closed');
        requireDockAccess({ ...access, frameSeq: null }, { agentMayHold: true });
        requireGeneration(expectedGeneration);
        const entry = await ensureScope(context);
        touch(entry);
        if (selectedScopeId === entry.id) return;
        if (surfaceSize) await entry.runtime.surfaceResize(surfaceSize);
        requireDockAccess({ ...access, frameSeq: null }, { agentMayHold: true });
        select(entry);
        notice = null;
      });
    },
    async selectScope(id, expectedGeneration, access) {
      const entry = scopes.get(id);
      if (!entry) throw new Error('The selected browser scope no longer exists');
      showScope(entry, expectedGeneration, access);
    },
    // Closes a chat's browser without saving, even one on a profile; a save
    // is only ever explicit (browser.saveProfile, the profile's own
    // sign-in Save), never implied by closing it from the dock.
    closeScope(id, expectedGeneration, access) {
      return enqueue(async () => {
        requireDockAccess(access, { agentMayHold: true });
        requireGeneration(expectedGeneration);
        const entry = scopes.get(id);
        if (!entry) throw new Error('The selected browser scope no longer exists');
        await removeScope(entry, { save: false });
      });
    },
    // Outside the operation queue, like the inspector's own evaluate/request,
    // so a pending agent action cannot silently delay the 409 into a wait.
    pageEvaluate(expression, expectedGeneration, access, { userGesture = false } = {}) {
      requireDockAccess(access);
      requireGeneration(expectedGeneration);
      const entry = requireSelected();
      if (entry.runtime.agentActive) throw new Error('The agent is using this page right now; read it again once the action finishes');
      touch(entry);
      return entry.runtime.pageEvaluate(expression, { userGesture });
    },
    pageCapture(expectedGeneration, access) {
      requireDockAccess(access);
      requireGeneration(expectedGeneration);
      const entry = requireSelected();
      if (entry.runtime.agentActive) throw new Error('The agent is using this page right now; capture it again once the action finishes');
      touch(entry);
      return entry.runtime.pageCapture();
    },
    pageColorScheme(scheme, expectedGeneration, access) {
      return enqueue(async () => {
        requireDockAccess(access);
        requireGeneration(expectedGeneration);
        const entry = requireSelected();
        touch(entry);
        await entry.runtime.setColorScheme(scheme);
      });
    },
    pageZoom(level, expectedGeneration, access) {
      return enqueue(async () => {
        requireDockAccess(access);
        requireGeneration(expectedGeneration);
        const entry = requireSelected();
        touch(entry);
        await entry.runtime.setZoomLevel(level);
      });
    },
    pageClear(what, expectedGeneration, access) {
      return enqueue(async () => {
        requireDockAccess(access);
        requireGeneration(expectedGeneration);
        const entry = requireSelected();
        touch(entry);
        await entry.runtime.pageClear(what);
      });
    },
    navigate(url, expectedGeneration, access) {
      return dockCommand('navigate', { url }, expectedGeneration, access);
    },
    reload(expectedGeneration, access) {
      return dockCommand('reload', {}, expectedGeneration, access);
    },
    back(expectedGeneration, access) {
      return dockCommand('back', {}, expectedGeneration, access);
    },
    forward(expectedGeneration, access) {
      return dockCommand('forward', {}, expectedGeneration, access);
    },
    stop(expectedGeneration, access) {
      return dockCommand('stop', {}, expectedGeneration, access);
    },
    newTab(expectedGeneration, access) {
      return dockCommand('tab-new', {}, expectedGeneration, access);
    },
    // Outside the operation queue and allowed while the agent holds the
    // picture: showing another tab changes what the viewer sees, and agent
    // actions that name no tab keep to the tab the agent last used. Like
    // picking a chat, it chooses the view rather than acting on the picture,
    // so the viewer's last frame is no reason to refuse it: right after a
    // chat switch that frame is still the other chat's, and refusing left
    // the panel unable to change tabs until a reload.
    async selectTab(tabId, expectedGeneration, access) {
      requireDockAccess({ ...access, frameSeq: null }, { agentMayHold: true });
      requireGeneration(expectedGeneration);
      const entry = requireSelected();
      touch(entry);
      await entry.runtime.command('tab-select', { tabId });
    },
    // Names its tab, so it means the same whatever is on screen: a tab switch
    // landing just before it (the panel showing the next tab) is no reason
    // to refuse it. Only who may use the dock is checked.
    closeTab(tabId, _expectedGeneration, access) {
      return enqueue(async () => {
        requireDockAccess({ ...access, frameSeq: null });
        const entry = requireSelected();
        touch(entry);
        await entry.runtime.command('tab-close', { tabId });
      });
    },
    // Outside the operation queue: an agent action waiting on the paused page
    // must not hold up the answer that lets it run again.
    async pageDialog({ tabId, dialogId, accept, promptText }, access) {
      requireAnswerAccess(access);
      const entry = requireSelected();
      touch(entry);
      return entry.runtime.answerDialog({ tabId, dialogId, accept, promptText });
    },
    async pageFileChooser({ tabId, chooserId, files }, access) {
      requireAnswerAccess(access);
      const entry = requireSelected();
      touch(entry);
      return entry.runtime.answerFileChooser({ tabId, chooserId, files });
    },
    setViewport({ mode, width, height, mobile }, expectedGeneration, access) {
      return enqueue(async () => {
        requireDockAccess(access);
        requireGeneration(expectedGeneration);
        const entry = requireSelected();
        touch(entry);
        await entry.runtime.configureViewport({ mode, source: 'viewer', width, height, mobile });
      });
    },
    setViewerTheme(theme) {
      viewerTheme = theme;
    },
    setDevicePixelRatio(ratio) {
      return enqueue(async () => {
        if (ratio === devicePixelRatio) return;
        const measuredWithoutRatio = devicePixelRatio === null;
        devicePixelRatio = ratio;
        if (!surfaceViewport) return;
        if (!measuredWithoutRatio) {
          // Same CSS size, new density: only the render scale changes.
          surfaceSize = { ...(surfaceSize ?? cssSize(surfaceViewport, ratio)), scale: ratio };
          const entry = selected();
          if (entry) await entry.runtime.surfaceResize(surfaceSize);
          return;
        }
        surfaceSize = { ...cssSize(surfaceViewport, ratio), scale: ratio };
        const entry = selected();
        if (entry) await entry.runtime.surfaceResize(surfaceSize);
      });
    },
    setNativeSelectCompatibility(enabled, expectedGeneration, access) {
      return enqueue(async () => {
        requireDockAccess(access);
        requireGeneration(expectedGeneration);
        const entry = requireSelected();
        touch(entry);
        const previous = entry.runtime.nativeSelectCompatibility === true;
        await entry.runtime.setNativeSelectCompatibility(enabled);
        try {
          requireDockAccess(access);
          requireGeneration(expectedGeneration);
        } catch (error) {
          await entry.runtime.setNativeSelectCompatibility(previous);
          throw error;
        }
      });
    },
    async surfaceFrame({ after, wait, signal }) {
      const entry = selected();
      if (closed) return null;
      signal?.throwIfAborted();
      if (!entry) {
        if (wait === 0) return null;
        return new Promise((resolve, reject) => {
          const waiter = { signal, resolve, reject, timer: null, onAbort: null };
          waiter.onAbort = () => finishSelectionWaiter(
            waiter,
            signal.reason ?? new DOMException('Frame request cancelled', 'AbortError'),
          );
          waiter.timer = setTimeout(() => finishSelectionWaiter(waiter), wait);
          waiter.timer.unref?.();
          signal?.addEventListener('abort', waiter.onAbort, { once: true });
          selectionWaiters.add(waiter);
          if (signal?.aborted) waiter.onAbort();
        });
      }
      touch(entry);
      const generation = viewGeneration;
      const current = frameState?.scopeId === entry.id ? frameState : null;
      if (current?.frame && current.sequence > after) return current.frame;
      const switchController = new AbortController();
      frameControllers.add(switchController);
      const combinedSignal = signal
        ? AbortSignal.any([signal, switchController.signal])
        : switchController.signal;
      let frame;
      try {
        frame = await entry.runtime.surfaceFrame({
          after: current?.sourceSequence ?? 0,
          wait,
          signal: combinedSignal,
        });
      } catch (error) {
        if (switchController.signal.aborted) return null;
        throw error;
      } finally {
        frameControllers.delete(switchController);
      }
      if (!frame || selectedScopeId !== entry.id || viewGeneration !== generation) return null;
      const published = frameState?.scopeId === entry.id ? frameState : null;
      if (published && frame.sequence <= published.sourceSequence) return null;
      observeView();
      frameSequence = Math.max(frameSequence + 1, after + 1);
      const wrapped = { ...frame, sequence: frameSequence };
      frameState = {
        scopeId: entry.id,
        sourceSequence: frame.sequence,
        sequence: frameSequence,
        frame: wrapped,
      };
      return wrapped;
    },
    // The selected scope's sound. A listener that starts (`after` 0) or a
    // browser it has not heard yet starts from the newest packet, not a replay.
    async surfaceAudio({ after, wait, signal }) {
      if (closed) return null;
      signal?.throwIfAborted();
      const entry = selected();
      if (!entry?.runtime.surfaceAudio) {
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1_000)));
        return null;
      }
      touch(entry);
      const from = after > 0 && audioCursor?.runtime === entry.runtime ? audioCursor.sourceSeq : entry.runtime.audioHead;
      const switchController = new AbortController();
      frameControllers.add(switchController);
      let batch;
      try {
        batch = await entry.runtime.surfaceAudio({
          after: from,
          wait,
          signal: signal ? AbortSignal.any([signal, switchController.signal]) : switchController.signal,
        });
      } catch (error) {
        if (switchController.signal.aborted) return null;
        throw error;
      } finally {
        frameControllers.delete(switchController);
      }
      if (!batch || selectedScopeId !== entry.id) return null;
      audioCursor = { runtime: entry.runtime, sourceSeq: batch.seq };
      audioSequence += 1;
      return { ...batch, seq: audioSequence };
    },
    surfaceInput(events, { viewer = null, frameSeq = null } = {}) {
      controller = 'user';
      // The host sends input only from the viewer in control, ahead of its control notice.
      if (viewer) controllingViewer = viewer;
      notifyControl();
      return enqueue(async () => {
        const entry = requireSelected();
        if (shownEarlierView(frameSeq)) throw new Error('The browser view changed before this input arrived');
        touch(entry);
        const { runtime } = entry;
        await runtime.surfaceControl('user');
        return runtime.surfaceInput(events, viewerTheme);
      });
    },
    surfaceControl(nextController, viewer = null) {
      return enqueue(() => {
        controller = nextController;
        controllingViewer = nextController === 'user' ? viewer ?? controllingViewer : null;
        notifyControl();
        return selected()?.runtime.surfaceControl(nextController);
      });
    },
    surfaceResize(size) {
      return enqueue(() => {
        surfaceViewport = size;
        surfaceSize = { ...cssSize(size, devicePixelRatio ?? 1), scale: devicePixelRatio ?? 1 };
        return requireSelected().runtime.surfaceResize(surfaceSize);
      });
    },
    // The inspector page follows the visible scope. Its calls stay out of the
    // operation queue so polling never waits behind an agent action; a new
    // selection answers CAPTURE_GONE and the page starts a fresh capture.
    inspectorStart() {
      return requireInspectable().runtime.inspectorStart();
    },
    inspectorEvents(captureId, after) {
      return requireInspectable().runtime.inspector.events(captureId, after);
    },
    inspectorClear(captureId, scope) {
      requireInspectable().runtime.inspector.clear(captureId, scope);
    },
    inspectorStop(captureId) {
      selected()?.runtime.inspector.stop(captureId);
    },
    inspectorEvaluate(captureId, expression) {
      const entry = requireInspectable();
      if (controller === 'agent') throw new InspectorError('AGENT_ACTIVE');
      // A page paused on a dialog runs no script until the dialog is answered.
      if (entry.runtime.tabs?.some((tab) => tab.active && tab.dialog)) throw new InspectorError('UNAVAILABLE');
      return entry.runtime.inspector.evaluate(captureId, expression);
    },
    inspectorRequest(captureId, entryId, includeBody) {
      return requireInspectable().runtime.inspector.request(captureId, entryId, includeBody);
    },
    surfaceClipboard() {
      return enqueue(() => requireSelected().runtime.surfaceClipboard());
    },
    // The agent asks the person to do something only they can, such as a
    // login or a one-time code. The chat's browser and the tab become the
    // visible view, then this waits outside the operation queue until the
    // person has taken control and handed it back, or the time runs out.
    async requestHelp({ tabId, reason, timeoutSeconds = HELP_TIMEOUT_DEFAULT_S, kind = 'page', profileName } = {}, signal, context) {
      const startedAt = now();
      if (kind === 'profile') return profileForHelp({ reason, timeoutSeconds, profileName }, signal, context, startedAt);
      if (kind === 'login' && profiles) {
        const login = await signInForHelp({ tabId, reason, timeoutSeconds }, signal, context, startedAt);
        if (login) return login;
      }
      const entry = await enqueue(async () => {
        if (closed) throw new Error('Browser manager is closed');
        if (controller === 'user') {
          throw new Error('The user controls the browser. Wait for them to hand control back.');
        }
        const scope = await ensureScope(context);
        await scope.runtime.ensurePage();
        if (tabId !== undefined) {
          if (!scope.runtime.tabs.some((tab) => tab.id === tabId)) {
            throw new Error(`This chat's browser has no tab ${JSON.stringify(String(tabId))}. Use an id from browser.snapshot's tabs.`);
          }
          await scope.runtime.command('tab-select', { tabId });
        }
        if (surfaceSize) await scope.runtime.surfaceResize(surfaceSize);
        select(scope);
        notice = null;
        touch(scope);
        return scope;
      });
      entry.helpPending += 1;
      help = { scopeId: entry.id, reason: String(reason ?? ''), tabId: entry.runtime.tabs.find((tab) => tab.active)?.id ?? null, since: startedAt };
      let tookControl = controller === 'user';
      let waiter = null;
      let timer = null;
      try {
        const outcome = await new Promise((resolve, reject) => {
          const onAbort = () => reject(signal.reason ?? new DOMException('Browser action was cancelled', 'AbortError'));
          waiter = () => {
            if (scopes.get(entry.id) !== entry) {
              reject(new Error('This chat\'s browser closed while waiting for help'));
              return;
            }
            if (controller === 'user') tookControl = true;
            else if (tookControl) resolve('handed-back');
          };
          controlWaiters.add(waiter);
          timer = setTimer(() => resolve('timeout'), timeoutSeconds * 1000);
          timer?.unref?.();
          if (signal?.aborted) onAbort();
          signal?.addEventListener('abort', onAbort, { once: true });
        });
        touch(entry);
        const answer = {
          outcome,
          tabId: entry.runtime.tabs.find((tab) => tab.active)?.id,
          url: entry.runtime.url ?? 'about:blank',
          title: entry.runtime.title ?? '',
          waitedSeconds: Math.round((now() - startedAt) / 1000),
        };
        if (kind !== 'login') return answer;
        return { ...answer, profileSaved: false, note: LOGIN_NOT_SAVED_NOTE };
      } finally {
        if (waiter) controlWaiters.delete(waiter);
        if (timer) clearTimer(timer);
        entry.helpPending -= 1;
        if (help?.scopeId === entry.id && entry.helpPending === 0) help = null;
      }
    },
    // The person approves or declines the profile request in the Browser panel.
    answerProfileRequest(approve, access) {
      requireAnswerAccess(access);
      if (help?.kind !== 'profile') throw new Error('No profile request is waiting for an answer');
      profileAnswer = approve ? 'approved' : 'declined';
      notifyControl();
    },
    // Opens a saved profile in the shared surface so a person can sign in by hand.
    openProfile(id, expectedGeneration, access) {
      return enqueue(async () => {
        if (closed) throw new Error('Browser manager is closed');
        if (!profiles) throw new Error('Saved profiles are not available');
        requireDockAccess(access);
        requireGeneration(expectedGeneration);
        const profile = await profiles.get(id);
        const entry = await ensureScope({ directory: `${SIGN_IN_PREFIX}${profile.id}`, sessionId: SIGN_IN_SESSION }, { profile });
        await entry.runtime.ensurePage();
        touch(entry);
        if (selectedScopeId === entry.id) return entry.id;
        if (surfaceSize) await entry.runtime.surfaceResize(surfaceSize);
        requireDockAccess(access);
        select(entry);
        notice = null;
        return entry.id;
      });
    },
    async listProfiles() {
      if (!profiles) return [];
      const live = [...scopes.values()].filter((entry) => entry.profile);
      return (await profiles.list()).map((profile) => {
        const users = live.filter((entry) => entry.profile.id === profile.id);
        return {
          ...profile,
          signingIn: users.some(isSignIn),
          chats: users.filter((entry) => !isSignIn(entry)).map((entry) => ({ directory: entry.directory, sessionId: entry.sessionId, copyVersion: entry.runtime.profileVersion ?? null })),
        };
      });
    },
    async createProfile(name) {
      if (!profiles) throw new Error('Saved profiles are not available');
      return profiles.create(name);
    },
    async renameProfile(id, name) {
      if (!profiles) throw new Error('Saved profiles are not available');
      const renamed = await profiles.rename(id, name);
      for (const entry of scopes.values()) if (entry.profile?.id === id) entry.profile = { id, name: renamed.name };
      return renamed;
    },
    // A new binding applies to browsers that start afterwards; a chat's open browser keeps its profile.
    async bindProfile(id, directory) {
      if (!profiles) throw new Error('Saved profiles are not available');
      return profiles.bind(id, directory);
    },
    async unbindProfile(id, directory) {
      if (!profiles) throw new Error('Saved profiles are not available');
      return profiles.unbind(id, directory);
    },
    // Saves the profile's sign-in browser into the profile and closes it.
    // A sign-in that started before an agent saved the profile is refused,
    // like any copy, so the person signs in again on the saved profile.
    closeProfile(id) {
      return enqueue(async () => {
        const signIn = [...scopes.values()].find((entry) => isSignIn(entry) && entry.profile?.id === id);
        if (!signIn) throw new Error('This profile is not open for signing in');
        try {
          await removeScope(signIn, { save: true });
        } catch (error) {
          if (error?.code !== 'STALE_PROFILE') throw error;
          throw new Error('An agent saved this profile while you were signing in, so your sign-in was not saved over it. Open Sign in again and repeat it.');
        }
      });
    },
    // Deleting closes the profile's browser without saving it first.
    deleteProfile(id) {
      return enqueue(async () => {
        if (!profiles) throw new Error('Saved profiles are not available');
        await Promise.all([...scopes.values()].filter((entry) => entry.profile?.id === id).map((entry) => removeScope(entry, { save: false })));
        await profiles.remove(id);
      });
    },
    // Closes every browser on a profile without saving and wipes the store and its key.
    revokeAllProfiles() {
      return enqueue(async () => {
        if (!profiles) throw new Error('Saved profiles are not available');
        await Promise.all([...scopes.values()].filter((entry) => entry.profile).map((entry) => removeScope(entry, { save: false })));
        await profiles.revokeAll();
      });
    },
    close() {
      if (closed) return operationQueue;
      closed = true;
      if (sweepTimer) clearTimer(sweepTimer);
      sweepTimer = null;
      for (const pending of frameControllers) pending.abort();
      for (const waiter of selectionWaiters) finishSelectionWaiter(waiter);
      // Not behind queued work: a closing runtime stops its Chrome and fails
      // what is still waiting on it, and the host kills the service a few
      // seconds after asking it to stop.
      const closing = Promise.allSettled(Array.from(scopes.values(), (entry) => entry.runtime.close({ save: isSignIn(entry) })));
      return enqueue(async () => {
        await closing;
        scopes.clear();
        selectedScopeId = null;
        frameState = null;
      });
    },
  };
};
