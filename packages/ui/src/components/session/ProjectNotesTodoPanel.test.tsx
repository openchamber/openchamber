import { expect, mock, test } from "bun:test";
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const initialTodos = [
  { id: "todo-1", text: "First todo", completed: false, createdAt: 1 },
  { id: "todo-2", text: "Finished todo", completed: true, createdAt: 2 },
];

const savedTodoLists: Array<typeof initialTodos> = [];

mock.module("@/lib/openchamberConfig", () => ({
  OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH: 3000,
  OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH: 120,
  getProjectContextData: async () => ({ notes: "", todos: initialTodos, plans: [] }),
  saveProjectNotesAndTodos: async (_project: unknown, value: { todos: typeof initialTodos }) => {
    savedTodoLists.push(value.todos);
    return true;
  },
  readProjectPlanFile: async () => null,
  deleteProjectPlanFile: async () => true,
  importProjectPlanFileFromContent: async () => null,
}));

const translate = (key: string) => key;
mock.module("@/lib/i18n", () => ({
  getCurrentIntlLocale: () => "en",
  useI18n: () => ({ t: translate }),
  I18nProvider: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, React.Children.toArray(children)),
}));

mock.module("@dnd-kit/core", () => ({
  DndContext: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, React.Children.toArray(children)),
  PointerSensor: class PointerSensor {},
  closestCenter: () => null,
  useSensor: () => ({}),
  useSensors: (...sensors: unknown[]) => sensors,
}));
mock.module("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, React.Children.toArray(children)),
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    setActivatorNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
  verticalListSortingStrategy: {},
  arrayMove: <T,>(items: T[]) => items,
}));
mock.module("@dnd-kit/utilities", () => ({ CSS: { Transform: { toString: () => undefined } } }));
mock.module("@/components/ui", () => ({ toast: { error: () => {}, success: () => {} } }));
mock.module("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) => (
    React.createElement("input", {
      type: "checkbox",
      checked,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.checked),
    })
  ),
}));
mock.module("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => (
    React.createElement(React.Fragment, null, React.Children.toArray(children))
  ),
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => (
    React.createElement(React.Fragment, null, React.Children.toArray(children))
  ),
  DropdownMenuItem: ({ children, onClick }: React.PropsWithChildren<{ onClick: () => void }>) => (
    React.createElement("button", { onClick }, children)
  ),
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, React.Children.toArray(children)),
}));
mock.module("@/components/ui/input", () => ({ Input: (props: React.ComponentProps<"input">) => React.createElement("input", props) }));
type MockTextareaProps = React.ComponentProps<"textarea"> & {
  resizedHeight?: number;
  onResizeHeightChange?: (height: number) => void;
  useScrollShadow?: boolean;
  scrollShadowSize?: number;
};

function stripTextareaProps(props: MockTextareaProps): React.ComponentProps<"textarea"> {
  const cleanProps = { ...props };
  for (const key of ["resizedHeight", "onResizeHeightChange", "useScrollShadow", "scrollShadowSize"]) {
    delete (cleanProps as unknown as Record<string, unknown>)[key];
  }
  return cleanProps;
}

mock.module("@/components/ui/textarea", () => ({
  Textarea: (props: MockTextareaProps) => React.createElement("textarea", stripTextareaProps(props)),
}));
mock.module("@/components/icon/Icon", () => ({ Icon: () => React.createElement("span") }));
mock.module("@/lib/utils", () => ({ cn: (...values: unknown[]) => values.filter(Boolean).join(" ") }));
mock.module("@/lib/desktop", () => ({ requestFileAccess: async () => ({ success: false, error: "Native file picker not available" }) }));
mock.module("@/lib/git/branchNameGenerator", () => ({ generateBranchName: () => "todo-branch" }));
mock.module("@/lib/worktreeSessionCreator", () => ({ createWorktreeSessionForNewBranch: async () => null }));
mock.module("@/lib/magicPrompts", () => ({ renderMagicPrompt: async () => "" }));
mock.module("@/lib/runtime-fetch", () => ({ runtimeFetch: async () => new Response("", { status: 500 }) }));
mock.module("./TodoSendDialog", () => ({ TodoSendDialog: () => null }));

const uiState = {
  todoPanelHeight: 240,
  setTodoPanelHeight: () => {},
  notesPanelHeight: 240,
  setNotesPanelHeight: () => {},
  openContextPanelTab: () => {},
  setActiveMainTab: () => {},
  setSessionSwitcherOpen: () => {},
  padding: 100,
};
mock.module("@/stores/useUIStore", () => ({
  useUIStore: <T,>(selector: (state: typeof uiState) => T) => selector(uiState),
}));
const sessionUiState = {
  currentSessionId: null,
  createSession: async () => null,
  initializeNewOpenChamberSession: () => {},
  sendMessage: async () => {},
  setCurrentSession: () => {},
};
mock.module("@/sync/session-ui-store", () => ({
  useSessionUIStore: <T,>(selector: (state: typeof sessionUiState) => T) => selector(sessionUiState),
}));
mock.module("@/sync/input-store", () => ({
  useInputStore: <T,>(selector: (state: { setPendingInputText: () => void }) => T) => selector({ setPendingInputText: () => {} }),
}));
mock.module("@/stores/useDirectoryStore", () => ({
  useDirectoryStore: <T,>(selector: (state: { currentDirectory: string }) => T) => selector({ currentDirectory: "/project" }),
}));
mock.module("@/stores/useConfigStore", () => ({ useConfigStore: { getState: () => ({ agents: [] }) } }));
mock.module("@/sync/selection-store", () => ({
  useSelectionStore: {
    getState: () => ({
      saveSessionModelSelection: () => {},
      saveSessionAgentSelection: () => {},
      saveAgentModelForSession: () => {},
      saveAgentModelVariantForSession: () => {},
    }),
  },
}));

interface FakeNode {
  nodeType: number;
  nodeName: string;
  tagName: string;
  ownerDocument: FakeDocument;
  parentNode: FakeNode | null;
  childNodes: FakeNode[];
  style: Record<string, unknown>;
  classList: FakeClassList;
  [key: string]: unknown;
}

interface FakeDocument extends FakeNode {
  defaultView: FakeWindow;
  body: FakeNode;
  documentElement: FakeNode;
  createElement(tag: string): FakeNode;
  createElementNS(_: string, tag: string): FakeNode;
  createTextNode(text: string): FakeNode;
  getElementById(_: string): FakeNode | null;
  activeElement: FakeNode | null;
  HTMLIFrameElement: unknown;
  HTMLFrameSetElement: unknown;
  HTMLInputElement: unknown;
  HTMLTextAreaElement: unknown;
  HTMLSelectElement: unknown;
  HTMLOptionElement: unknown;
  HTMLAnchorElement: unknown;
}

interface FakeWindow {
  document: FakeDocument;
  event: unknown;
  navigator: { userAgent: string; platform: string; maxTouchPoints: number };
  matchMedia(query: string): { matches: boolean; addEventListener(): void; removeEventListener(): void };
  addEventListener(): void;
  removeEventListener(): void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  HTMLIFrameElement: unknown;
  HTMLFrameSetElement: unknown;
  HTMLInputElement: unknown;
  HTMLTextAreaElement: unknown;
  HTMLSelectElement: unknown;
  HTMLOptionElement: unknown;
  HTMLAnchorElement: unknown;
}

class FakeClassList {
  private readonly classes = new Set<string>();

  add(...classes: string[]): void {
    classes.forEach((value) => this.classes.add(value));
  }

  remove(...classes: string[]): void {
    classes.forEach((value) => this.classes.delete(value));
  }

  contains(value: string): boolean {
    return this.classes.has(value);
  }

  toString(): string {
    return [...this.classes].join(" ");
  }
}

function makeNode(tag: string, ownerDocument: FakeDocument): FakeNode {
  const style: Record<string, unknown> = {
    setProperty() { /* noop */ },
    getPropertyValue() { return ""; },
  };
  const node: FakeNode = {
    nodeType: 1,
    nodeName: tag.toUpperCase(),
    tagName: tag.toUpperCase(),
    ownerDocument,
    parentNode: null,
    childNodes: [],
    style,
    classList: new FakeClassList(),
    setAttribute() { /* noop */ },
    removeAttribute() { /* noop */ },
    hasAttribute() { return false; },
    getAttribute() { return null; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    appendChild(child: FakeNode) {
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    insertBefore(child: FakeNode, reference: FakeNode) {
      const index = this.childNodes.indexOf(reference);
      if (index < 0) this.childNodes.push(child); else this.childNodes.splice(index, 0, child);
      child.parentNode = this;
      return child;
    },
    removeChild(child: FakeNode) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    },
    replaceChild(child: FakeNode, previous: FakeNode) {
      const index = this.childNodes.indexOf(previous);
      if (index >= 0) this.childNodes.splice(index, 1, child);
      child.parentNode = this;
      previous.parentNode = null;
      return previous;
    },
    contains() { return false; },
    cloneNode() { return node; },
    compareDocumentPosition() { return 0; },
    focus() { /* noop */ },
    blur() { /* noop */ },
    click() { /* noop */ },
    textContent: "",
    innerHTML: "",
  };
  return node;
}

function installDomStub(): { document: FakeDocument; restore: () => void } {
  const document = {
    nodeType: 9,
    nodeName: "#document",
    tagName: "#document",
    ownerDocument: undefined,
    parentNode: null,
    childNodes: [],
    style: {},
    classList: new FakeClassList(),
    setAttribute() { /* noop */ },
    getAttribute() { return null; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    appendChild() { return undefined; },
    insertBefore() { return undefined; },
    removeChild() { return undefined; },
    replaceChild() { return undefined; },
    getElementById() { return null; },
    createTextNode(text: string) {
      return { nodeType: 3, nodeName: "#text", textContent: text, parentNode: null } as unknown as FakeNode;
    },
    createElement(tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    createElementNS(_: string, tag: string) { return makeNode(tag, document as unknown as FakeDocument); },
    activeElement: null,
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class { setSelectionRange() { /* noop */ } },
    HTMLTextAreaElement: class { setSelectionRange() { /* noop */ } },
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  } as unknown as FakeDocument;

  document.defaultView = {
    document,
    event: { type: "test" },
    navigator: { userAgent: "test", platform: "test", maxTouchPoints: 0 },
    matchMedia() { return { matches: false, addEventListener() {}, removeEventListener() {} }; },
    addEventListener() { /* noop */ },
    removeEventListener() { /* noop */ },
    setTimeout,
    clearTimeout,
    HTMLIFrameElement: class {},
    HTMLFrameSetElement: class {},
    HTMLInputElement: class { setSelectionRange() { /* noop */ } },
    HTMLTextAreaElement: class { setSelectionRange() { /* noop */ } },
    HTMLSelectElement: class {},
    HTMLOptionElement: class {},
    HTMLAnchorElement: class {},
  } as unknown as FakeWindow;
  document.body = makeNode("body", document);
  document.documentElement = makeNode("html", document);

  const globals = globalThis as unknown as {
    document?: FakeDocument;
    window?: FakeWindow;
    navigator?: FakeWindow["navigator"];
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previous = {
    document: globals.document,
    window: globals.window,
    navigator: globals.navigator,
    IS_REACT_ACT_ENVIRONMENT: globals.IS_REACT_ACT_ENVIRONMENT,
  };

  globals.IS_REACT_ACT_ENVIRONMENT = true;
  globals.document = document;
  globals.window = document.defaultView;
  globals.navigator = document.defaultView.navigator;

  return {
    document,
    restore() {
      globals.document = previous.document;
      globals.window = previous.window;
      globals.navigator = previous.navigator;
      globals.IS_REACT_ACT_ENVIRONMENT = previous.IS_REACT_ACT_ENVIRONMENT;
    },
  };
}

type ReactProps = Record<string, unknown>;

function reactProps(node: FakeNode): ReactProps {
  const key = Object.keys(node).find((name) => name.startsWith("__reactProps"));
  if (!key) throw new Error("Expected a React props record");
  return node[key] as ReactProps;
}

function findNode(container: FakeNode, predicate: (props: ReactProps) => boolean): FakeNode {
  const visit = (node: FakeNode): FakeNode | null => {
    const propsKey = Object.keys(node).find((name) => name.startsWith("__reactProps"));
    if (propsKey && predicate(node[propsKey] as ReactProps)) {
      return node;
    }
    for (const child of node.childNodes ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  const found = visit(container);
  if (!found) throw new Error("Expected matching node");
  return found;
}

function findTodoLabel(container: FakeNode): FakeNode {
  return findNode(container, (props) => (
    props.title === "First todo"
    || props["aria-label"] === "rightSidebar.contextNotesTodo.todo.actions.expand"
    || props["aria-label"] === "rightSidebar.contextNotesTodo.todo.actions.collapse"
  ));
}

function findEditingInput(container: FakeNode): FakeNode {
  return findNode(container, (props) => props.autoFocus === true && typeof props.onBlur === "function");
}

interface MountedPanel {
  container: FakeNode;
  startEditingFirstTodo(): Promise<void>;
  changeEditingText(text: string): Promise<void>;
  editingInput(): FakeNode;
  blurEditingInput(): Promise<void>;
  keyDownEditingInput(key: string): Promise<void>;
  unmount(): void;
}

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function flushReactWork(): Promise<void> {
  await flushReact();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  act(() => {});
  await flushReact();
}

async function mountPanel(): Promise<MountedPanel> {
  const stub = installDomStub();
  const module = await import("./ProjectNotesTodoPanel");
  const container = stub.document.createElement("div");
  const root: Root = createRoot(container as unknown as Element);
  const projectRef = { id: "project-1", path: "/project" };

  act(() => {
    root.render(React.createElement(module.ProjectNotesTodoPanel, { projectRef }));
  });
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
  await flushReactWork();
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const findInput = (): FakeNode => findEditingInput(container);

  return {
    container,
    async startEditingFirstTodo() {
      act(() => {
        (reactProps(findTodoLabel(container)).onDoubleClick as () => void)();
      });
      await flushReactWork();
    },
    async changeEditingText(text: string) {
      act(() => {
        const props = reactProps(findInput());
        (props.onChange as (event: { target: { value: string } }) => void)({ target: { value: text } });
      });
      await flushReactWork();
    },
    editingInput: findInput,
    async blurEditingInput() {
      act(() => {
        const onBlur = reactProps(findInput()).onBlur as (() => void) | undefined;
        onBlur?.();
      });
      await flushReactWork();
    },
    async keyDownEditingInput(key: string) {
      act(() => {
        const props = reactProps(findInput());
        (props.onKeyDown as (event: { key: string; preventDefault(): void }) => void)({
          key,
          preventDefault() { /* noop */ },
        });
      });
      await flushReactWork();
    },
    unmount() {
      try {
        act(() => root.unmount());
      } finally {
        stub.restore();
      }
    },
  };
}

test("single click still expands todo text", async () => {
  savedTodoLists.length = 0;
  const panel = await mountPanel();
  try {
    const label = findTodoLabel(panel.container);
    act(() => {
      (reactProps(label).onClick as () => void)();
    });
    expect(reactProps(findTodoLabel(panel.container))["aria-label"])
      .toBe("rightSidebar.contextNotesTodo.todo.actions.collapse");
  } finally {
    panel.unmount();
  }
});

test("double click replaces todo label with focused inline input", async () => {
  savedTodoLists.length = 0;
  const panel = await mountPanel();
  try {
    act(() => {
      // Browsers dispatch two click events before the dblclick event. This
      // verifies that existing expansion toggles return to the original state.
      const label = findTodoLabel(panel.container);
      (reactProps(label).onClick as () => void)();
      (reactProps(findTodoLabel(panel.container)).onClick as () => void)();
      (reactProps(findTodoLabel(panel.container)).onDoubleClick as () => void)();
    });
    await flushReactWork();
    const input = findEditingInput(panel.container);
    expect(reactProps(input).value).toBe("First todo");
    expect(reactProps(input).autoFocus).toBe(true);
    expect(reactProps(input)["aria-label"]).toBe("First todo");
  } finally {
    panel.unmount();
  }
});

test("Enter trims and saves only edited todo text", async () => {
  savedTodoLists.length = 0;
  const panel = await mountPanel();
  try {
    await panel.startEditingFirstTodo();
    await panel.changeEditingText("  Updated todo  ");
    const staleBlur = reactProps(panel.editingInput()).onBlur as () => void;
    await panel.keyDownEditingInput("Enter");
    staleBlur();
    expect(savedTodoLists.at(-1)).toEqual([
      { id: "todo-1", text: "Updated todo", completed: false, createdAt: 1 },
      initialTodos[1],
    ]);
    expect(savedTodoLists).toHaveLength(1);
  } finally {
    panel.unmount();
  }
});

test("blur saves, Escape cancels, blank edits preserve text, and input caps length", async () => {
  savedTodoLists.length = 0;
  const panel = await mountPanel();
  try {
    await panel.startEditingFirstTodo();
    await panel.changeEditingText("Blurred edit");
    await panel.blurEditingInput();
    expect(savedTodoLists.at(-1)?.[0]?.text).toBe("Blurred edit");

    await panel.startEditingFirstTodo();
    await panel.changeEditingText("Discard me");
    await panel.keyDownEditingInput("Escape");
    expect(savedTodoLists.at(-1)?.[0]?.text).toBe("Blurred edit");

    await panel.startEditingFirstTodo();
    await panel.changeEditingText("   ");
    await panel.keyDownEditingInput("Enter");
    expect(savedTodoLists.at(-1)?.[0]?.text).toBe("Blurred edit");

    await panel.startEditingFirstTodo();
    await panel.changeEditingText("x".repeat(121));
    expect(reactProps(panel.editingInput()).value).toBe("x".repeat(120));
  } finally {
    panel.unmount();
  }
});
