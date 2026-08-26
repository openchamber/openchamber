import type { ShortcutCombo } from './bindings';

type ShortcutCategory = 'session' | 'models' | 'panels' | 'navigation' | 'application';

type ShortcutConfig = {
  id: string;
  defaultBinding: ShortcutCombo;
  allowsSequenceFallback?: true;
  /** The binding is a bare-modifier chord prefix (completed by another key);
      conflict resolution compares its prefix rather than a full combo. */
  prefixStyle?: true;
} & (
  | { customizable: false }
  | {
      customizable: true;
      settingsLabelKey: `settings.openchamber.keyboardShortcuts.action.${string}.label`;
    }
);

const SHORTCUT_GROUPS = {
  session: [
    {
      id: 'add_selection_to_chat',
      defaultBinding: 'mod+l',
      allowsSequenceFallback: true,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.add_selection_to_chat.label',
    },
    {
      id: 'focus_input',
      defaultBinding: 'mod+i',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.focus_input.label',
    },
    {
      id: 'open_timeline_dialog',
      defaultBinding: 'mod+t',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_timeline_dialog.label',
    },
    {
      id: 'new_chat',
      defaultBinding: 'mod+n',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.new_chat.label',
    },
    {
      id: 'close_session_tab',
      defaultBinding: 'alt+w',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.close_session_tab.label',
    },
    {
      id: 'open_draft_project_picker',
      defaultBinding: 'mod+s p',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_draft_project_picker.label',
    },
    {
      id: 'open_draft_worktree_picker',
      defaultBinding: 'mod+s g',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_draft_worktree_picker.label',
    },
    {
      id: 'open_session_list',
      defaultBinding: 'mod+s l',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_session_list.label',
    },
    {
      id: 'new_chat_worktree',
      defaultBinding: 'mod+shift+n',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.new_chat_worktree.label',
    },
    {
      id: 'new_mini_chat',
      defaultBinding: 'mod+alt+n',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.new_mini_chat.label',
    },
    {
      id: 'expand_input',
      defaultBinding: 'mod+shift+e',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.expand_input.label',
    },
    {
      id: 'toggle_dictation',
      defaultBinding: 'mod+alt+v',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.toggle_dictation.label',
    },
    { id: 'abort_run', defaultBinding: 'escape', customizable: false },
  ],
  models: [
    {
      id: 'open_model_selector',
      defaultBinding: 'mod+shift+m',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_model_selector.label',
    },
    { id: 'cycle_thinking_variant', defaultBinding: 'mod+shift+t', customizable: false },
    {
      id: 'cycle_agent',
      defaultBinding: 'tab',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.cycle_agent.label',
    },
    {
      id: 'cycle_favorite_model_forward',
      defaultBinding: 'ctrl+]',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.cycle_favorite_model_forward.label',
    },
    {
      id: 'cycle_favorite_model_backward',
      defaultBinding: 'ctrl+[',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.cycle_favorite_model_backward.label',
    },
  ],
  panels: [
    {
      id: 'toggle_terminal',
      defaultBinding: 'mod+j',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.toggle_terminal.label',
    },
    {
      id: 'toggle_terminal_expanded',
      defaultBinding: 'mod+shift+j',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_terminal_expanded.label',
    },
    {
      id: 'toggle_sidebar',
      defaultBinding: 'mod+alt+l',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.toggle_sidebar.label',
    },
    {
      id: 'toggle_prompt_navigator',
      defaultBinding: 'mod+alt+p',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_prompt_navigator.label',
    },
    {
      id: 'toggle_right_sidebar',
      defaultBinding: 'mod+b',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_right_sidebar.label',
    },
    {
      id: 'open_right_sidebar_git',
      defaultBinding: 'mod+shift+g',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_right_sidebar_git.label',
    },
    {
      id: 'open_right_sidebar_files',
      defaultBinding: 'mod+shift+f',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_right_sidebar_files.label',
    },
    {
      id: 'switch_context_surface',
      defaultBinding: 'mod',
      // The binding is a bare modifier acting as a chord prefix (completed by
      // a digit); conflict resolution must compare its PREFIX, not a combo.
      prefixStyle: true,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.switch_context_surface.label',
    },
    {
      id: 'toggle_context_plan',
      defaultBinding: 'mod+shift+p',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_context_plan.label',
    },
    {
      id: 'toggle_services_menu',
      defaultBinding: 'mod+shift+s',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_services_menu.label',
    },
  ],
  navigation: [
    { id: 'save_file', defaultBinding: 'mod+s', customizable: false, allowsSequenceFallback: true },
    { id: 'find_in_file', defaultBinding: 'mod+f', customizable: false },
    {
      id: 'open_go_to_line',
      defaultBinding: 'alt+g',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_go_to_line.label',
    },
    {
      id: 'cycle_services_tab',
      defaultBinding: 'mod+shift+[',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.cycle_services_tab.label',
    },
  ],
  application: [
    {
      id: 'open_command_palette',
      defaultBinding: 'mod+p',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_command_palette.label',
    },
    { id: 'open_status', defaultBinding: 'mod+shift+o', customizable: false },
    {
      id: 'open_settings',
      defaultBinding: 'mod+comma',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_settings.label',
    },
    {
      id: 'open_help',
      defaultBinding: 'mod+.',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_help.label',
    },
    {
      id: 'cycle_theme',
      defaultBinding: 'mod+/',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.cycle_theme.label',
    },
    { id: 'toggle_memory_debug', defaultBinding: 'mod+shift+d', customizable: false },
  ],
} as const satisfies Record<ShortcutCategory, readonly ShortcutConfig[]>;

/** All application shortcuts, flattened in the same order used by Settings. */
export const SHORTCUT_SCHEMA = [
  ...SHORTCUT_GROUPS.session.map((shortcut) => ({
    ...shortcut,
    category: 'session' as const,
  })),
  ...SHORTCUT_GROUPS.models.map((shortcut) => ({
    ...shortcut,
    category: 'models' as const,
  })),
  ...SHORTCUT_GROUPS.panels.map((shortcut) => ({
    ...shortcut,
    category: 'panels' as const,
  })),
  ...SHORTCUT_GROUPS.navigation.map((shortcut) => ({
    ...shortcut,
    category: 'navigation' as const,
  })),
  ...SHORTCUT_GROUPS.application.map((shortcut) => ({
    ...shortcut,
    category: 'application' as const,
  })),
] as const;
