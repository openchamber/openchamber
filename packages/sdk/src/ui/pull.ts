import { clearNode, ensureStyle } from './dom.ts';
import { icon } from './icons.ts';
import { createChoiceMenu, placeFixedMenu } from './menu.ts';
import { UI_CSS } from './style.ts';
import type {
  IssueCardComment,
  IssueFilterOption,
  PullRequestChange,
  PullRequestCheck,
  PullRequestCreateValues,
  PullRequestHandle,
  PullRequestLabels,
  PullRequestMergeMethod,
  PullRequestProps,
  PullRequestRecord,
  PullRequestState,
  PullRequestTab,
} from './types.ts';

const DEFAULT_LABELS: PullRequestLabels = {
  title: 'Pull request',
  open: 'Open',
  refresh: 'Refresh',
  overview: 'Overview',
  changes: 'Changes',
  checks: 'Checks',
  comments: 'Comments',
  attach: 'Attach',
  startSession: 'New session',
  startWorktree: 'New worktree',
  markReady: 'Ready for review',
  merge: 'Merge',
  mergeSquash: 'Squash',
  mergeMerge: 'Merge',
  mergeRebase: 'Rebase',
  sendFailedChecks: 'Send failed checks',
  sendComments: 'Send comments',
  emptyDescription: 'No description',
  emptyChanges: 'No changes',
  emptyChecks: 'No checks',
  emptyComments: 'No comments',
  notMergeable: 'Not mergeable',
  stateOpen: 'open',
  stateDraft: 'draft',
  stateMerged: 'merged',
  stateClosed: 'closed',
  createTitle: 'Title',
  createDescription: 'Description',
  createHead: 'Source',
  createBase: 'Target',
  createEmptyBranch: 'Pick a branch',
  createDraft: 'Create as draft',
  createSubmit: 'Create pull request',
  save: 'Save',
  back: 'Back',
  busy: 'Loading…',
};

const emptyCreate = (): PullRequestCreateValues => ({
  title: '',
  description: '',
  head: '',
  base: '',
  draft: false,
});

export const resolvePullRequestLabels = (
  labels: Partial<PullRequestLabels> | undefined,
): PullRequestLabels => ({
  title: labels?.title ?? DEFAULT_LABELS.title,
  open: labels?.open ?? DEFAULT_LABELS.open,
  refresh: labels?.refresh ?? DEFAULT_LABELS.refresh,
  overview: labels?.overview ?? DEFAULT_LABELS.overview,
  changes: labels?.changes ?? DEFAULT_LABELS.changes,
  checks: labels?.checks ?? DEFAULT_LABELS.checks,
  comments: labels?.comments ?? DEFAULT_LABELS.comments,
  attach: labels?.attach ?? DEFAULT_LABELS.attach,
  startSession: labels?.startSession ?? DEFAULT_LABELS.startSession,
  startWorktree: labels?.startWorktree ?? DEFAULT_LABELS.startWorktree,
  markReady: labels?.markReady ?? DEFAULT_LABELS.markReady,
  merge: labels?.merge ?? DEFAULT_LABELS.merge,
  mergeSquash: labels?.mergeSquash ?? DEFAULT_LABELS.mergeSquash,
  mergeMerge: labels?.mergeMerge ?? DEFAULT_LABELS.mergeMerge,
  mergeRebase: labels?.mergeRebase ?? DEFAULT_LABELS.mergeRebase,
  sendFailedChecks: labels?.sendFailedChecks ?? DEFAULT_LABELS.sendFailedChecks,
  sendComments: labels?.sendComments ?? DEFAULT_LABELS.sendComments,
  emptyDescription: labels?.emptyDescription ?? DEFAULT_LABELS.emptyDescription,
  emptyChanges: labels?.emptyChanges ?? DEFAULT_LABELS.emptyChanges,
  emptyChecks: labels?.emptyChecks ?? DEFAULT_LABELS.emptyChecks,
  emptyComments: labels?.emptyComments ?? DEFAULT_LABELS.emptyComments,
  notMergeable: labels?.notMergeable ?? DEFAULT_LABELS.notMergeable,
  stateOpen: labels?.stateOpen ?? DEFAULT_LABELS.stateOpen,
  stateDraft: labels?.stateDraft ?? DEFAULT_LABELS.stateDraft,
  stateMerged: labels?.stateMerged ?? DEFAULT_LABELS.stateMerged,
  stateClosed: labels?.stateClosed ?? DEFAULT_LABELS.stateClosed,
  createTitle: labels?.createTitle ?? DEFAULT_LABELS.createTitle,
  createDescription: labels?.createDescription ?? DEFAULT_LABELS.createDescription,
  createHead: labels?.createHead ?? DEFAULT_LABELS.createHead,
  createBase: labels?.createBase ?? DEFAULT_LABELS.createBase,
  createEmptyBranch: labels?.createEmptyBranch ?? DEFAULT_LABELS.createEmptyBranch,
  createDraft: labels?.createDraft ?? DEFAULT_LABELS.createDraft,
  createSubmit: labels?.createSubmit ?? DEFAULT_LABELS.createSubmit,
  save: labels?.save ?? DEFAULT_LABELS.save,
  back: labels?.back ?? DEFAULT_LABELS.back,
  busy: labels?.busy ?? DEFAULT_LABELS.busy,
});

const stateLabel = (state: PullRequestState, copy: PullRequestLabels): string => {
  if (state === 'draft') return copy.stateDraft;
  if (state === 'merged') return copy.stateMerged;
  if (state === 'closed') return copy.stateClosed;
  return copy.stateOpen;
};

export const pullRequestStatusText = (
  pull: PullRequestRecord,
  copy: PullRequestLabels,
): string => {
  const parts = [stateLabel(pull.state, copy)];
  if (pull.mergeable === false) {
    parts.push(copy.notMergeable);
  }
  return parts.join(' · ');
};

export const mergePullCreateValues = (
  current: PullRequestCreateValues,
  next: Partial<PullRequestCreateValues> | undefined,
): PullRequestCreateValues => ({
  ...current,
  ...next,
});

export const branchPickerOptions = (branches: readonly string[]): IssueFilterOption[] => (
  branches.map((name) => ({ id: name, label: name }))
);

const branchPickerLabel = (
  value: string,
  branches: readonly string[],
  busy: boolean,
  copy: PullRequestLabels,
): string => {
  if (value) {
    return value;
  }
  if (busy && branches.length === 0) {
    return copy.busy;
  }
  return copy.createEmptyBranch;
};

export const clampPullCreate = (values: PullRequestCreateValues): PullRequestCreateValues | null => {
  const title = values.title.trim();
  const head = values.head.trim();
  const base = values.base.trim();
  if (!title || !head || !base) {
    return null;
  }
  return {
    title,
    description: values.description.trim(),
    head,
    base,
    draft: values.draft,
  };
};

export const failedPullChecks = (checks: readonly PullRequestCheck[]): PullRequestCheck[] => (
  checks.filter((check) => check.state === 'failure')
);

type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

export const classifyDiffLine = (line: string): DiffLineKind => {
  if (
    line.startsWith('+++')
    || line.startsWith('---')
    || line.startsWith('diff ')
    || line.startsWith('index ')
  ) {
    return 'meta';
  }
  if (line.startsWith('@@')) {
    return 'hunk';
  }
  if (line.startsWith('+')) {
    return 'add';
  }
  if (line.startsWith('-')) {
    return 'del';
  }
  return 'ctx';
};

const paintChanges = (
  root: HTMLElement,
  changes: readonly PullRequestChange[],
  copy: PullRequestLabels,
): void => {
  if (changes.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'oc-sdk-card-muted';
    empty.textContent = copy.emptyChanges;
    root.append(empty);
    return;
  }
  for (const file of changes) {
    const card = document.createElement('div');
    card.className = 'oc-sdk-pr-file';
    const path = document.createElement('div');
    path.className = 'oc-sdk-pr-file-path';
    path.textContent = file.path;
    card.append(path);
    if (file.diff.trim()) {
      const code = document.createElement('pre');
      code.className = 'oc-sdk-pr-diff';
      for (const line of file.diff.replace(/\r\n/g, '\n').split('\n')) {
        const row = document.createElement('div');
        row.className = 'oc-sdk-pr-diff-line';
        row.dataset.kind = classifyDiffLine(line);
        row.textContent = line === '' ? ' ' : line;
        code.append(row);
      }
      card.append(code);
    }
    root.append(card);
  }
};

const appendField = (
  root: HTMLElement,
  label: string,
  value: string,
  onChange: (next: string) => void,
  area = false,
): void => {
  const field = document.createElement('label');
  field.className = 'oc-sdk-field';
  const caption = document.createElement('span');
  caption.className = 'oc-sdk-field-label';
  caption.textContent = label;
  if (area) {
    const input = document.createElement('textarea');
    input.className = 'oc-sdk-field-area';
    input.value = value;
    input.addEventListener('input', () => {
      onChange(input.value);
    });
    field.append(caption, input);
  } else {
    const input = document.createElement('input');
    input.className = 'oc-sdk-field-input';
    input.type = 'text';
    input.value = value;
    input.addEventListener('input', () => {
      onChange(input.value);
    });
    field.append(caption, input);
  }
  root.append(field);
};

const paintComments = (
  root: HTMLElement,
  comments: readonly IssueCardComment[],
  copy: PullRequestLabels,
): void => {
  if (comments.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'oc-sdk-card-muted';
    empty.textContent = copy.emptyComments;
    root.append(empty);
    return;
  }
  const thread = document.createElement('div');
  thread.className = 'oc-sdk-card-thread';
  comments.forEach((comment, index) => {
    const row = document.createElement('div');
    row.className = 'oc-sdk-card-comment';
    if (index < comments.length - 1) {
      const line = document.createElement('div');
      line.className = 'oc-sdk-card-comment-line';
      row.append(line);
    }
    const avatar = document.createElement('div');
    avatar.className = 'oc-sdk-card-avatar';
    avatar.textContent = comment.author.trim().charAt(0).toUpperCase() || '?';
    const bubble = document.createElement('div');
    bubble.className = 'oc-sdk-card-bubble';
    const meta = document.createElement('div');
    meta.className = 'oc-sdk-card-comment-meta';
    const author = document.createElement('span');
    author.className = 'oc-sdk-card-comment-author';
    author.textContent = comment.author;
    meta.append(author);
    if (comment.createdAt) {
      const when = document.createElement('span');
      when.textContent = comment.createdAt;
      meta.append(when);
    }
    bubble.append(meta);
    if (comment.body.trim()) {
      const bodyText = document.createElement('div');
      bodyText.className = 'oc-sdk-card-description';
      bodyText.textContent = comment.body;
      bubble.append(bodyText);
    }
    row.append(avatar, bubble);
    thread.append(row);
  });
  root.append(thread);
};

const paintChecks = (
  root: HTMLElement,
  checks: readonly PullRequestCheck[],
  copy: PullRequestLabels,
): void => {
  if (checks.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'oc-sdk-card-muted';
    empty.textContent = copy.emptyChecks;
    root.append(empty);
    return;
  }
  for (const check of checks) {
    const row = document.createElement('div');
    row.className = 'oc-sdk-pr-check';
    row.dataset.state = check.state;
    const name = document.createElement('div');
    name.className = 'oc-sdk-pr-check-name';
    const dot = document.createElement('span');
    dot.className = 'oc-sdk-pr-dot';
    dot.dataset.state = check.state;
    name.append(dot, document.createTextNode(` ${check.name}`));
    row.append(name);
    if (check.detail) {
      const detail = document.createElement('div');
      detail.className = 'oc-sdk-pr-check-detail';
      detail.textContent = check.detail;
      row.append(detail);
    }
    root.append(row);
  }
};

const button = (
  label: string,
  variant: 'default' | 'secondary' | 'ghost',
  onClick: () => void,
  disabled: boolean,
): HTMLButtonElement => {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'oc-sdk-btn';
  node.dataset.variant = variant;
  node.textContent = label;
  node.disabled = disabled;
  node.addEventListener('click', () => {
    if (node.disabled) {
      return;
    }
    onClick();
  });
  return node;
};

export const mountPullRequest = (root: Element, initial: PullRequestProps): PullRequestHandle => {
  ensureStyle(UI_CSS);
  let props = initial;
  let tab: PullRequestTab = 'overview';
  let mergeMethod: PullRequestMergeMethod = 'squash';
  let createValues: PullRequestCreateValues = {
    ...emptyCreate(),
    ...initial.create?.values,
  };
  let editTitle = initial.pull?.title ?? '';
  let editBody = initial.pull?.body ?? '';
  let openPicker: 'head' | 'base' | null = null;
  let menu: HTMLDivElement | null = null;
  let openTrigger: HTMLButtonElement | null = null;

  const shell = document.createElement('div');
  shell.className = 'oc-sdk-pr';
  root.append(shell);

  const removeMenu = (): void => {
    menu?.remove();
    menu = null;
    openTrigger = null;
  };

  const placeMenu = (): void => {
    if (!menu || !openTrigger) {
      return;
    }
    placeFixedMenu(menu, openTrigger);
  };

  const appendBranchPicker = (
    root: HTMLElement,
    id: 'head' | 'base',
    label: string,
    value: string,
    branches: readonly string[],
    copy: PullRequestLabels,
    onPick: (next: string) => void,
  ): void => {
    const pick = document.createElement('div');
    pick.className = 'oc-sdk-pr-pick';
    const caption = document.createElement('span');
    caption.className = 'oc-sdk-field-label';
    caption.textContent = label;
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'oc-sdk-pr-pick-trigger';
    trigger.setAttribute('aria-label', label);
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', openPicker === id ? 'true' : 'false');
    trigger.dataset.open = openPicker === id ? 'true' : 'false';
    trigger.dataset.empty = value ? 'false' : 'true';
    trigger.disabled = Boolean(props.busy) || branches.length === 0;
    const captionValue = document.createElement('span');
    captionValue.className = 'oc-sdk-pr-pick-value';
    captionValue.textContent = branchPickerLabel(value, branches, Boolean(props.busy), copy);
    trigger.append(captionValue, icon('chevron', 16, 'oc-sdk-filter-chevron'));
    trigger.addEventListener('click', () => {
      if (trigger.disabled) {
        return;
      }
      openPicker = openPicker === id ? null : id;
      paint();
    });
    pick.append(caption, trigger);
    root.append(pick);
    if (openPicker === id) {
      openTrigger = trigger;
      menu = createChoiceMenu(label, value, branchPickerOptions(branches), (next) => {
        openPicker = null;
        onPick(next);
        paint();
      });
      document.body.append(menu);
    }
  };

  const appendCreateRoute = (stack: HTMLElement, copy: PullRequestLabels): void => {
    const card = document.createElement('div');
    card.className = 'oc-sdk-pr-route-card';
    const route = document.createElement('div');
    route.className = 'oc-sdk-pr-route';
    const branches = props.create?.branches;
    if (branches !== undefined) {
      appendBranchPicker(route, 'head', copy.createHead, createValues.head, branches, copy, (next) => {
        createValues = { ...createValues, head: next };
      });
    } else {
      appendField(route, copy.createHead, createValues.head, (value) => {
        createValues = { ...createValues, head: value };
      });
    }
    const arrow = document.createElement('div');
    arrow.className = 'oc-sdk-pr-arrow';
    arrow.setAttribute('aria-hidden', 'true');
    arrow.textContent = '→';
    route.append(arrow);
    if (branches !== undefined) {
      appendBranchPicker(route, 'base', copy.createBase, createValues.base, branches, copy, (next) => {
        createValues = { ...createValues, base: next };
      });
    } else {
      appendField(route, copy.createBase, createValues.base, (value) => {
        createValues = { ...createValues, base: value };
      });
    }
    card.append(route);
    stack.append(card);
  };

  const paintCreate = (copy: PullRequestLabels): void => {
    const body = document.createElement('div');
    body.className = 'oc-sdk-pr-body';
    const stack = document.createElement('div');
    stack.className = 'oc-sdk-pr-stack oc-sdk-pr-create';
    appendCreateRoute(stack, copy);
    appendField(stack, copy.createTitle, createValues.title, (value) => {
      createValues = { ...createValues, title: value };
    });
    appendField(stack, copy.createDescription, createValues.description, (value) => {
      createValues = { ...createValues, description: value };
    }, true);
    const draft = document.createElement('label');
    draft.className = 'oc-sdk-pr-draft';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = createValues.draft;
    box.addEventListener('change', () => {
      createValues = { ...createValues, draft: box.checked };
    });
    const caption = document.createElement('span');
    caption.textContent = copy.createDraft;
    draft.append(box, caption);
    stack.append(draft);
    body.append(stack);
    shell.append(body);
    if (props.create) {
      const foot = document.createElement('div');
      foot.className = 'oc-sdk-pr-foot';
      foot.append(button(copy.createSubmit, 'default', () => {
        const next = clampPullCreate(createValues);
        if (!next || !props.create) {
          return;
        }
        props.create.onSubmit(next);
      }, Boolean(props.busy)));
      shell.append(foot);
    }
    placeMenu();
  };

  const paintView = (copy: PullRequestLabels, pull: PullRequestRecord): void => {
    const meta = document.createElement('div');
    meta.className = 'oc-sdk-pr-meta';
    const state = document.createElement('span');
    state.className = 'oc-sdk-pr-state';
    state.dataset.state = pull.state;
    state.textContent = pullRequestStatusText(pull, copy);
    meta.append(state);
    if (pull.head && pull.base) {
      const route = document.createElement('span');
      route.className = 'oc-sdk-pr-route-view';
      const head = document.createElement('span');
      head.className = 'oc-sdk-pr-chip';
      head.textContent = pull.head;
      const arrow = document.createElement('span');
      arrow.className = 'oc-sdk-pr-arrow-inline';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '→';
      const base = document.createElement('span');
      base.className = 'oc-sdk-pr-chip';
      base.textContent = pull.base;
      route.append(head, arrow, base);
      meta.append(route);
    }
    if (pull.author) {
      const author = document.createElement('span');
      author.textContent = pull.author;
      meta.append(author);
    }
    if (props.checksSummary && props.checksSummary.total > 0) {
      const checks = document.createElement('span');
      checks.textContent = `${props.checksSummary.success}/${props.checksSummary.total}`;
      meta.append(checks);
    }
    shell.append(meta);

    const tabs = document.createElement('div');
    tabs.className = 'oc-sdk-pr-tabs';
    tabs.setAttribute('role', 'tablist');
    const addTab = (id: PullRequestTab, label: string): void => {
      const tabButton = document.createElement('button');
      tabButton.type = 'button';
      tabButton.className = 'oc-sdk-pr-tab';
      tabButton.setAttribute('role', 'tab');
      tabButton.setAttribute('aria-selected', id === tab ? 'true' : 'false');
      tabButton.textContent = label;
      tabButton.addEventListener('click', () => {
        tab = id;
        paint();
      });
      tabs.append(tabButton);
    };
    addTab('overview', copy.overview);
    addTab('changes', copy.changes);
    addTab('checks', copy.checks);
    addTab('comments', copy.comments);
    shell.append(tabs);

    const body = document.createElement('div');
    body.className = 'oc-sdk-pr-body';
    const stack = document.createElement('div');
    stack.className = 'oc-sdk-pr-stack';
    if (tab === 'overview') {
      if (props.onSaveOverview) {
        appendField(stack, copy.createTitle, editTitle, (value) => {
          editTitle = value;
        });
        appendField(stack, copy.createDescription, editBody, (value) => {
          editBody = value;
        }, true);
        stack.append(button(copy.save, 'secondary', () => {
          props.onSaveOverview?.(editTitle.trim(), editBody);
        }, Boolean(props.busy) || editTitle.trim() === ''));
      } else {
        const description = document.createElement('div');
        description.className = pull.body?.trim() ? 'oc-sdk-card-description' : 'oc-sdk-card-muted';
        description.textContent = pull.body?.trim() ? pull.body : copy.emptyDescription;
        stack.append(description);
      }
    } else if (tab === 'changes') {
      paintChanges(stack, props.changes ?? [], copy);
    } else if (tab === 'checks') {
      if (props.onSendFailedChecks && failedPullChecks(props.checks ?? []).length > 0) {
        stack.append(button(copy.sendFailedChecks, 'secondary', () => {
          props.onSendFailedChecks?.();
        }, Boolean(props.busy)));
      }
      paintChecks(stack, props.checks ?? [], copy);
    } else {
      if (props.onSendComments && (props.comments ?? []).length > 0) {
        stack.append(button(copy.sendComments, 'ghost', () => {
          props.onSendComments?.();
        }, Boolean(props.busy)));
      }
      paintComments(stack, props.comments ?? [], copy);
    }
    body.append(stack);
    shell.append(body);

    const hasFoot = Boolean(
      props.onAttach || props.onStartSession || props.onReady || props.onMerge,
    );
    if (!hasFoot) {
      return;
    }
    const foot = document.createElement('div');
    foot.className = 'oc-sdk-pr-foot';
    if (props.onAttach) {
      foot.append(button(copy.attach, 'secondary', () => {
        props.onAttach?.();
      }, Boolean(props.busy)));
    }
    if (props.onStartSession) {
      foot.append(button(copy.startSession, 'default', () => {
        props.onStartSession?.(false);
      }, Boolean(props.busy)));
      foot.append(button(copy.startWorktree, 'secondary', () => {
        props.onStartSession?.(true);
      }, Boolean(props.busy)));
    }
    if (props.onReady && pull.state === 'draft') {
      foot.append(button(copy.markReady, 'secondary', () => {
        props.onReady?.();
      }, Boolean(props.busy)));
    }
    if (props.onMerge && pull.state === 'open') {
      const wrap = document.createElement('div');
      wrap.className = 'oc-sdk-pr-merge';
      const select = document.createElement('select');
      select.className = 'oc-sdk-pr-select';
      select.disabled = Boolean(props.busy);
      const options: Array<{ id: PullRequestMergeMethod; label: string }> = [
        { id: 'squash', label: copy.mergeSquash },
        { id: 'merge', label: copy.mergeMerge },
        { id: 'rebase', label: copy.mergeRebase },
      ];
      for (const option of options) {
        const node = document.createElement('option');
        node.value = option.id;
        node.textContent = option.label;
        if (option.id === mergeMethod) {
          node.selected = true;
        }
        select.append(node);
      }
      select.addEventListener('change', () => {
        if (select.value === 'merge' || select.value === 'rebase' || select.value === 'squash') {
          mergeMethod = select.value;
        }
      });
      wrap.append(select, button(copy.merge, 'default', () => {
        props.onMerge?.(mergeMethod);
      }, Boolean(props.busy)));
      foot.append(wrap);
    }
    shell.append(foot);
  };

  const paint = (): void => {
    removeMenu();
    clearNode(shell);
    const copy = resolvePullRequestLabels(props.labels);
    const bar = document.createElement('div');
    bar.className = 'oc-sdk-pr-bar';
    if (props.onBack) {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'oc-sdk-card-back';
      back.setAttribute('aria-label', copy.back);
      back.append(icon('back', 16), document.createTextNode(copy.back));
      back.addEventListener('click', () => {
        props.onBack?.();
      });
      bar.append(back);
    }
    const heading = document.createElement('div');
    heading.className = 'oc-sdk-pr-heading';
    const kicker = document.createElement('div');
    kicker.className = 'oc-sdk-pr-kicker';
    kicker.textContent = props.pull ? props.pull.id : copy.title;
    const title = document.createElement('h2');
    title.className = 'oc-sdk-pr-title';
    title.textContent = props.mode === 'create' ? copy.title : (props.pull?.title ?? copy.busy);
    heading.append(kicker, title);
    bar.append(heading);
    const tools = document.createElement('div');
    tools.className = 'oc-sdk-pr-tools';
    if (props.onOpen && props.pull?.url) {
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'oc-sdk-pr-icon';
      open.setAttribute('aria-label', copy.open);
      open.append(icon('open', 16));
      open.addEventListener('click', () => {
        props.onOpen?.();
      });
      tools.append(open);
    }
    if (props.onRefresh) {
      const refresh = document.createElement('button');
      refresh.type = 'button';
      refresh.className = 'oc-sdk-pr-icon';
      refresh.setAttribute('aria-label', copy.refresh);
      refresh.textContent = copy.refresh;
      refresh.disabled = Boolean(props.busy);
      refresh.addEventListener('click', () => {
        props.onRefresh?.();
      });
      tools.append(refresh);
    }
    bar.append(tools);
    shell.append(bar);

    if (props.mode === 'create') {
      paintCreate(copy);
      return;
    }
    if (!props.pull) {
      const body = document.createElement('div');
      body.className = 'oc-sdk-pr-body';
      const empty = document.createElement('div');
      empty.className = 'oc-sdk-empty';
      empty.textContent = copy.busy;
      body.append(empty);
      shell.append(body);
      return;
    }
    paintView(copy, props.pull);
  };

  const onDocumentPointerDown = (event: PointerEvent): void => {
    if (!(event.target instanceof Element)) {
      return;
    }
    if (event.target.closest('.oc-sdk-pr-pick') || event.target.closest('.oc-sdk-menu')) {
      return;
    }
    if (!openPicker) {
      return;
    }
    openPicker = null;
    paint();
  };

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !openPicker) {
      return;
    }
    openPicker = null;
    paint();
  };

  document.addEventListener('pointerdown', onDocumentPointerDown);
  document.addEventListener('keydown', onDocumentKeyDown);
  window.addEventListener('resize', placeMenu);
  window.addEventListener('scroll', placeMenu, true);
  paint();

  return {
    update: (next) => {
      const pullChanged = next.pull?.id !== props.pull?.id;
      const modeChanged = next.mode !== props.mode;
      props = next;
      if (modeChanged) {
        openPicker = null;
        createValues = { ...emptyCreate(), ...next.create?.values };
      } else if (next.mode === 'create') {
        createValues = mergePullCreateValues(createValues, next.create?.values);
      }
      if (pullChanged) {
        tab = 'overview';
        editTitle = next.pull?.title ?? '';
        editBody = next.pull?.body ?? '';
      }
      paint();
    },
    dispose: () => {
      document.removeEventListener('pointerdown', onDocumentPointerDown);
      document.removeEventListener('keydown', onDocumentKeyDown);
      window.removeEventListener('resize', placeMenu);
      window.removeEventListener('scroll', placeMenu, true);
      removeMenu();
      shell.remove();
    },
  };
};
