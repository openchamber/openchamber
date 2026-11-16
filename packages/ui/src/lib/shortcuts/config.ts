import { UNASSIGNED_SHORTCUT, type ShortcutCombo } from './bindings';

type ShortcutCategory = 'session' | 'models' | 'panels' | 'navigation' | 'application' | 'desktop';

type ShortcutConfig = {
  id: string;
  defaultBinding: ShortcutCombo;
  /** The binding is a bare-modifier chord prefix (completed by another key);
      conflict resolution compares its prefix rather than a full combo. */
  prefixStyle?: true;
  /** The handler matches single key presses, so Settings records one chord. */
  singleChord?: true;
  /** The desktop app menu owns the key as a native accelerator: it works from
      every focused surface and window, and needs no renderer handler. The key
      exists only where that menu item does; the recorder takes one chord. */
  nativeMenu?: 'all' | 'non-mac';
} & (
  | { customizable: false }
  | {
      customizable: true;
      settingsLabelKey: `settings.openchamber.keyboardShortcuts.action.${string}.label`;
    }
);

// Default layout, unified around three modes:
// - Single chords for everyday actions.
// - The mod+k leader for "open/go" actions, second key mnemonic.
// - Held mod + digit switches header session tabs; held mod+alt + digit
//   switches context panel surfaces (mod+shift+digit is reserved by macOS
//   screenshots).
// Everything else lives only in the command palette, outside this schema.
const SHORTCUT_GROUPS = {
  session: [
    {
      id: 'add_selection_to_chat',
      defaultBinding: 'mod+l',
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
      id: 'search_prompt_history',
      defaultBinding: 'mod+arrowup',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.search_prompt_history.label',
    },
    {
      id: 'open_timeline_dialog',
      defaultBinding: 'mod+k t',
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
      id: 'switch_session_previous',
      defaultBinding: 'mod+alt+arrowleft',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.switch_session_previous.label',
    },
    {
      id: 'switch_session_next',
      defaultBinding: 'mod+alt+arrowright',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.switch_session_next.label',
    },
    {
      // Browser-style back/forward over the sessions opened in this window.
      id: 'session_history_back',
      defaultBinding: 'mod+[',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.session_history_back.label',
    },
    {
      id: 'session_history_forward',
      defaultBinding: 'mod+]',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.session_history_forward.label',
    },
    {
      id: 'rename_current_session',
      defaultBinding: 'mod+k r',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.rename_current_session.label',
    },
    {
      id: 'archive_current_session',
      defaultBinding: 'mod+k backspace',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.archive_current_session.label',
    },
    {
      id: 'toggle_permission_auto_accept',
      defaultBinding: 'mod+k a',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_permission_auto_accept.label',
    },
    {
      id: 'close_session_tab',
      defaultBinding: 'alt+w',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.close_session_tab.label',
    },
    {
      id: 'open_draft_project_picker',
      defaultBinding: 'mod+k p',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_draft_project_picker.label',
    },
    {
      id: 'open_draft_worktree_picker',
      defaultBinding: 'mod+k g',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_draft_worktree_picker.label',
    },
    {
      id: 'open_session_list',
      defaultBinding: 'mod+k l',
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
    {
      id: 'sessions_bulk_delete',
      defaultBinding: 'mod+backspace',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.sessions_bulk_delete.label',
    },
    {
      id: 'sessions_select_all',
      defaultBinding: 'mod+a',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.sessions_select_all.label',
    },
    {
      id: 'permission_allow_once',
      defaultBinding: 'alt+enter',
      singleChord: true,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.permission_allow_once.label',
    },
    {
      id: 'permission_allow_always',
      defaultBinding: 'alt+shift+enter',
      singleChord: true,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.permission_allow_always.label',
    },
    {
      id: 'permission_deny',
      defaultBinding: 'alt+backspace',
      singleChord: true,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.permission_deny.label',
    },
    { id: 'abort_run', defaultBinding: 'escape', customizable: false },
    {
      // Not ctrl+b (the OpenCode TUI's key): the composer editor's macOS
      // emacs keymap moves the caret on it, and elsewhere it is mod+b
      // (toggle_sidebar).
      id: 'background_session_work',
      defaultBinding: 'mod+shift+b',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.background_session_work.label',
    },
  ],
  models: [
    {
      id: 'open_model_selector',
      defaultBinding: 'mod+shift+m',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.open_model_selector.label',
    },
    {
      id: 'cycle_thinking_variant',
      defaultBinding: 'mod+shift+t',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.cycle_thinking_variant.label',
    },
    {
      id: 'cycle_agent',
      defaultBinding: 'tab',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.cycle_agent.label',
    },
    {
      id: 'cycle_favorite_model_forward',
      defaultBinding: 'ctrl+alt+]',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.cycle_favorite_model_forward.label',
    },
    {
      id: 'cycle_favorite_model_backward',
      defaultBinding: 'ctrl+alt+[',
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
      id: 'toggle_context_panel_expanded',
      defaultBinding: 'mod+shift+f',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_context_panel_expanded.label',
    },
    {
      id: 'toggle_sidebar',
      defaultBinding: 'mod+b',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.toggle_sidebar.label',
    },
    {
      id: 'toggle_source_board',
      defaultBinding: 'mod+k b',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.toggle_source_board.label',
    },
    {
      id: 'toggle_prompt_navigator',
      defaultBinding: 'mod+k n',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_prompt_navigator.label',
    },
    {
      id: 'switch_session_tab',
      defaultBinding: 'mod',
      // The binding is a bare modifier acting as a chord prefix (completed by
      // a digit); conflict resolution must compare its PREFIX, not a combo.
      prefixStyle: true,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.switch_session_tab.label',
    },
    {
      id: 'switch_context_surface',
      defaultBinding: 'mod+alt',
      prefixStyle: true,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.switch_context_surface.label',
    },
    {
      id: 'open_git_panel',
      defaultBinding: 'mod+shift+g',
      nativeMenu: 'all',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_git_panel.label',
    },
    {
      id: 'toggle_services_menu',
      defaultBinding: 'mod+k i',
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_services_menu.label',
    },
    {
      id: 'collapse_sessions_all',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.collapse_sessions_all.label',
    },
    {
      id: 'expand_sessions_all',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.expand_sessions_all.label',
    },
    {
      id: 'toggle_chats_section',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_chats_section.label',
    },
    {
      id: 'toggle_pinned_section',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_pinned_section.label',
    },
    {
      id: 'toggle_work_section',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_work_section.label',
    },
    {
      id: 'toggle_detailed_rows',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_detailed_rows.label',
    },
    {
      id: 'toggle_list_grouping',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_list_grouping.label',
    },
    {
      id: 'toggle_project_display',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_project_display.label',
    },
    {
      id: 'cycle_project_sort',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.cycle_project_sort.label',
    },
    {
      id: 'toggle_selection_mode',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey:
        'settings.openchamber.keyboardShortcuts.action.toggle_selection_mode.label',
    },
  ],
  navigation: [
    {
      id: 'save_file',
      defaultBinding: 'mod+s',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.save_file.label',
    },
    {
      id: 'find_in_file',
      defaultBinding: 'mod+f',
      singleChord: true,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.find_in_file.label',
    },
    {
      id: 'diff_next_file',
      defaultBinding: 'alt+arrowdown',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.diff_next_file.label',
    },
    {
      id: 'diff_previous_file',
      defaultBinding: 'alt+arrowup',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.diff_previous_file.label',
    },
    {
      id: 'previous_project',
      defaultBinding: 'ctrl+alt+arrowup',
      nativeMenu: 'non-mac',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.previous_project.label',
    },
    {
      id: 'next_project',
      defaultBinding: 'ctrl+alt+arrowdown',
      nativeMenu: 'non-mac',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.next_project.label',
    },
    {
      id: 'open_go_to_line',
      defaultBinding: 'alt+g',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_go_to_line.label',
    },
    {
      id: 'open_document_symbols',
      defaultBinding: 'mod+shift+o',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_document_symbols.label',
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
    {
      id: 'open_settings',
      defaultBinding: 'mod+comma',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_settings.label',
    },
    {
      id: 'open_help',
      defaultBinding: 'mod+k h',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_help.label',
    },
    {
      // mod+alt keeps it off the browser's own reload (mod+r, mod+shift+r).
      id: 'open_project_actions',
      defaultBinding: 'mod+alt+r',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_project_actions.label',
    },
    {
      id: 'cycle_theme',
      defaultBinding: 'mod+k c',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.cycle_theme.label',
    },
    {
      id: 'open_archive',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_archive.label',
    },
    {
      id: 'open_notes',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_notes.label',
    },
    {
      id: 'open_todos',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_todos.label',
    },
    {
      id: 'show_context_usage',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.show_context_usage.label',
    },
    {
      id: 'open_overview',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_overview.label',
    },
    {
      id: 'show_opencode_status',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.show_opencode_status.label',
    },
    {
      id: 'open_new_worktree_dialog',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_new_worktree_dialog.label',
    },
    {
      id: 'add_project',
      // The leader's "open" key, as Open Folder is in code editors; a single
      // mod+o would take the browser's Open File.
      defaultBinding: 'mod+k o',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.add_project.label',
    },
    {
      id: 'reload_ui',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.reload_ui.label',
    },
    {
      id: 'restart_opencode',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.restart_opencode.label',
    },
    {
      id: 'pin_current_session',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.pin_current_session.label',
    },
    {
      id: 'copy_current_session_id',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.copy_current_session_id.label',
    },
    {
      id: 'toggle_work_current_session',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.toggle_work_current_session.label',
    },
    {
      id: 'open_multi_run',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.open_multi_run.label',
    },
    {
      id: 'new_window',
      defaultBinding: 'mod+shift+alt+n',
      nativeMenu: 'all',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.new_window.label',
    },
    {
      id: 'show_diagnostics',
      defaultBinding: 'mod+shift+l',
      nativeMenu: 'all',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.show_diagnostics.label',
    },
    {
      id: 'toggle_developer_tools',
      defaultBinding: 'mod+alt+i',
      nativeMenu: 'all',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.toggle_developer_tools.label',
    },
    {
      id: 'toggle_memory_debug',
      defaultBinding: 'mod+shift+d',
      nativeMenu: 'all',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.toggle_memory_debug.label',
    },
    {
      id: 'zoom_in',
      defaultBinding: 'mod+=',
      nativeMenu: 'all',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.zoom_in.label',
    },
    {
      id: 'zoom_out',
      defaultBinding: 'mod+minus',
      nativeMenu: 'all',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.zoom_out.label',
    },
    {
      id: 'zoom_reset',
      defaultBinding: 'mod+0',
      nativeMenu: 'all',
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.zoom_reset.label',
    },
  ],
  // Desktop-shell capabilities: registered as OS-level global shortcuts rather
  // than in-app keybindings, so they carry no in-app default binding. The
  // Settings shortcut list renders only the categories above, never this one.
  desktop: [
    {
      id: 'mini_chat_global',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.mini_chat_global.label',
    },
    {
      id: 'quake_mode_global',
      defaultBinding: UNASSIGNED_SHORTCUT,
      customizable: true,
      settingsLabelKey: 'settings.openchamber.keyboardShortcuts.action.quake_mode_global.label',
    },
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
  ...SHORTCUT_GROUPS.desktop.map((shortcut) => ({
    ...shortcut,
    category: 'desktop' as const,
  })),
] as const;
