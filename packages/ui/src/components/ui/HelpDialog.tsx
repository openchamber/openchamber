import React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/icon/Icon";
import { useUIStore } from "@/stores/useUIStore";
import {
  getEffectiveShortcutCombo,
  getEffectiveShortcutPrefix,
  getShortcutAction,
  formatShortcutForDisplay,
  type ShortcutActionId,
} from "@/lib/shortcuts";
import { useI18n, type I18nKey } from "@/lib/i18n";
import type { IconName } from "@/components/icon/icons";
import { ScrollableOverlay } from "@/components/ui/ScrollableOverlay";

type ShortcutItem = {
  id?: ShortcutActionId;
  keys: string | string[];
  descriptionKey?: I18nKey;
  icon: IconName | null;
};

type ShortcutSection = {
  categoryKey: I18nKey;
  // Sections are split by hand so both columns end up about the same height.
  column: 'left' | 'right';
  items: ShortcutItem[];
};

const renderShortcut = (
  id: ShortcutActionId,
  overrides: Record<string, string>,
  unassignedLabel: string,
) => {
  return formatShortcutForDisplay(getEffectiveShortcutCombo(id, overrides), unassignedLabel);
};

export const HelpDialog: React.FC = () => {
  const { t } = useI18n();
  const isHelpDialogOpen = useUIStore((state) => state.isHelpDialogOpen);
  const setHelpDialogOpen = useUIStore((state) => state.setHelpDialogOpen);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);

  const shortcuts: ShortcutSection[] = [
    {
      categoryKey: "helpDialog.section.navigationCommands",
      column: 'left',
      items: [
        {
          id: 'open_command_palette',
          descriptionKey: "helpDialog.item.openCommandPalette",
          icon: "command",
          keys: '',
        },
        {
          id: 'open_help',
          descriptionKey: "helpDialog.item.showKeyboardShortcuts",
          icon: "question",
          keys: '',
        },
        {
          id: 'toggle_sidebar',
          descriptionKey: "helpDialog.item.toggleSessionSidebar",
          icon: "layout-left",
          keys: '',
        },
        {
          id: 'add_selection_to_chat',
          descriptionKey: "helpDialog.item.addSelectionToChat",
          icon: "add",
          keys: '',
        },
        {
          id: 'cycle_agent',
          keys: '',
          descriptionKey: "helpDialog.item.cycleAgent",
          icon: "ai-agent",
        },
        {
          id: 'open_model_selector',
          descriptionKey: "helpDialog.item.openModelSelector",
          icon: "ai-generate-2",
          keys: '',
        },
        {
          keys: ["↑↓"],
          descriptionKey: "helpDialog.item.navigateModels",
          icon: "ai-generate-2",
        },
        {
          keys: ["←→"],
          descriptionKey: "helpDialog.item.adjustThinkingMode",
          icon: "brain-ai-3",
        },
        {
          id: 'cycle_thinking_variant',
          descriptionKey: "helpDialog.item.cycleThinkingVariant",
          icon: "brain-ai-3",
          keys: '',
        },
        {
          keys: [formatShortcutForDisplay('mod+shift+alt+n')],
          descriptionKey: "helpDialog.item.newWindow",
          icon: "window",
        },
      ],
    },
    {
      categoryKey: "helpDialog.section.sessionManagement",
      column: 'right',
      items: [
        {
          id: 'new_chat',
          descriptionKey: "helpDialog.item.createNewSession",
          icon: "add",
          keys: '',
        },
        {
          id: 'new_chat_worktree',
          descriptionKey: "helpDialog.item.createNewWorktreeDraft",
          icon: "git-branch",
          keys: '',
        },
        {
          id: 'open_draft_project_picker',
          icon: 'folder',
          keys: '',
        },
        {
          id: 'open_draft_worktree_picker',
          icon: 'git-branch',
          keys: '',
        },
        {
          id: 'open_session_list',
          icon: 'list-unordered',
          keys: '',
        },
        { id: 'focus_input', descriptionKey: "helpDialog.item.focusChatInput", icon: "text", keys: '' },
        {
          id: 'toggle_prompt_navigator',
          descriptionKey: "helpDialog.item.togglePromptNavigator",
          icon: "list-unordered",
          keys: '',
        },
        {
          id: 'abort_run',
          descriptionKey: "helpDialog.item.abortActiveRun",
          icon: "close-circle",
          keys: '',
        },
        {
          id: 'background_session_work',
          icon: 'arrow-up-double',
          keys: '',
        },
      ],
    },
    {
      categoryKey: "helpDialog.section.panels",
      column: 'right',
      items: [
        {
          id: 'toggle_terminal',
          descriptionKey: 'helpDialog.item.toggleTerminalDock',
          icon: "window",
          keys: '',
        },
        {
          id: 'toggle_terminal_expanded',
          descriptionKey: 'helpDialog.item.toggleTerminalExpanded',
          icon: "window",
          keys: '',
        },
        {
          keys: [`${formatShortcutForDisplay(getEffectiveShortcutPrefix('switch_context_surface', shortcutOverrides))} + 1...0`],
          descriptionKey: "helpDialog.item.switchContextSurface",
          icon: "layout-right",
        },
        {
          keys: [`${formatShortcutForDisplay(getEffectiveShortcutPrefix('switch_session_tab', shortcutOverrides))} + 1...9`],
          descriptionKey: "helpDialog.item.switchSessionTab",
          icon: "layout-right",
        },
      ],
    },
    {
      categoryKey: "helpDialog.section.interface",
      column: 'left',
      items: [
        {
          id: 'cycle_theme',
          descriptionKey: "helpDialog.item.cycleTheme",
          icon: "palette",
          keys: '',
        },
        {
          id: 'toggle_services_menu',
          descriptionKey: 'helpDialog.item.toggleServicesMenu',
          icon: "stack",
          keys: '',
        },
        {
          id: 'open_settings',
          descriptionKey: "helpDialog.item.openSettings",
          icon: "settings-3",
          keys: '',
        },
      ],
    },
  ];

  const renderSection = (section: ShortcutSection) => (
    <div key={section.categoryKey}>
      <h3 className="typography-meta font-semibold text-muted-foreground uppercase tracking-wider mb-2">
        {t(section.categoryKey)}
      </h3>
      <div className="space-y-1">
        {section.items
          .map((shortcut) => {
            const action = shortcut.id ? getShortcutAction(shortcut.id) : undefined;
            const descriptionKey = shortcut.descriptionKey
              ?? (action?.customizable ? action.settingsLabelKey : undefined);
            if (!descriptionKey) return null;
            // This dialog lists what the keyboard can do right now;
            // an action without a binding belongs to the command
            // palette and Settings, not here.
            if (shortcut.id && !getEffectiveShortcutCombo(shortcut.id, shortcutOverrides)) {
              return null;
            }
            const displayKeys = shortcut.id
              ? renderShortcut(
                  shortcut.id,
                  shortcutOverrides,
                  t('settings.openchamber.keyboardShortcuts.unassigned'),
                )
              : (Array.isArray(shortcut.keys) ? shortcut.keys : shortcut.keys.split(" / "));

            return (
              <div
                key={shortcut.id || descriptionKey}
                className="flex items-center gap-3 py-1 px-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {shortcut.icon && (
                    <Icon name={shortcut.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <span className="typography-meta">
                    {t(descriptionKey)}
                  </span>
                </div>
                <div aria-hidden className="min-w-4 flex-1 border-b border-dotted border-border" />
                <div className="flex shrink-0 items-center gap-1">
                  {(Array.isArray(displayKeys) ? displayKeys : [displayKeys]).map((keyCombo: string, i: number) => (
                    <React.Fragment key={`${keyCombo}-${i}`}>
                      {i > 0 && (
                        <span className="typography-meta text-muted-foreground mx-1">
                          {t('helpDialog.keyCombiner.or')}
                        </span>
                      )}
                      <kbd className="inline-flex items-center gap-1 px-1.5 py-0.5 typography-meta font-mono bg-muted rounded border border-border/20">
                        {keyCombo}
                      </kbd>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );

  return (
    <Dialog open={isHelpDialogOpen} onOpenChange={setHelpDialogOpen}>
      <DialogContent className="max-w-6xl w-[min(72rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="command" className="h-5 w-5" />
            {t('helpDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t('helpDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <ScrollableOverlay
          outerClassName="flex-1 min-h-0 mt-3"
          className="pr-1"
          disableHorizontal
        >
          <div className="grid grid-cols-1 gap-x-12 gap-y-4 lg:grid-cols-2">
            {(['left', 'right'] as const).map((column) => (
              <div key={column} className="space-y-4">
                {shortcuts.filter((section) => section.column === column).map(renderSection)}
                {/* The right column is one row shorter, so the tips fill its
                    tail instead of adding a full-width block below both. */}
                {column === 'right' && (
                  <ul className="space-y-0.5 px-2 typography-meta text-muted-foreground">
                    <li>
                      • {t('helpDialog.proTips.commandPalette', {
                        shortcut: renderShortcut(
                          'open_command_palette',
                          shortcutOverrides,
                          t('settings.openchamber.keyboardShortcuts.unassigned'),
                        ),
                      })}
                    </li>
                    <li>• {t('helpDialog.proTips.recentSessions')}</li>
                    <li>• {t('helpDialog.proTips.leaderSequences')}</li>
                  </ul>
                )}
              </div>
            ))}
          </div>
        </ScrollableOverlay>
      </DialogContent>
    </Dialog>
  );
};
