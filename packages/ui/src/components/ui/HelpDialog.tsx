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
  getShortcutAction,
  formatShortcutForDisplay,
  type ShortcutActionId,
} from "@/lib/shortcuts";
import { useI18n, type I18nKey } from "@/lib/i18n";
import { isVSCodeRuntime } from "@/lib/desktop";
import type { IconName } from "@/components/icon/icons";

type ShortcutItem = {
  id?: ShortcutActionId;
  keys: string | string[];
  descriptionKey?: I18nKey;
  icon: IconName | null;
};

type ShortcutSection = {
  categoryKey: I18nKey;
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
  const isVSCode = isVSCodeRuntime();

  const shortcuts: ShortcutSection[] = [
    {
      categoryKey: "helpDialog.section.navigationCommands",
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
      ],
    },
    {
      categoryKey: "helpDialog.section.panels",
      items: [
        {
          id: 'toggle_right_sidebar',
          descriptionKey: 'helpDialog.item.toggleRightSidebar',
          icon: "layout-right",
          keys: '',
        },
        {
          id: 'open_right_sidebar_git',
          descriptionKey: 'helpDialog.item.openRightSidebarGitTab',
          icon: "git-branch",
          keys: '',
        },
        {
          id: 'open_right_sidebar_files',
          descriptionKey: 'helpDialog.item.openRightSidebarFilesTab',
          icon: "layout-right",
          keys: '',
        },
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
          id: 'toggle_context_plan',
          descriptionKey: 'helpDialog.item.togglePlanContextPanel',
          icon: "time",
          keys: '',
        },
        {
          keys: [`${formatShortcutForDisplay('mod')} + 1...0`],
          descriptionKey: "helpDialog.item.switchContextSurface",
          icon: "layout-right",
        },
      ],
    },
    {
      categoryKey: "helpDialog.section.interface",
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
          id: 'cycle_services_tab',
          descriptionKey: 'helpDialog.item.cycleServicesTab',
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

  return (
    <Dialog open={isHelpDialogOpen} onOpenChange={setHelpDialogOpen}>
      <DialogContent className="max-w-2xl w-[min(42rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-2rem)] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="command" className="h-5 w-5" />
            {t('helpDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t('helpDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto mt-3 pr-1">
          <div className="space-y-4">
            {shortcuts.map((section) => (
              <div key={section.categoryKey}>
                <h3 className="typography-meta font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  {t(section.categoryKey)}
                </h3>
                <div className="space-y-1">
                  {section.items
                    .filter((shortcut) => !(isVSCode && shortcut.id === 'toggle_prompt_navigator'))
                    .map((shortcut) => {
                      const action = shortcut.id ? getShortcutAction(shortcut.id) : undefined;
                      const descriptionKey = shortcut.descriptionKey
                        ?? (action?.customizable ? action.settingsLabelKey : undefined);
                      if (!descriptionKey) return null;
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
                          className="flex items-center justify-between py-1 px-2"
                        >
                          <div className="flex items-center gap-2">
                            {shortcut.icon && (
                              <Icon name={shortcut.icon} className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span className="typography-meta">
                              {t(descriptionKey)}
                            </span>
                          </div>
                          <div className="flex items-center gap-1">
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
            ))}
          </div>

          <div className="mt-4 p-2 bg-muted/30 rounded-xl">
            <div className="flex items-start gap-2">
              <Icon name="question" className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
              <div className="typography-meta text-muted-foreground">
                <p className="font-medium mb-1">{t('helpDialog.proTips.title')}</p>
                <ul className="space-y-0.5 typography-meta">
                  <li>
                    • {t('helpDialog.proTips.commandPalette', {
                      shortcut: renderShortcut(
                        'open_command_palette',
                        shortcutOverrides,
                        t('settings.openchamber.keyboardShortcuts.unassigned'),
                      ),
                    })}
                  </li>
                  <li>
                    • {t('helpDialog.proTips.recentSessions')}
                  </li>
                  <li>
                    • {t('helpDialog.proTips.themeCycling')}
                  </li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
