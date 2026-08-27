import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';

type ChildrenProps = { children?: React.ReactNode };
type AgentsSidebarProps = { onItemSelect?: () => void };
type SettingsPageLayoutProps = {
  children: React.ReactNode;
  title?: React.ReactNode;
  showSaveStatus?: boolean;
};

interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  namespaceURI: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: { setProperty: () => void; getPropertyValue: () => string };
  classList: FakeClassList;
  attributes: Map<string, string>;
  textContent: string;
  nodeValue: string | null;
  focusOptions?: FocusOptions;
  appendChild: (child: FakeNode) => FakeNode;
  insertBefore: (child: FakeNode, before: FakeNode | null) => FakeNode;
  removeChild: (child: FakeNode) => FakeNode;
  setAttribute: (name: string, value: string) => void;
  removeAttribute: (name: string) => void;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
  addEventListener: () => void;
  removeEventListener: () => void;
  contains: (child: FakeNode | null) => boolean;
  querySelector: (selector: string) => FakeNode | null;
  focus: (options?: FocusOptions) => void;
}

interface FakeDocument {
  nodeType: number;
  nodeName: string;
  defaultView: FakeWindow | null;
  body: FakeNode | null;
  documentElement: FakeNode | null;
  activeElement: FakeNode | null;
  createElement: (tag: string) => FakeNode & Element;
  createElementNS: (_namespace: string, tag: string) => FakeNode & Element;
  createTextNode: (text: string) => FakeNode & Element;
  addEventListener: () => void;
  removeEventListener: () => void;
}

interface FakeWindow {
  document: FakeDocument;
  navigator: { userAgent: string; platform: string; maxTouchPoints: number };
  history: { state: null; back: () => void; pushState: () => void };
  location: { href: string };
  requestAnimationFrame: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame: (frame: number) => void;
  addEventListener: () => void;
  removeEventListener: () => void;
  HTMLIFrameElement: typeof FakeElement;
  HTMLFrameSetElement: typeof FakeElement;
  HTMLInputElement: typeof FakeElement;
  HTMLTextAreaElement: typeof FakeElement;
  HTMLSelectElement: typeof FakeElement;
  HTMLOptionElement: typeof FakeElement;
  HTMLAnchorElement: typeof FakeElement;
}

type GlobalStubValue = FakeDocument | FakeWindow | FakeWindow['navigator'] | FakeWindow['location'] | typeof FakeElement | boolean;

class FakeElement {}

class FakeClassList {
  private readonly classes = new Set<string>();

  add(...classes: string[]) {
    classes.forEach((className) => this.classes.add(className));
  }

  remove(...classes: string[]) {
    classes.forEach((className) => this.classes.delete(className));
  }

  contains(className: string) {
    return this.classes.has(className);
  }
}

function makeNode(tag: string, ownerDocument: FakeDocument, nodeType = 1): FakeNode & Element {
  const attributes = new Map<string, string>();
  const properties: FakeNode = {
    nodeType,
    nodeName: nodeType === 3 ? '#text' : tag.toUpperCase(),
    tagName: nodeType === 3 ? '#text' : tag.toUpperCase(),
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument,
    parentNode: null,
    childNodes: [],
    style: {
      setProperty: () => {},
      getPropertyValue: () => '',
    },
    classList: new FakeClassList(),
    attributes,
    textContent: '',
    nodeValue: null,
    appendChild(child) {
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child, before) {
      const index = before ? this.childNodes.indexOf(before) : -1;
      if (index === -1) {
        this.childNodes.push(child);
      } else {
        this.childNodes.splice(index, 0, child);
      }
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index !== -1) {
        this.childNodes.splice(index, 1);
      }
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
    removeAttribute(name) {
      attributes.delete(name);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    hasAttribute(name) {
      return attributes.has(name);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    contains(child) {
      if (child === this) {
        return true;
      }
      return this.childNodes.some((nodeChild) => nodeChild.contains(child));
    },
    querySelector(selector) {
      if (selector !== '[data-settings-page-heading]') {
        return null;
      }
      if (this.hasAttribute('data-settings-page-heading')) {
        return this;
      }
      for (const child of this.childNodes) {
        const match = child.querySelector(selector);
        if (match) {
          return match;
        }
      }
      return null;
    },
    focus(options) {
      this.focusOptions = options;
      this.ownerDocument.activeElement = this;
    },
  };
  const node: FakeNode & Element = Object.assign(Object.create(FakeElement.prototype), properties);
  return node;
}

function installDomStub() {
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: GlobalStubValue) => {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 1;
  const documentStub: FakeDocument = {
    nodeType: 9,
    nodeName: '#document',
    defaultView: null,
    body: null,
    documentElement: null,
    activeElement: null,
    createElement: (tag) => makeNode(tag, documentStub),
    createElementNS: (_namespace, tag) => makeNode(tag, documentStub),
    createTextNode: (text) => {
      const node = makeNode('#text', documentStub, 3);
      node.nodeValue = text;
      node.textContent = text;
      return node;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const windowStub: FakeWindow = {
    document: documentStub,
    navigator: { userAgent: 'test', platform: 'test', maxTouchPoints: 0 },
    history: { state: null, back: () => {}, pushState: () => {} },
    location: { href: 'http://localhost/' },
    requestAnimationFrame: (callback) => {
      const frame = nextFrame;
      nextFrame += 1;
      frames.set(frame, callback);
      return frame;
    },
    cancelAnimationFrame: (frame) => {
      frames.delete(frame);
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    HTMLIFrameElement: FakeElement,
    HTMLFrameSetElement: FakeElement,
    HTMLInputElement: FakeElement,
    HTMLTextAreaElement: FakeElement,
    HTMLSelectElement: FakeElement,
    HTMLOptionElement: FakeElement,
    HTMLAnchorElement: FakeElement,
  };
  documentStub.defaultView = windowStub;
  documentStub.body = makeNode('body', documentStub);
  documentStub.documentElement = makeNode('html', documentStub);
  documentStub.activeElement = documentStub.body;

  setGlobal('document', documentStub);
  setGlobal('window', windowStub);
  setGlobal('navigator', windowStub.navigator);
  setGlobal('location', windowStub.location);
  setGlobal('Element', FakeElement);
  setGlobal('HTMLElement', FakeElement);
  setGlobal('HTMLIFrameElement', FakeElement);
  setGlobal('IS_REACT_ACT_ENVIRONMENT', true);

  return {
    container: documentStub.createElement('div'),
    document: documentStub,
    frameCount: () => frames.size,
    flushFrames: () => {
      const callbacks = Array.from(frames.values());
      frames.clear();
      callbacks.forEach((callback) => callback(Date.now()));
    },
    restore: () => {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          Reflect.deleteProperty(globalThis, name);
        }
      }
    },
  };
}

const Empty = () => null;
const uiStore = {
  settingsPage: 'agents',
  isSettingsDialogOpen: true,
  setSettingsPage: () => {},
};
type UiStoreValue = (typeof uiStore)[keyof typeof uiStore];
const agentsMeta = { slug: 'agents', title: 'Agents', group: 'opencode', kind: 'split' };
let sidebarOnItemSelect: (() => void) | undefined;
let SettingsPageLayout: React.ComponentType<SettingsPageLayoutProps> | null = null;

mock.module('@/lib/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getModifierLabel: () => 'Ctrl',
}));
mock.module('@/stores/useUIStore', () => ({
  useUIStore: (selector: (state: typeof uiStore) => UiStoreValue) => selector(uiStore),
}));
mock.module('@/hooks/useSettingsDirectory', () => ({ useSettingsDirectory: () => '/workspace' }));
mock.module('@/stores/useProjectsStore', () => ({
  useProjectsStore: (selector: (state: { activeProjectId: null }) => null) => selector({ activeProjectId: null }),
}));
mock.module('@/stores/useAgentsStore', () => ({
  refreshAfterOpenCodeRestart: async () => {},
  useAgentsStore: { getState: () => ({ loadAgents: async () => {} }) },
}));
mock.module('@/stores/useCommandsStore', () => ({ useCommandsStore: { getState: () => ({ loadCommands: async () => {} }) } }));
mock.module('@/stores/useMcpConfigStore', () => ({ useMcpConfigStore: { getState: () => ({ loadMcpConfigs: async () => {} }) } }));
mock.module('@/stores/useSnippetsStore', () => ({ useSnippetsStore: { getState: () => ({ loadSnippets: async () => {} }) } }));
mock.module('@/stores/useSkillsStore', () => ({ useSkillsStore: { getState: () => ({ loadSkills: async () => {} }) } }));
mock.module('@/stores/useSkillsCatalogStore', () => ({ useSkillsCatalogStore: { getState: () => ({ loadCatalog: async () => {} }) } }));
mock.module('@/stores/useConfigStore', () => ({ useConfigStore: { getState: () => ({ providers: [], setSelectedProvider: () => {} }) } }));
mock.module('@/stores/usePendingOpenCodeRestartStore', () => ({
  selectPendingOpenCodeRestartCount: () => 0,
  usePendingOpenCodeRestartStore: () => 0,
}));
mock.module('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: ChildrenProps) => <>{children}</>,
  TooltipTrigger: ({ children }: ChildrenProps) => <>{children}</>,
}));
mock.module('@/components/ui/ErrorBoundary', () => ({ ErrorBoundary: ({ children }: ChildrenProps) => <>{children}</> }));
mock.module('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: ChildrenProps) => <div>{children}</div> }));
mock.module('@/components/sections/shared/SettingsSection', () => ({
  SETTINGS_DESCRIPTION_CLASS: '',
  SETTINGS_PAGE_TITLE_CLASS: '',
  SETTINGS_SECTION_TITLE_CLASS: '',
}));
mock.module('@/lib/persistence', () => ({
  getSettingsSaveState: () => 'idle',
  subscribeToSettingsSaveState: () => () => {},
}));
mock.module('@/components/icon/Icon', () => ({ Icon: Empty }));
mock.module('@/components/icons/McpIcon', () => ({ McpIcon: Empty }));
mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/lib/device', () => ({
  useDeviceInfo: () => ({ isMobile: false }),
}));
mock.module('@/lib/desktop', () => ({
  getDesktopHomeDirectory: async () => null,
  isDesktopLocalOriginActive: () => false,
  isDesktopShell: () => false,
  isVSCodeRuntime: () => false,
  isWebRuntime: () => true,
}));
mock.module('@/lib/platform', () => ({ isWindowsArm64: () => false }));
mock.module('@/lib/settings/metadata', () => ({
  SETTINGS_PAGE_METADATA: [agentsMeta],
  getSettingsNavIcon: () => 'settings-3',
  getSettingsPageMeta: (slug: string) => slug === 'agents' ? agentsMeta : null,
  resolveSettingsSlug: (slug: string) => slug === 'agents' ? 'agents' : 'home',
}));
mock.module('@/lib/settings/search', () => ({ buildSettingsSearchResults: () => [] }));
mock.module('@/components/views/OpenCodeReloadFooterAction', () => ({ OpenCodeReloadFooterAction: Empty }));
mock.module('@/components/sections/agents/AgentsSidebar', () => ({
  AgentsSidebar: ({ onItemSelect }: AgentsSidebarProps) => {
    sidebarOnItemSelect = onItemSelect;
    return <button type="button" onClick={onItemSelect}>Duplicate</button>;
  },
}));
mock.module('@/components/sections/agents/AgentsPage', () => ({
  AgentsPage: () => {
    const Layout = SettingsPageLayout;
    if (!Layout) {
      throw new Error('SettingsPageLayout must load before SettingsView');
    }
    return <Layout title="New agent" showSaveStatus={false}><div /></Layout>;
  },
}));

for (const [module, exports] of [
  ['@/components/sections/behavior/BehaviorPage', ['BehaviorPage']],
  ['@/components/sections/commands/CommandsSidebar', ['CommandsSidebar']],
  ['@/components/sections/commands/CommandsPage', ['CommandsPage']],
  ['@/components/sections/mcp/McpSidebar', ['McpSidebar']],
  ['@/components/sections/mcp/McpPage', ['McpPage']],
  ['@/components/sections/plugins', ['PluginsSidebar', 'PluginsPage']],
  ['@/components/sections/skills/SkillsSidebar', ['SkillsSidebar']],
  ['@/components/sections/skills/SkillsPage', ['SkillsPage']],
  ['@/components/sections/projects/ProjectsSidebar', ['ProjectsSidebar']],
  ['@/components/sections/projects/ProjectsPage', ['ProjectsPage']],
  ['@/components/sections/remote-instances/RemoteInstancesPage', ['RemoteInstancesPage']],
  ['@/components/sections/providers/ProvidersSidebar', ['ProvidersSidebar']],
  ['@/components/sections/providers/ProvidersPage', ['ProvidersPage']],
  ['@/components/sections/usage/UsageSidebar', ['UsageSidebar']],
  ['@/components/sections/usage/UsagePage', ['UsagePage']],
  ['@/components/sections/magic-prompts/MagicPromptsSidebar', ['MagicPromptsSidebar']],
  ['@/components/sections/magic-prompts/MagicPromptsPage', ['MagicPromptsPage']],
  ['@/components/sections/snippets/SnippetsSidebar', ['SnippetsSidebar']],
  ['@/components/sections/snippets/SnippetsPage', ['SnippetsPage']],
  ['@/components/sections/git-identities/GitPage', ['GitPage']],
  ['@/components/sections/integrations/IntegrationsPage', ['IntegrationsPage']],
  ['@/components/sections/openchamber/OpenChamberPage', ['OpenChamberPage']],
  ['@/components/sections/openchamber/AboutSettings', ['AboutSettings']],
] as const) {
  mock.module(module, () => Object.fromEntries(exports.map((name) => [name, Empty])));
}

SettingsPageLayout = (await import('../sections/shared/SettingsPageLayout')).SettingsPageLayout;
const { SettingsView } = await import('./SettingsView');

describe('SettingsView mobile split-page focus', () => {
  test('focuses the rendered editor heading after a mobile sidebar selection', async () => {
    const dom = installDomStub();
    const root: Root = createRoot(dom.container);
    sidebarOnItemSelect = undefined;

    try {
      await act(async () => {
        root.render(<SettingsView forceMobile initialMobileStage="page-sidebar" />);
      });

      expect(sidebarOnItemSelect).toBeDefined();
      await act(async () => {
        sidebarOnItemSelect?.();
      });

      const heading = dom.container.querySelector('[data-settings-page-heading]');
      expect(heading).not.toBeNull();
      expect(heading?.getAttribute('tabindex')).toBe('-1');
      expect(dom.document.activeElement).toBe(dom.document.body);
      expect(dom.frameCount()).toBe(1);

      await act(async () => {
        dom.flushFrames();
      });

      expect(dom.document.activeElement).toBe(heading);
      expect(heading?.focusOptions).toEqual({ preventScroll: true });
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.restore();
    }
  });

  test('does not pass the mobile selection callback to desktop split pages', async () => {
    const dom = installDomStub();
    const root: Root = createRoot(dom.container);
    sidebarOnItemSelect = undefined;

    try {
      await act(async () => {
        root.render(<SettingsView forceMobile={false} />);
      });

      expect(sidebarOnItemSelect).toBe(undefined);
      expect(dom.frameCount()).toBe(0);
    } finally {
      await act(async () => {
        root.unmount();
      });
      dom.restore();
    }
  });
});
