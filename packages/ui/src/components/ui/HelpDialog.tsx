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
import { useLanguage } from "@/hooks/useLanguage";

type ShortcutIcon = React.ComponentType<{ className?: string }>;

type ShortcutItem = {
  id?: string;
  keys: string | string[];
  description: string;
  icon: ShortcutIcon | null;
};

type ShortcutSection = {
  category: string;
  items: ShortcutItem[];
};

const renderShortcut = (id: string, fallbackCombo: string, overrides: Record<string, string>) => {
  const action = getShortcutAction(id);
  return action ? formatShortcutForDisplay(getEffectiveShortcutCombo(id, overrides)) : fallbackCombo;
};

export const HelpDialog: React.FC = () => {
  const { t } = useLanguage();
  const { isHelpDialogOpen, setHelpDialogOpen, shortcutOverrides } = useUIStore();
  const mod = getModifierLabel();

  const shortcuts: ShortcutSection[] = [
    {
      category: t('keyboardShortcutsDialog.sections.navigationCommands'),
      items: [
        {
          id: 'open_command_palette',
          description: t('keyboardShortcutsDialog.items.openCommandPalette'),
          icon: RiCommandLine,
          keys: '',
        },
        {
          id: 'open_help',
          description: t('keyboardShortcutsDialog.items.showKeyboardShortcuts'),
          icon: RiQuestionLine,
          keys: '',
        },
        {
          id: 'toggle_sidebar',
          description: t('keyboardShortcutsDialog.items.toggleSessionSidebar'),
          icon: RiLayoutLeftLine,
          keys: '',
        },
        {
          keys: ["Tab"],
          description: t('keyboardShortcutsDialog.items.cycleAgent'),
          icon: RiAiAgentLine,
        },
        {
          id: 'open_model_selector',
          description: t('keyboardShortcutsDialog.items.openModelSelector'),
          icon: RiAiGenerate2,
          keys: '',
        },
        {
          id: 'cycle_thinking_variant',
          description: t('keyboardShortcutsDialog.items.cycleThinkingVariant'),
          icon: RiBrainAi3Line,
          keys: '',
        },
        {
          keys: [`Shift + Alt + ${mod} + N`],
          description: t('keyboardShortcutsDialog.items.newWindowDesktopOnly'),
          icon: RiWindowLine,
        },
      ],
    },
    {
      category: t('keyboardShortcutsDialog.sections.sessionManagement'),
      items: [
        {
          id: 'new_chat',
          description: t('keyboardShortcutsDialog.items.createNewSession'),
          icon: RiAddLine,
          keys: '',
        },
        {
          id: 'new_chat_worktree',
          description: t('keyboardShortcutsDialog.items.createNewSessionInWorktree'),
          icon: RiGitBranchLine,
          keys: '',
        },
        { id: 'focus_input', description: t('keyboardShortcutsDialog.items.focusChatInput'), icon: RiText, keys: '' },
        {
          id: 'abort_run',
          description: t('keyboardShortcutsDialog.items.abortActiveRun'),
          icon: RiCloseCircleLine,
          keys: '',
        },
      ],
    },
    {
      category: t('keyboardShortcutsDialog.sections.panels'),
      items: [
        {
          id: 'toggle_right_sidebar',
          description: t('keyboardShortcutsDialog.items.toggleRightSidebar'),
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'open_right_sidebar_git',
          description: t('keyboardShortcutsDialog.items.openRightSidebarGitTab'),
          icon: RiGitBranchLine,
          keys: '',
        },
        {
          id: 'open_right_sidebar_files',
          description: t('keyboardShortcutsDialog.items.openRightSidebarFilesTab'),
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'cycle_right_sidebar_tab',
          description: t('keyboardShortcutsDialog.items.cycleRightSidebarTab'),
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'toggle_terminal',
          description: t('keyboardShortcutsDialog.items.toggleTerminalDock'),
          icon: RiWindowLine,
          keys: '',
        },
        {
          id: 'toggle_terminal_expanded',
          description: t('keyboardShortcutsDialog.items.toggleTerminalExpanded'),
          icon: RiWindowLine,
          keys: '',
        },
        {
          id: 'toggle_context_plan',
          description: t('keyboardShortcutsDialog.items.togglePlanContextPanel'),
          icon: RiTimeLine,
          keys: '',
        },
      ],
    },
    {
      category: t('keyboardShortcutsDialog.sections.interface'),
      items: [
        {
          id: 'cycle_theme',
          description: t('keyboardShortcutsDialog.items.cycleTheme'),
          icon: RiPaletteLine,
          keys: '',
        },
        {
          keys: [`${mod} + 1...9`],
          description: t('keyboardShortcutsDialog.items.switchProject'),
          icon: RiLayoutLeftLine,
        },
        {
          id: 'open_timeline',
          description: t('keyboardShortcutsDialog.items.openTimeline'),
          icon: RiTimeLine,
          keys: '',
        },
        {
          id: 'toggle_services_menu',
          description: t('keyboardShortcutsDialog.items.toggleServicesMenu'),
          icon: RiStackLine,
          keys: '',
        },
        {
          id: 'cycle_services_tab',
          description: t('keyboardShortcutsDialog.items.cycleServicesTab'),
          icon: RiStackLine,
          keys: '',
        },
        {
          id: 'open_settings',
          description: t('keyboardShortcutsDialog.items.openSettings'),
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
            {t('keyboardShortcutsDialog.title')}
          </DialogTitle>
          <DialogDescription>
            {t('keyboardShortcutsDialog.description')}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto mt-3 pr-1">
          <div className="space-y-4">
            {shortcuts.map((section) => (
              <div key={section.category}>
                <h3 className="typography-meta font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                  {section.category}
                </h3>
                <div className="space-y-1">
                  {section.items.map((shortcut, index) => {
                    const displayKeys = shortcut.id
                      ? renderShortcut(shortcut.id, Array.isArray(shortcut.keys) ? shortcut.keys[0] : shortcut.keys, shortcutOverrides)
                      : (Array.isArray(shortcut.keys) ? shortcut.keys : shortcut.keys.split(" / "));

                    return (
                      <div
                        key={index}
                        className="flex items-center justify-between py-1 px-2"
                      >
                        <div className="flex items-center gap-2">
                          {shortcut.icon && (
                            <shortcut.icon className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                          <span className="typography-meta">
                            {shortcut.description}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          {(Array.isArray(displayKeys) ? displayKeys : [displayKeys]).map((keyCombo: string, i: number) => (
                            <React.Fragment key={`${keyCombo}-${i}`}>
                              {i > 0 && (
                                <span className="typography-meta text-muted-foreground mx-1">
                                  {t('keyboardShortcutsDialog.connector.or')}
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
                <p className="font-medium mb-1">{t('keyboardShortcutsDialog.proTips.title')}</p>
                <ul className="space-y-0.5 typography-meta">
                  <li>
                    • {t('keyboardShortcutsDialog.proTips.useCommandPalette', {
                      shortcut: renderShortcut('open_command_palette', `${mod} K`, shortcutOverrides),
                    })}
                  </li>
                  <li>
                    • {t('keyboardShortcutsDialog.proTips.recentSessionsInPalette')}
                  </li>
                  <li>
                    • {t('keyboardShortcutsDialog.proTips.themeCyclingPersists')}
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
