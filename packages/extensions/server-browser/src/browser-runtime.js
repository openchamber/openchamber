import crypto from 'node:crypto';
import { GUEST_CLIPBOARD_TEXT_MAX } from '@openchamber/sdk';
import { createBrowserActions } from './browser-actions.js';
import { installCaptureGuard } from './capture-guard.js';
import { connectCdp } from './cdp-client.js';
import fs from 'node:fs';
import { createChromeProcess, visibleUserAgent } from './chrome-process.js';
import { MENU_BINDING, MENU_WORLD, createContextMenu } from './context-menu.js';
import { createDownloads } from './downloads.js';
import { createFavicons } from './favicons.js';
import { InspectorError, createInspector } from './inspector.js';
import { networkGrants, originGrants } from './config.js';
import { createNativeSelectCompatibility } from './native-select-compatibility.js';
import { createPageRequests, dialogBlockedMessage, publicDialog } from './page-requests.js';
import { createPolicyProxy } from './policy-proxy.js';
import { createSurface } from './surface.js';
import { AUDIO_BINDING, AUDIO_WORLD, createTabAudio } from './tab-audio.js';
import { applyViewport, cssScreenshotParams, presetViewport } from './viewports.js';

const boundedText = (value, maximum = 1_000) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maximum);

const createTab = (targetId, sessionId, openerId) => ({
  targetId,
  sessionId,
  openerId,
  // A page target's main frame shares the target's id.
  mainFrameId: targetId,
  url: 'about:blank',
  title: '',
  isLoading: false,
  canGoBack: false,
  canGoForward: false,
  navigationRefresh: null,
  navigationStale: false,
  navigationTimer: null,
  problems: [],
  compatibility: null,
  lastActive: 0,
  // Opened by the agent (browser.open, or a page an agent tab opened):
  // only such a tab may be closed by browser.close; the person's stay.
  openedByAgent: false,
  // What the page asks of the person; see page-requests.js.
  dialog: null,
  fileChooser: null,
  dialogListeners: new Set(),
  // Settings the tab could not take while paused on a dialog ('viewport',
  // 'zoom', 'colorScheme', 'nativeSelect'); they land once it is answered.
  staleSettings: new Set(),
});

const isScopePage = (info, contextId, ignoredTargetId = null) => info?.type === 'page'
  && info.browserContextId === contextId
  && info.targetId !== ignoredTargetId
  && info.subtype !== 'prerender';

// `profile` ({ id, name, checkout, checkin }) runs this browser on a copy of
// a saved profile: Chrome's own default context on a checked-out
// user-data-dir. The copy is saved into the profile only when closed with
// `save`. Without a profile, a context of a throwaway Chrome.
// `projectDirectory` lets pages reach dev servers running inside that project.
// `downloadsDirectory` is where pages' downloads go and `uploadsDirectory`
// where files a person picks for a page are put; without one, downloads are
// dropped and file choosers left to Chrome, which shows none.
export const createBrowserRuntime = ({
  chromePath = null,
  allowedOrigins = [],
  allowedNetworks = [],
  openchamberOrigins = [],
  configPath = null,
  devServers = null,
  projectDevServers = null,
  projectDirectory = null,
  profile = null,
  allowPrivateNetwork = null,
  downloadsDirectory = null,
  uploadsDirectory = null,
} = {}) => {
  // Lets the service capture a tab's sound; capture-guard.js keeps pages from doing the same.
  let chrome = profile ? null : createChromeProcess({ chromePath, tabAudioCapture: true });
  let profileDirectory = null;
  let profileVersion = null;
  const grantSources = [
    devServers ? () => devServers.grants() : null,
    projectDevServers && projectDirectory ? () => projectDevServers.projectGrants(projectDirectory) : null,
  ].filter(Boolean);
  const proxy = createPolicyProxy({
    openchamberOrigins,
    grants: [...originGrants(allowedOrigins), ...networkGrants(allowedNetworks)],
    configPath,
    devServerGrants: grantSources.length > 0 ? async () => (await Promise.all(grantSources.map((source) => source()))).flat() : null,
    discoverDevServers: Boolean(devServers),
    projectDirectory: projectDevServers ? projectDirectory : null,
    allowPrivateNetwork,
  });
  const shutdownController = new AbortController();
  const tabs = new Map();
  const sessions = new Map();
  const attaching = new Map();
  const backgroundTargets = new Set();
  let targetCreation = Promise.resolve();
  const tabListeners = new Set();
  const favicons = createFavicons();
  let activeTargetId = null;
  // The tab the agent last opened or worked in: an action that names no tab
  // runs there, whichever tab the viewer has in front.
  let agentTargetId = null;
  let activations = 0;
  let nativeSelectEnabled = false;
  let cdp = null;
  let contextId = null;
  let eventCleanup = null;
  let guardCleanup = null;
  let startupPromise = null;
  let pagePromise = null;
  let actionQueue = Promise.resolve();
  let userAgent = null;
  // The page Chrome opens at launch, in the default context a profile uses; it is not one of our tabs.
  let launchTargetId = null;
  let closed = false;
  let dead = null;
  const deathListeners = new Set();
  // 'fixed' keeps a chosen size; 'auto' follows the viewer's panel, and only
  // a viewer's Fill or an agent's 'fill' turns it on. A page starts at the
  // desktop size, so opening the panel does not lay it out again at the
  // panel's size. The source says who chose the size.
  const DEFAULT_VIEWPORT = presetViewport('desktop');
  let viewportConfig = {
    mode: 'fixed',
    source: 'default',
    mobile: false,
    fixed: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height },
    panel: null,
    scale: 1,
  };

  const effectiveViewport = () => {
    const size = viewportConfig.mode === 'fixed' ? viewportConfig.fixed : viewportConfig.panel ?? presetViewport('desktop');
    return { width: size.width, height: size.height, mobile: viewportConfig.mobile, scale: viewportConfig.scale };
  };

  const markDead = () => {
    if (closed || dead) return;
    dead = new Error('Chrome for this chat stopped unexpectedly; retry the action to start a new browser');
    shutdownController.abort(dead);
    for (const listener of deathListeners) listener(dead);
  };
  chrome?.onExit(markDead);

  const activeTab = () => tabs.get(activeTargetId) ?? null;

  const pageRequests = createPageRequests({ uploadRoot: uploadsDirectory });
  const downloads = downloadsDirectory ? createDownloads({ directory: downloadsDirectory }) : null;
  const audio = createTabAudio({
    activeTab,
    send: (sessionId, method, params) => cdp.sendSession(sessionId, method, params),
  });
  // The agent action running now and the tab it works on: a dialog that
  // opens there ends the action at once instead of leaving it waiting on a
  // paused page (page-requests.js).
  let agentAction = null;

  const runtime = {
    get viewport() {
      return effectiveViewport();
    },
    get viewportState() {
      const { width, height, mobile } = effectiveViewport();
      return { mode: viewportConfig.mode, source: viewportConfig.source, width, height, mobile };
    },
    controller: 'none',
    agentActive: false,
    get url() {
      return activeTab()?.url ?? 'about:blank';
    },
    get title() {
      return activeTab()?.title ?? '';
    },
    get isLoading() {
      return activeTab()?.isLoading === true;
    },
    get canGoBack() {
      return activeTab()?.canGoBack === true;
    },
    get canGoForward() {
      return activeTab()?.canGoForward === true;
    },
    // The tab the agent last opened or worked in; null before it used one.
    // An action that names no tab runs there, else on the tab in front.
    get agentTabId() {
      return tabs.has(agentTargetId) ? agentTargetId : null;
    },
    get tabs() {
      return Array.from(tabs.values(), (current) => ({
        id: current.targetId,
        url: current.url,
        title: current.title,
        favicon: favicons.of(current.url),
        isLoading: current.isLoading,
        active: current.targetId === activeTargetId,
        dialog: current.dialog ? { id: current.dialog.id, ...publicDialog(current.dialog) } : null,
        fileChooser: current.fileChooser ? {
          id: current.fileChooser.id,
          multiple: current.fileChooser.mode === 'selectMultiple',
          accept: current.fileChooser.accept,
          directory: current.fileChooser.directory,
        } : null,
      }));
    },
    get downloads() {
      return downloads?.list ?? [];
    },
    // The page in front gives no sound (an insecure page cannot be captured).
    get audioUnavailable() {
      return audio.unavailable;
    },
    get audioHead() {
      return audio.head;
    },
    get nativeSelectCompatibility() {
      return activeTab()?.compatibility.enabled ?? nativeSelectEnabled;
    },
    get nativeSelectCompatibilityError() {
      return activeTab()?.compatibility.error ?? '';
    },
    // Text the viewer asked to copy from the page menu; the dock offers it through a host toast.
    get copyRequest() {
      if (!copyRequest || Date.now() - copyRequest.at > 10_000) return null;
      return { id: copyRequest.id, text: copyRequest.text };
    },
    get problemCounts() {
      const problems = activeTab()?.problems ?? [];
      return {
        errors: problems.filter((problem) => problem.level === 'error').length,
        warnings: problems.filter((problem) => problem.level === 'warning').length,
      };
    },
    consoleProblems(targetId = activeTargetId) {
      return (tabs.get(targetId)?.problems ?? []).map((problem) => ({ ...problem }));
    },
    clearConsoleProblems(targetId = activeTargetId) {
      const current = tabs.get(targetId);
      if (current) current.problems.length = 0;
    },
  };

  const addProblem = (current, problem) => {
    if (!problem.message) return;
    current.problems.push(problem);
    if (current.problems.length > 50) current.problems.shift();
  };

  const pageOf = (current) => ({ cdp, contextId, targetId: current.targetId, sessionId: current.sessionId });

  const notifyTabs = () => {
    for (const listener of tabListeners) listener();
  };

  // Coalesced: events during a read schedule one more read. A failed read keeps
  // the last known state. History entries carry the live document title.
  const refreshNavigation = (current) => {
    if (current.navigationRefresh) {
      current.navigationStale = true;
      return current.navigationRefresh;
    }
    current.navigationRefresh = (async () => {
      do {
        current.navigationStale = false;
        try {
          const history = await cdp.sendSession(current.sessionId, 'Page.getNavigationHistory');
          const entries = Array.isArray(history.entries) ? history.entries : [];
          const index = Number.isInteger(history.currentIndex) ? history.currentIndex : -1;
          current.canGoBack = index > 0;
          current.canGoForward = index >= 0 && index < entries.length - 1;
          if (typeof entries[index]?.title === 'string') current.title = entries[index].title;
          if (typeof entries[index]?.url === 'string' && entries[index].url) current.url = entries[index].url;
        } catch {}
      } while (current.navigationStale && !closed && tabs.get(current.targetId) === current);
    })().finally(() => { current.navigationRefresh = null; });
    return current.navigationRefresh;
  };

  // Chrome delays title notifications, so a painting page rereads its
  // navigation state at most twice a second.
  const scheduleNavigationRefresh = (current) => {
    if (current.navigationTimer) return;
    current.navigationTimer = setTimeout(() => {
      current.navigationTimer = null;
      if (tabs.get(current.targetId) === current) void refreshNavigation(current);
    }, 500);
    current.navigationTimer.unref?.();
  };

  const activate = async (current) => {
    if (activeTargetId === current.targetId || tabs.get(current.targetId) !== current) return;
    const previous = activeTab();
    if (previous) inspector.endTab(previous.sessionId);
    activeTargetId = current.targetId;
    activations += 1;
    current.lastActive = activations;
    void contextMenu.close();
    surface.retarget();
    audio.retarget();
    notifyTabs();
    // Chrome can defer input and frames for a page that is not in front.
    await cdp.sendSession(current.sessionId, 'Page.bringToFront').catch(() => {});
  };

  const removeTab = (targetId) => {
    const current = tabs.get(targetId);
    if (!current) return;
    tabs.delete(targetId);
    if (agentTargetId === targetId) agentTargetId = null;
    sessions.delete(current.sessionId);
    clearTimeout(current.navigationTimer);
    contextMenu.forget(current.sessionId);
    inspector.endTab(current.sessionId);
    zoomStyles.delete(targetId);
    pageRequests.forget(current);
    audio.forget(current);
    if (activeTargetId !== targetId) {
      notifyTabs();
      return;
    }
    activeTargetId = null;
    surface.retarget();
    const fallback = tabs.get(current.openerId)
      ?? [...tabs.values()].reduce((best, candidate) => (!best || candidate.lastActive > best.lastActive ? candidate : best), null);
    if (fallback) void activate(fallback);
    else notifyTabs();
  };

  const attachTab = (targetId, openerId = null) => {
    const known = tabs.get(targetId);
    if (known) return Promise.resolve(known);
    const pending = attaching.get(targetId);
    if (pending) return pending;
    const attached = (async () => {
      const sessionId = await cdp.attach(targetId);
      if (closed) throw new Error('Browser runtime is closed');
      const current = createTab(targetId, sessionId, openerId);
      current.compatibility = createNativeSelectCompatibility({
        ensurePage: async () => pageOf(current),
        reportError: (message) => addProblem(current, { level: 'error', message, source: 'browser' }),
      });
      tabs.set(targetId, current);
      sessions.set(sessionId, current);
      // Sent together: Chrome runs a session's commands in order. A page that
      // opens a dialog as it loads takes most of them only once the dialog is
      // answered, so the tab is ready (and shows the dialog) as soon as it
      // opens; the commands still land, in order, after the answer.
      await untilDialog(current, Promise.all([
        cdp.sendSession(sessionId, 'Page.enable'),
        cdp.sendSession(sessionId, 'Runtime.enable'),
        cdp.sendSession(sessionId, 'Log.enable'),
        cdp.sendSession(sessionId, 'Runtime.addBinding', { name: MENU_BINDING, executionContextName: MENU_WORLD }),
        cdp.sendSession(sessionId, 'Runtime.addBinding', { name: AUDIO_BINDING, executionContextName: AUDIO_WORLD }),
        ...(pageRequests.interceptsFileChoosers ? [cdp.sendSession(sessionId, 'Page.setInterceptFileChooserDialog', { enabled: true })] : []),
        applyViewport(cdp, sessionId, runtime.viewport),
        ...(userAgent ? [cdp.sendSession(sessionId, 'Emulation.setUserAgentOverride', { userAgent })] : []),
      ]));
      if (nativeSelectEnabled) await applySetting(current, 'nativeSelect');
      if (zoomLevel !== 0) await applySetting(current, 'zoom');
      if (colorScheme !== 'system') await applySetting(current, 'colorScheme');
      await refreshNavigation(current);
      return current;
    })().finally(() => attaching.delete(targetId));
    attaching.set(targetId, attached);
    return attached;
  };

  const handleTargetEvent = (event) => {
    if (event.method === 'Browser.downloadWillBegin' || event.method === 'Browser.downloadProgress') {
      downloads?.event(event.method, event.params);
      return;
    }
    const info = event.params.targetInfo;
    if (event.method === 'Target.targetCreated' && isScopePage(info, contextId, launchTargetId)) {
      // Pages the site opens (popups, target=_blank) come to the front like in a
      // browser; a tab the agent opened in the background stays behind.
      void attachTab(info.targetId, info.openerId ?? null)
        .then(async (current) => {
          await targetCreation;
          if (backgroundTargets.delete(current.targetId)) return current;
          // A page the agent's tab opened is where its work continues.
          if (current.openerId && current.openerId === agentTargetId) agentTargetId = current.targetId;
          if (tabs.get(current.openerId)?.openedByAgent) current.openedByAgent = true;
          return activate(current);
        })
        .catch(() => {});
    } else if (event.method === 'Target.targetInfoChanged' && info) {
      const current = tabs.get(info.targetId);
      if (!current) return;
      if (typeof info.url === 'string') current.url = info.url;
      if (typeof info.title === 'string') current.title = info.title;
    } else if (event.method === 'Target.targetDestroyed') {
      removeTab(event.params.targetId);
    } else if (event.method === 'Target.detachedFromTarget') {
      const current = sessions.get(event.params.sessionId);
      if (current) removeTab(current.targetId);
    }
  };

  const handleEvent = (event) => {
    if (!event.sessionId) {
      handleTargetEvent(event);
      return;
    }
    const current = sessions.get(event.sessionId);
    if (!current) return;
    inspector.event(current.sessionId, event.method, event.params);
    if (event.method === 'Page.javascriptDialogOpening') {
      pageRequests.dialogOpened(current, event.params);
      if (agentAction?.targetId === current.targetId) {
        agentAction.dialogs.abort(new Error(dialogBlockedMessage(current.dialog, { during: true })));
      }
    }
    if (event.method === 'Page.javascriptDialogClosed') {
      pageRequests.dialogClosed(current);
      const stale = [...current.staleSettings];
      current.staleSettings.clear();
      for (const name of stale) void settingAppliers[name](current).catch(() => {});
    }
    if (event.method === 'Page.fileChooserOpened') {
      void pageRequests.fileChooserOpened(current, event.params, (method, params) => cdp.sendSession(current.sessionId, method, params))
        .catch(() => {});
    }
    if (event.method === 'Page.frameNavigated' && event.params.frame?.id) {
      if (!event.params.frame.parentId) {
        current.mainFrameId = event.params.frame.id;
        // A new document starts with no problems, like the DevTools console.
        current.problems.length = 0;
        pageRequests.navigated(current);
        audio.navigated(current);
        contextMenu.forget(current.sessionId);
        current.url = event.params.frame.url;
        void refreshNavigation(current);
        // The zoom stylesheet belonged to the document that just navigated away.
        zoomStyles.delete(current.targetId);
        if (zoomLevel !== 0) void applyZoomToTab(current).catch(() => {});
      }
      current.compatibility.frameNavigated(event.params.frame.id);
    }
    if (event.method === 'Page.frameDetached' && event.params.frameId) {
      current.compatibility.frameDetached(event.params.frameId);
    }
    if (event.method === 'Page.navigatedWithinDocument' && event.params.frameId === current.mainFrameId) {
      current.url = event.params.url;
      void refreshNavigation(current);
    }
    if (event.method === 'Page.frameStartedLoading' && event.params.frameId === current.mainFrameId) {
      current.isLoading = true;
    }
    if (event.method === 'Page.frameStoppedLoading' && event.params.frameId === current.mainFrameId) {
      current.isLoading = false;
      void refreshNavigation(current);
      void favicons.load({
        pageUrl: current.url,
        frameId: current.mainFrameId,
        send: (method, params) => cdp.sendSession(current.sessionId, method, params),
      });
    }
    if (event.method === 'Page.screencastFrame') scheduleNavigationRefresh(current);
    if (event.method === 'Runtime.bindingCalled' && event.params.name === MENU_BINDING) {
      contextMenu.handleBinding(current.sessionId, event.params);
    }
    if (event.method === 'Runtime.bindingCalled' && event.params.name === AUDIO_BINDING) {
      audio.binding(current, event.params.payload);
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      if (event.params.type !== 'warning' && event.params.type !== 'error') return;
      const message = event.params.args?.map((arg) => arg.value ?? arg.description).filter(Boolean).join(' ');
      addProblem(current, { level: event.params.type, message: boundedText(message), source: 'console' });
    }
    if (event.method === 'Log.entryAdded') {
      const entry = event.params.entry;
      if (entry?.level !== 'warning' && entry?.level !== 'error') return;
      addProblem(current, { level: entry.level, message: boundedText(entry.text), source: boundedText(entry.source || 'log', 120) });
    }
  };

  // A saved profile's Chrome is started with the proxy address, so the proxy
  // listens first and the working copy of the profile is unpacked for it.
  const startProfileChrome = async () => {
    const proxyAddress = await proxy.listen();
    ({ directory: profileDirectory, version: profileVersion } = await profile.checkout());
    if (closed) throw new Error('Browser runtime is closed');
    chrome = createChromeProcess({ chromePath, userDataDir: profileDirectory, proxyServer: proxyAddress, tabAudioCapture: true });
    chrome.onExit(markDead);
    return { proxyAddress, processInfo: await chrome.ensure() };
  };

  const discardProfileDirectory = async () => {
    const directory = profileDirectory;
    profileDirectory = null;
    if (directory) await fs.promises.rm(directory, { recursive: true, force: true });
  };

  const start = async () => {
    let nextCdp = null;
    let nextContextId = null;
    try {
      const { proxyAddress, processInfo } = profile
        ? await startProfileChrome()
        : await Promise.all([proxy.listen(), chrome.ensure()]).then(([address, info]) => ({ proxyAddress: address, processInfo: info }));
      if (closed) throw new Error('Browser runtime is closed');
      const reported = processInfo.version?.userAgent ?? '';
      userAgent = reported.includes('HeadlessChrome/') ? visibleUserAgent(reported) : null;
      nextCdp = await connectCdp(processInfo.endpoint);
      // Before any page loads anything: no page may run without the guard.
      guardCleanup = await installCaptureGuard(nextCdp, { openchamberOrigins });
      if (profile) {
        // The profile's cookies and storage live in the default context, which the command-line proxy covers.
        const { targetInfos = [] } = await nextCdp.send('Target.getTargets');
        const launchPage = targetInfos.find((info) => info.type === 'page');
        if (typeof launchPage?.browserContextId !== 'string') throw new Error('Chrome returned no default browser context');
        launchTargetId = launchPage.targetId;
        nextContextId = launchPage.browserContextId;
      } else {
        const context = await nextCdp.send('Target.createBrowserContext', {
          proxyServer: proxyAddress,
          proxyBypassList: '<-loopback>',
        });
        if (typeof context.browserContextId !== 'string') throw new Error('Chrome returned no browser context id');
        nextContextId = context.browserContextId;
      }
      if (closed) throw new Error('Browser runtime is closed');
      cdp = nextCdp;
      contextId = nextContextId;
      cdp.onClose(markDead);
      eventCleanup = cdp.onEvent(handleEvent);
      await cdp.send('Target.setDiscoverTargets', { discover: true });
      // Browsing works without downloads: a folder that cannot be made only
      // means files are dropped, as headless Chrome does by default.
      await downloads?.enable(cdp, profile ? null : contextId).catch(() => {});
    } catch (error) {
      guardCleanup?.();
      guardCleanup = null;
      if (!profile && nextContextId && nextCdp?.isOpen) {
        await nextCdp.send('Target.disposeBrowserContext', { browserContextId: nextContextId }).catch(() => {});
      }
      nextCdp?.close();
      if (profile) {
        // Nothing was saved yet, so the profile stays as it was sealed.
        const failed = chrome;
        chrome = null;
        await failed?.close();
        await discardProfileDirectory();
      }
      throw error;
    }
  };

  const ensureStarted = async () => {
    if (closed) throw new Error('Browser runtime is closed');
    if (dead) throw dead;
    if (cdp?.isOpen && contextId) return;
    if (!startupPromise) startupPromise = start().catch((error) => {
      startupPromise = null;
      throw error;
    });
    await startupPromise;
  };

  const openTab = async ({ background = false } = {}) => {
    await ensureStarted();
    // The target-created handler waits for this, so it knows a background tab
    // before it could bring the tab forward. Each tab gets its own window:
    // Chrome stops painting a tab that sits behind another in its window, and
    // a capture of it can then wait for a frame that never comes.
    const creation = cdp.send('Target.createTarget', { url: 'about:blank', browserContextId: contextId, newWindow: true, background })
      .then((target) => {
        if (typeof target.targetId !== 'string') throw new Error('Chrome returned no page target id');
        if (background) backgroundTargets.add(target.targetId);
        return target;
      });
    targetCreation = creation.catch(() => {});
    const current = await attachTab((await creation).targetId);
    if (closed) throw new Error('Browser runtime is closed');
    if (!background) await activate(current);
    return current;
  };

  runtime.ensurePage = async () => {
    if (dead) throw dead;
    const current = activeTab();
    if (current) return pageOf(current);
    if (!pagePromise) pagePromise = openTab().finally(() => { pagePromise = null; });
    return pageOf(await pagePromise);
  };

  // Agent actions name a tab from browser.snapshot's tabs or act on the one
  // the agent last used, else the one the viewer sees. An id this browser did
  // not issue is refused, never replaced by another tab.
  const agentTab = async (tabId) => {
    if (tabId === undefined) {
      const last = tabs.get(agentTargetId);
      if (last) return last;
      await runtime.ensurePage();
      return activeTab();
    }
    const current = tabs.get(tabId);
    if (!current) throw new Error(`This chat's browser has no tab ${JSON.stringify(String(tabId))}. Use an id from browser.snapshot's tabs.`);
    return current;
  };
  // The tab an agent action works on. A paused page cannot be read or used,
  // so an open dialog fails the action at once, naming the dialog.
  const claimForAction = (current) => {
    if (current.dialog) throw new Error(dialogBlockedMessage(current.dialog));
    if (agentAction) agentAction.targetId = current.targetId;
    agentTargetId = current.targetId;
    return pageOf(current);
  };
  runtime.agentPage = async (tabId) => claimForAction(await agentTab(tabId));

  // browser.open without a tab never replaces the viewer's page: it opens a
  // background tab, unless the viewer is on an untouched blank tab.
  runtime.agentOpenPage = async (tabId) => {
    const current = await agentTab(tabId);
    if (tabId !== undefined) return claimForAction(current);
    // An untouched blank tab becomes the agent's page, so it is the agent's tab.
    if (current.url === 'about:blank' && !current.canGoBack && !current.canGoForward) {
      current.openedByAgent = true;
      return claimForAction(current);
    }
    const opened = await openTab({ background: true });
    opened.openedByAgent = true;
    return claimForAction(opened);
  };

  // browser.close: the named tab, or the agent's most recent one. A tab the
  // person opened is refused, never closed.
  runtime.agentCloseTab = async (tabId) => {
    let current;
    if (tabId === undefined) {
      const owned = [...tabs.values()].filter((tab) => tab.openedByAgent);
      current = tabs.get(agentTargetId)?.openedByAgent
        ? tabs.get(agentTargetId)
        : owned.reduce((best, candidate) => (!best || candidate.lastActive > best.lastActive ? candidate : best), null);
      if (!current) {
        throw new Error('This chat\'s browser has no tab the agent opened, so nothing was closed. Agent actions never close a tab the user opened.');
      }
    } else {
      current = await agentTab(tabId);
      if (!current.openedByAgent) {
        throw new Error(`The browser tab ${tabId} was opened by the user, not by this chat's agent, so it was not closed.`);
      }
    }
    await cdp.send('Target.closeTarget', { targetId: current.targetId });
    removeTab(current.targetId);
    return { closed: true, tabId: current.targetId };
  };

  // browser.dialog: the one action a paused page still takes.
  runtime.agentAnswerDialog = async ({ tabId, accept, promptText }) => {
    const current = await agentTab(tabId);
    if (!current.dialog) throw new Error('No dialog is open on this tab, so there is nothing to answer; browser.snapshot reads the page.');
    const answer = await pageRequests.answerDialog(current, (method, params) => cdp.sendSession(current.sessionId, method, params), { accept, promptText });
    return {
      ...answer,
      tabId: current.targetId,
      url: current.url,
      title: current.title,
      ...(current.dialog ? { dialog: publicDialog(current.dialog) } : {}),
    };
  };

  // The dock's answers name the tab and the request it showed.
  const dockTab = (tabId) => {
    const current = tabs.get(tabId);
    if (!current) throw new Error('That tab is no longer open');
    return current;
  };
  runtime.answerDialog = ({ tabId, dialogId, accept, promptText }) => {
    const current = dockTab(tabId);
    return pageRequests.answerDialog(current, (method, params) => cdp.sendSession(current.sessionId, method, params), { dialogId, accept, promptText });
  };
  runtime.answerFileChooser = ({ tabId, chooserId, files }) => {
    const current = dockTab(tabId);
    return pageRequests.answerFileChooser(current, (method, params) => cdp.sendSession(current.sessionId, method, params), { chooserId, files });
  };

  // Resolves with the command's result, or with null as soon as the page
  // opens a dialog meanwhile ("leave this page?" on a navigation): the
  // command then waits on the dialog, which the dock shows.
  const untilDialog = (current, promise) => new Promise((resolve, reject) => {
    const onChange = () => {
      if (!current.dialog) return;
      current.dialogListeners.delete(onChange);
      promise.catch(() => {});
      resolve(null);
    };
    current.dialogListeners.add(onChange);
    onChange();
    promise.then((value) => {
      current.dialogListeners.delete(onChange);
      resolve(value);
    }, (error) => {
      current.dialogListeners.delete(onChange);
      reject(error);
    });
  });

  const requireNoDialog = (current) => {
    if (current?.dialog) throw new Error('Answer the dialog on this page first');
  };

  // The person's input reaches a paused page only once its dialog is
  // answered, so surface.js drops it while one is open, and a click that
  // opens one returns as soon as it is open instead of waiting on it.
  runtime.dialogOpen = (targetId) => Boolean(tabs.get(targetId)?.dialog);
  runtime.untilDialog = (targetId, promise) => {
    const current = tabs.get(targetId);
    return current ? untilDialog(current, promise) : promise;
  };

  // The active tab decides; other tabs follow on a best-effort basis.
  runtime.setNativeSelectCompatibility = async (enabled) => {
    await runtime.ensurePage();
    const active = activeTab();
    requireNoDialog(active);
    await active.compatibility.setEnabled(enabled);
    nativeSelectEnabled = enabled;
    await Promise.all([...tabs.values()]
      .filter((current) => current !== active)
      .map((current) => applySetting(current, 'nativeSelect')));
  };

  // A page paused on a dialog takes no command that needs it until the dialog
  // is answered; waiting on it would hold up every operation queued behind
  // this one, a panel resize included. Its new size lands once it is answered.
  const applyViewportToTab = (current, viewport) => {
    if (current.dialog) {
      current.staleSettings.add('viewport');
      return Promise.resolve();
    }
    return applyViewport(cdp, current.sessionId, viewport);
  };

  // Sets the tab's emulated size again, unchanged; see surface.js for why.
  runtime.reapplyViewport = (targetId) => {
    const current = tabs.get(targetId);
    return current ? applyViewportToTab(current, effectiveViewport()) : Promise.resolve();
  };

  const applyViewportToTabs = async () => {
    const viewport = effectiveViewport();
    await runtime.ensurePage();
    const active = activeTab();
    await applyViewportToTab(active, viewport);
    await Promise.allSettled([...tabs.values()]
      .filter((current) => current !== active)
      .map((current) => applyViewportToTab(current, viewport)));
    surface?.refreshStream();
  };

  runtime.configureViewport = async ({ mode, source, width, height, mobile }) => {
    viewportConfig = {
      ...viewportConfig,
      mode,
      source,
      fixed: mode === 'fixed' ? { width, height } : viewportConfig.fixed,
      mobile: typeof mobile === 'boolean' ? mobile : viewportConfig.mobile,
    };
    await applyViewportToTabs();
  };

  runtime.applyAgentViewport = (mode) => {
    const preset = presetViewport(mode);
    return preset
      ? runtime.configureViewport({ mode: 'fixed', source: 'agent', ...preset })
      : runtime.configureViewport({ mode: 'auto', source: 'agent', mobile: false });
  };

  // The CSS size the viewer's panel can show. A fixed viewport keeps its own
  // size and the host letterboxes it.
  runtime.setPanelSize = async ({ width, height, scale }) => {
    const scaleChanged = typeof scale === 'number' && scale !== viewportConfig.scale;
    viewportConfig = {
      ...viewportConfig,
      panel: { width, height },
      scale: typeof scale === 'number' ? scale : viewportConfig.scale,
    };
    // A fixed viewport keeps its size but still follows the viewer's density.
    if (viewportConfig.mode === 'auto' || scaleChanged) await applyViewportToTabs();
    const shown = effectiveViewport();
    return { width: shown.width, height: shown.height };
  };

  // Dock commands return once Chrome accepts them; loading and history state
  // follow page events, so a slow page can still be stopped.
  runtime.command = async (name, parameters = {}) => {
    if (closed) throw new Error('Browser runtime is closed');
    await contextMenu.close();
    if (name === 'tab-new') {
      await openTab();
      return;
    }
    if (name === 'tab-select' || name === 'tab-close') {
      const selected = tabs.get(parameters.tabId);
      if (!selected) throw new Error('That tab is no longer open');
      if (name === 'tab-select') {
        await activate(selected);
        return;
      }
      await cdp.send('Target.closeTarget', { targetId: selected.targetId });
      removeTab(selected.targetId);
      return;
    }
    const page = await runtime.ensurePage();
    const current = activeTab();
    requireNoDialog(current);
    const send = (method, params) => page.cdp.sendSession(page.sessionId, method, params);
    if (name === 'navigate') {
      const url = new URL(parameters.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Open an absolute http(s) URL');
      runtime.clearConsoleProblems();
      const result = await untilDialog(current, send('Page.navigate', { url: url.href }));
      if (result?.errorText) throw new Error(`Navigation failed: ${result.errorText}`);
    } else if (name === 'back' || name === 'forward') {
      const history = await send('Page.getNavigationHistory');
      const entry = history.entries?.[history.currentIndex + (name === 'back' ? -1 : 1)];
      if (!entry) throw new Error(name === 'back' ? 'There is nothing to go back to' : 'There is nothing to go forward to');
      await untilDialog(current, send('Page.navigateToHistoryEntry', { entryId: entry.id }));
    } else if (name === 'reload') {
      runtime.clearConsoleProblems();
      await untilDialog(current, send('Page.reload'));
    } else if (name === 'stop') {
      // Chrome refuses Page.stopLoading until a cross-document navigation
      // commits. The document's own stop, from a world the page cannot patch,
      // covers that window.
      await send('Page.stopLoading').catch(async () => {
        const world = await send('Page.createIsolatedWorld', { frameId: current.mainFrameId, worldName: 'openchamber-stop' });
        await send('Runtime.evaluate', { contextId: world.executionContextId, expression: 'window.stop()' });
      });
    } else {
      throw new Error(`Unsupported browser command: ${name}`);
    }
    await refreshNavigation(current);
  };

  const execute = createBrowserActions(runtime);
  const surface = createSurface(runtime);

  let copyRequest = null;
  const contextMenu = createContextMenu({
    navigationState: () => ({ canGoBack: runtime.canGoBack, canGoForward: runtime.canGoForward }),
    readSelection: () => surface.clipboard(),
    onAction: (action, selection) => {
      if (action === 'back' || action === 'forward' || action === 'reload') {
        void runtime.command(action).catch(() => {});
      } else if (action === 'copy') {
        copyRequest = { id: crypto.randomUUID(), text: selection.length > GUEST_CLIPBOARD_TEXT_MAX ? null : selection, at: Date.now() };
      }
    },
  });
  runtime.contextMenu = contextMenu;

  const inspector = createInspector({ send: (sessionId, method, params) => cdp.sendSession(sessionId, method, params) });
  runtime.inspector = inspector;
  runtime.inspectorStart = async () => {
    await runtime.ensurePage();
    if (activeTab().dialog) throw new InspectorError('UNAVAILABLE');
    return inspector.start(activeTab());
  };

  // Native UI zoom: Chrome exposes no per-tab CDP zoom command, so this
  // mirrors the native-select workaround (a CDP-owned stylesheet, invisible
  // to page CSP) with the CSS `zoom` property Chromium supports, at the
  // Electron `setZoomLevel` step (1.2^level). Reapplied per tab, best-effort
  // on tabs other than the active one, and invalidated on navigation because
  // the stylesheet belongs to the document that was open when it was made.
  const ZOOM_LEVEL_MIN = -5;
  const ZOOM_LEVEL_MAX = 5;
  const zoomFactor = (level) => 1.2 ** level;
  let zoomLevel = 0;
  const zoomStyles = new Map();

  const applyZoomToTab = async (current) => {
    const page = pageOf(current);
    await page.cdp.sendSession(page.sessionId, 'DOM.enable').catch(() => {});
    await page.cdp.sendSession(page.sessionId, 'CSS.enable').catch(() => {});
    const tree = await page.cdp.sendSession(page.sessionId, 'Page.getFrameTree').catch(() => null);
    const frameId = tree?.frameTree?.frame?.id;
    if (!frameId) return;
    let entry = zoomStyles.get(current.targetId);
    if (entry && entry.frameId !== frameId) {
      zoomStyles.delete(current.targetId);
      entry = null;
    }
    const text = zoomLevel === 0 ? '' : `html { zoom: ${zoomFactor(zoomLevel)} !important; }`;
    if (!entry) {
      if (!text) return;
      const created = await page.cdp.sendSession(page.sessionId, 'CSS.createStyleSheet', { frameId });
      entry = { frameId, styleSheetId: created.styleSheetId };
      zoomStyles.set(current.targetId, entry);
    }
    await page.cdp.sendSession(page.sessionId, 'CSS.setStyleSheetText', { styleSheetId: entry.styleSheetId, text }).catch(() => {});
  };

  runtime.setZoomLevel = async (level) => {
    if (!Number.isInteger(level) || level < ZOOM_LEVEL_MIN || level > ZOOM_LEVEL_MAX) {
      throw new Error(`Zoom level must be an integer from ${ZOOM_LEVEL_MIN} to ${ZOOM_LEVEL_MAX}`);
    }
    await runtime.ensurePage();
    const active = activeTab();
    requireNoDialog(active);
    zoomLevel = level;
    await applyZoomToTab(active);
    await Promise.all([...tabs.values()].filter((current) => current !== active).map((current) => applySetting(current, 'zoom')));
  };
  Object.defineProperty(runtime, 'zoomLevel', { get: () => zoomLevel, enumerable: true });

  // prefers-color-scheme for every tab: 'system' drops the override.
  let colorScheme = 'system';
  const applyColorScheme = (current) => cdp.sendSession(current.sessionId, 'Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-color-scheme', value: colorScheme === 'system' ? '' : colorScheme }],
  });
  runtime.setColorScheme = async (scheme) => {
    if (!['system', 'light', 'dark'].includes(scheme)) throw new Error('Color scheme must be system, light, or dark');
    await runtime.ensurePage();
    requireNoDialog(activeTab());
    colorScheme = scheme;
    await Promise.all([...tabs.values()].map((current) => applySetting(current, 'colorScheme')));
  };
  Object.defineProperty(runtime, 'colorScheme', { get: () => colorScheme, enumerable: true });

  // How each setting reaches a tab; a tab paused on a dialog gets it once the
  // dialog is answered (staleSettings, applied on Page.javascriptDialogClosed).
  const settingAppliers = {
    viewport: (current) => applyViewport(cdp, current.sessionId, effectiveViewport()),
    zoom: (current) => applyZoomToTab(current),
    colorScheme: (current) => applyColorScheme(current),
    nativeSelect: (current) => current.compatibility.setEnabled(nativeSelectEnabled),
  };
  // Other tabs follow the active one on a best-effort basis.
  const applySetting = (current, name) => {
    if (current.dialog) {
      current.staleSettings.add(name);
      return Promise.resolve();
    }
    return settingAppliers[name](current).catch(() => {});
  };

  // `/page/evaluate`, `/page/capture`, and `/page/clear` act on the visible
  // tab for the native dock, independent of the agent's own queued actions
  // (`runtime.perform`); the manager refuses them itself while the agent is
  // mid-action, so these run straight against CDP.
  runtime.pageEvaluate = async (expression, { userGesture = false } = {}) => {
    const page = await runtime.ensurePage();
    requireNoDialog(activeTab());
    const response = await page.cdp.sendSession(page.sessionId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: Boolean(userGesture),
    });
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'Page script failed');
    }
    return response.result?.value ?? null;
  };

  runtime.pageCapture = async () => {
    const page = await runtime.ensurePage();
    requireNoDialog(activeTab());
    await page.cdp.sendSession(page.sessionId, 'Page.enable').catch(() => {});
    const capture = await page.cdp.sendSession(page.sessionId, 'Page.captureScreenshot', cssScreenshotParams(runtime.viewport));
    const metrics = await page.cdp.sendSession(page.sessionId, 'Page.getLayoutMetrics');
    const viewport = metrics.cssLayoutViewport ?? metrics.layoutViewport;
    return {
      base64: typeof capture.data === 'string' ? capture.data : '',
      mime: 'image/png',
      width: Math.round(viewport?.clientWidth ?? runtime.viewport?.width ?? 0),
      height: Math.round(viewport?.clientHeight ?? runtime.viewport?.height ?? 0),
    };
  };

  // Clears only this chat's browser: its own throwaway context, or its
  // profile copy, never the saved profile a save would write into. Each
  // scope already owns one exclusive Chrome process, so a browser-wide CDP
  // command is scope-safe either way; the throwaway path still prefers the
  // context-scoped cookie call because it has a `browserContextId` to scope
  // it with. `Network.clearBrowser*` and `Network`-domain cookie commands
  // need an attached page session in this Chrome version (unlike
  // `Storage.getCookies`/`setCookies`, which work browser-wide); every scope
  // always has one once started, so these go through it. Chrome has no
  // per-context HTTP cache, so cache clearing is browser-wide plus the
  // visible tab's own origin storage (service worker caches, IndexedDB,
  // WebSQL), never its cookies.
  // The cookies of this browser, so another browser (a profile copy the chat
  // moves onto) can take over its logins. A browser that never started has none.
  // Partitioned cookies stay behind: replayed without their partition they
  // would become readable by every site.
  runtime.exportCookies = async () => {
    if (!cdp) return [];
    const request = {};
    if (!profile) request.browserContextId = contextId;
    const { cookies = [] } = await cdp.send('Storage.getCookies', request);
    return cookies
      .filter((cookie) => !cookie.partitionKey)
      .map(({ name, value, domain, path: cookiePath, secure, httpOnly, sameSite, expires, session, priority, sourceScheme, sourcePort }) => {
        const copied = { name, value, domain, path: cookiePath, secure, httpOnly, sameSite, priority, sourceScheme, sourcePort };
        if (!session) copied.expires = expires;
        return copied;
      });
  };
  runtime.importCookies = async (cookies) => {
    if (cookies.length === 0) return;
    await ensureStarted();
    const request = { cookies };
    if (!profile) request.browserContextId = contextId;
    await cdp.send('Storage.setCookies', request);
  };

  runtime.pageClear = async (what) => {
    const page = await runtime.ensurePage();
    requireNoDialog(activeTab());
    const send = (method, params) => page.cdp.sendSession(page.sessionId, method, params);
    if (what === 'cookies') {
      if (profile) {
        // `Network.clearBrowserCookies` is a no-op (no error, no effect)
        // until the Network domain is enabled for this session.
        await send('Network.enable');
        await send('Network.clearBrowserCookies');
      } else {
        await send('Storage.clearCookies', { browserContextId: contextId });
      }
      return;
    }
    if (what === 'cache') {
      await send('Network.enable');
      await send('Network.clearBrowserCache');
      const origin = (() => {
        try {
          return new URL(activeTab()?.url ?? '').origin;
        } catch {
          return null;
        }
      })();
      if (origin) {
        await send('Storage.clearDataForOrigin', {
          origin,
          storageTypes: 'cache_storage,indexeddb,websql,shader_cache,service_workers',
        }).catch(() => {});
      }
      return;
    }
    throw new Error('what must be "cookies" or "cache"');
  };

  runtime.perform = (action, parameters, callerSignal) => {
    if (closed) return Promise.reject(new Error('Browser runtime is closed'));
    if (runtime.controller === 'user') {
      return Promise.reject(new Error('The user controls the browser. Wait for them to hand control back.'));
    }
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, shutdownController.signal])
      : shutdownController.signal;
    const operation = actionQueue.catch(() => {}).then(async () => {
      signal.throwIfAborted();
      if (runtime.controller === 'user') {
        throw new Error('The user controls the browser. Wait for them to hand control back.');
      }
      await contextMenu.close();
      const dialogs = new AbortController();
      agentAction = { targetId: null, dialogs };
      runtime.agentActive = true;
      try {
        const data = await execute(action, parameters, AbortSignal.any([signal, dialogs.signal]));
        await (tabs.get(data?.tabId ?? parameters?.tabId) ?? activeTab())?.compatibility.whenIdle();
        return data;
      } finally {
        agentAction = null;
        runtime.agentActive = false;
      }
    });
    actionQueue = operation;
    return operation;
  };

  runtime.surfaceFrame = (request) => surface.frame(request);
  runtime.surfaceInput = (events, theme) => surface.input(events, theme);
  runtime.surfaceControl = (controller) => surface.control(controller);
  runtime.surfaceResize = (size) => surface.resize(size);
  runtime.surfaceClipboard = () => surface.clipboard();
  runtime.surfaceAudio = (request) => audio.batch(request);
  runtime.onDead = (listener) => {
    deathListeners.add(listener);
    return () => deathListeners.delete(listener);
  };
  runtime.onTabsChanged = (listener) => {
    tabListeners.add(listener);
    return () => tabListeners.delete(listener);
  };
  runtime.profile = profile ? { id: profile.id, name: profile.name } : null;
  // The profile version this browser's copy was taken at, once it started.
  Object.defineProperty(runtime, 'profileVersion', { get: () => profileVersion, enumerable: true });
  // `save` writes this browser's copy into its profile after Chrome has
  // written it to disk, and answers the profile's new version; a refused
  // save (another chat saved first) is thrown once everything is closed.
  runtime.close = async ({ save = false } = {}) => {
    if (closed) return null;
    closed = true;
    shutdownController.abort(new DOMException('Browser runtime stopped', 'AbortError'));
    // This Chrome serves this runtime alone, so nothing in it needs undoing.
    // Stopping it first keeps it from outliving a service the host is about to
    // kill, and fails the CDP calls that the work below may still wait on. A
    // profile's Chrome is asked to exit first so its cookie jar is written.
    await chrome?.close();
    let saved = null;
    let saveError = null;
    if (profileDirectory && save) {
      try {
        saved = await profile.checkin(profileDirectory, profileVersion);
      } catch (error) {
        saveError = error;
      }
    }
    await discardProfileDirectory();
    guardCleanup?.();
    cdp?.close();
    audio.close();
    await surface.close();
    inspector.close();
    await pageRequests.close();
    await downloads?.close();
    await pagePromise?.catch(() => {});
    await actionQueue.catch(() => {});
    eventCleanup?.();
    for (const current of tabs.values()) clearTimeout(current.navigationTimer);
    await proxy.close();
    contextId = null;
    tabs.clear();
    sessions.clear();
    activeTargetId = null;
    if (saveError) throw saveError;
    return saved;
  };

  return runtime;
};
