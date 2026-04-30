import React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUIStore } from "@/stores/useUIStore";
import {
  RiAddLine,
  RiAiAgentLine,
  RiAiGenerate2,
  RiBrainAi3Line,
  RiCloseCircleLine,
  RiCommandLine,
  RiGitBranchLine,
  RiLayoutLeftLine,
  RiLayoutRightLine,
  RiPaletteLine,
  RiQuestionLine,
  RiSettings3Line,
  RiStackLine,
  RiText,
  RiTimeLine,
  RiWindowLine,
} from "@remixicon/react";
import {
  getEffectiveShortcutCombo,
  getShortcutAction,
  getModifierLabel,
  formatShortcutForDisplay,
} from "@/lib/shortcuts";
import { useI18n, type I18nKey } from "@/lib/i18n";

type ShortcutIcon = React.ComponentType<{ className?: string }>;

type ShortcutItem = {
  id?: string;
  keys: string | string[];
  descriptionKey: I18nKey;
  icon: ShortcutIcon | null;
};

type ShortcutSection = {
  categoryKey: I18nKey;
  items: ShortcutItem[];
};

const renderShortcut = (id: string, fallbackCombo: string, overrides: Record<string, string>) => {
  const action = getShortcutAction(id);
  return action ? formatShortcutForDisplay(getEffectiveShortcutCombo(id, overrides)) : fallbackCombo;
};

export const HelpDialog: React.FC = () => {
  const { t } = useI18n();
  const isHelpDialogOpen = useUIStore((state) => state.isHelpDialogOpen);
  const setHelpDialogOpen = useUIStore((state) => state.setHelpDialogOpen);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const mod = getModifierLabel();

  const shortcuts: ShortcutSection[] = [
    {
      categoryKey: "helpDialog.section.navigationCommands",
      items: [
        {
          id: 'open_command_palette',
          descriptionKey: "helpDialog.item.openCommandPalette",
          icon: RiCommandLine,
          keys: '',
        },
        {
          id: 'open_help',
          descriptionKey: "helpDialog.item.showKeyboardShortcuts",
          icon: RiQuestionLine,
          keys: '',
        },
        {
          id: 'toggle_sidebar',
          descriptionKey: "helpDialog.item.toggleSessionSidebar",
          icon: RiLayoutLeftLine,
          keys: '',
        },
        {
          keys: ["Tab"],
          descriptionKey: "helpDialog.item.cycleAgent",
          icon: RiAiAgentLine,
        },
        {
          id: 'open_model_selector',
          descriptionKey: "helpDialog.item.openModelSelector",
          icon: RiAiGenerate2,
          keys: '',
        },
        {
          keys: ["↑↓"],
          descriptionKey: "helpDialog.item.navigateModels",
          icon: RiAiGenerate2,
        },
        {
          keys: ["←→"],
          descriptionKey: "helpDialog.item.adjustThinkingMode",
          icon: RiBrainAi3Line,
        },
        {
          id: 'cycle_thinking_variant',
          descriptionKey: "helpDialog.item.cycleThinkingVariant",
          icon: RiBrainAi3Line,
          keys: '',
        },
        {
          keys: [`Shift + Alt + ${mod} + N`],
          descriptionKey: "helpDialog.item.newWindow",
          icon: RiWindowLine,
        },
      ],
    },
    {
      categoryKey: "helpDialog.section.sessionManagement",
      items: [
        {
          id: 'new_chat',
          descriptionKey: "helpDialog.item.createNewSession",
          icon: RiAddLine,
          keys: '',
        },
        {
          id: 'new_chat_worktree',
          descriptionKey: "helpDialog.item.createNewWorktreeDraft",
          icon: RiGitBranchLine,
          keys: '',
        },
        { id: 'focus_input', descriptionKey: "helpDialog.item.focusChatInput", icon: RiText, keys: '' },
        {
          id: 'abort_run',
          descriptionKey: "helpDialog.item.abortActiveRun",
          icon: RiCloseCircleLine,
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
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'open_right_sidebar_git',
          descriptionKey: 'helpDialog.item.openRightSidebarGitTab',
          icon: RiGitBranchLine,
          keys: '',
        },
        {
          id: 'open_right_sidebar_files',
          descriptionKey: 'helpDialog.item.openRightSidebarFilesTab',
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'cycle_right_sidebar_tab',
          descriptionKey: 'helpDialog.item.cycleRightSidebarTab',
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'toggle_terminal',
          descriptionKey: 'helpDialog.item.toggleTerminalDock',
          icon: RiWindowLine,
          keys: '',
        },
        {
          id: 'toggle_terminal_expanded',
          descriptionKey: 'helpDialog.item.toggleTerminalExpanded',
          icon: RiWindowLine,
          keys: '',
        },
        {
          id: 'toggle_context_plan',
          descriptionKey: 'helpDialog.item.togglePlanContextPanel',
          icon: RiTimeLine,
          keys: '',
        },
      ],
    },
    {
      categoryKey: "helpDialog.section.interface",
      items: [
        {
          id: 'cycle_theme',
          descriptionKey: "helpDialog.item.cycleTheme",
          icon: RiPaletteLine,
          keys: '',
        },
        {
          keys: [`${mod} + 1...9`],
          descriptionKey: "helpDialog.item.switchProject",
          icon: RiLayoutLeftLine,
        },
        {
          id: 'toggle_services_menu',
          descriptionKey: 'helpDialog.item.toggleServicesMenu',
          icon: RiStackLine,
          keys: '',
        },
        {
          id: 'cycle_services_tab',
          descriptionKey: 'helpDialog.item.cycleServicesTab',
          icon: RiStackLine,
          keys: '',
        },
        {
          id: 'open_settings',
          descriptionKey: "helpDialog.item.openSettings",
          icon: RiSettings3Line,
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
            <RiSettings3Line className="h-5 w-5" />
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
                  {section.items.map((shortcut) => {
                    const displayKeys = shortcut.id
                      ? renderShortcut(shortcut.id, Array.isArray(shortcut.keys) ? shortcut.keys[0] : shortcut.keys, shortcutOverrides)
                      : (Array.isArray(shortcut.keys) ? shortcut.keys : shortcut.keys.split(" / "));

                    return (
                      <div
                        key={shortcut.id || shortcut.descriptionKey}
                        className="flex items-center justify-between py-1 px-2"
                      >
                        <div className="flex items-center gap-2">
                          {shortcut.icon && (
                            <shortcut.icon className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <span className="typography-meta">
                            {t(shortcut.descriptionKey)}
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
              <RiQuestionLine className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
              <div className="typography-meta text-muted-foreground">
                <p className="font-medium mb-1">{t('helpDialog.proTips.title')}</p>
                <ul className="space-y-0.5 typography-meta">
                  <li>
                    • {t('helpDialog.proTips.commandPalette', {
                      shortcut: renderShortcut('open_command_palette', `${mod} P`, shortcutOverrides),
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
