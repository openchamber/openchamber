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
import { m } from "@/lib/i18n/messages";

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
  const isHelpDialogOpen = useUIStore((state) => state.isHelpDialogOpen);
  const setHelpDialogOpen = useUIStore((state) => state.setHelpDialogOpen);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const mod = getModifierLabel();

  const shortcuts: ShortcutSection[] = [
    {
      category: m.helpNavCommands(),
      items: [
        {
          id: 'open_command_palette',
          description: m.helpOpenCommandPalette(),
          icon: RiCommandLine,
          keys: '',
        },
        {
          id: 'open_help',
          description: m.helpShowShortcuts(),
          icon: RiQuestionLine,
          keys: '',
        },
        {
          id: 'toggle_sidebar',
          description: m.helpToggleSessionSidebar(),
          icon: RiLayoutLeftLine,
          keys: '',
        },
        {
          keys: ["Tab"],
          description: m.helpCycleAgent(),
          icon: RiAiAgentLine,
        },
        {
          id: 'open_model_selector',
          description: m.helpOpenModelSelector(),
          icon: RiAiGenerate2,
          keys: '',
        },
        {
          keys: ["↑↓"],
          description: m.helpNavigateModels(),
          icon: RiAiGenerate2,
        },
        {
          keys: ["←→"],
          description: m.helpAdjustThinkingMode(),
          icon: RiBrainAi3Line,
        },
        {
          id: 'cycle_thinking_variant',
          description: m.helpCycleThinkingVariant(),
          icon: RiBrainAi3Line,
          keys: '',
        },
        {
          keys: [`Shift + Alt + ${mod} + N`],
          description: m.helpNewWindow(),
          icon: RiWindowLine,
        },
      ],
    },
    {
      category: m.helpSessionManagement(),
      items: [
        {
          id: 'new_chat',
          description: m.cmdNewSession(),
          icon: RiAddLine,
          keys: '',
        },
        {
          id: 'new_chat_worktree',
          description: m.cmdNewWorktreeDraft(),
          icon: RiGitBranchLine,
          keys: '',
        },
        { id: 'focus_input', description: m.helpFocusChatInput(), icon: RiText, keys: '' },
        {
          id: 'abort_run',
          description: m.helpAbortRun(),
          icon: RiCloseCircleLine,
          keys: '',
        },
      ],
    },
    {
      category: m.helpPanels(),
      items: [
        {
          id: 'toggle_right_sidebar',
          description: m.cmdToggleRightSidebar(),
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'open_right_sidebar_git',
          description: m.cmdOpenRightSidebarGit(),
          icon: RiGitBranchLine,
          keys: '',
        },
        {
          id: 'open_right_sidebar_files',
          description: m.cmdOpenRightSidebarFiles(),
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'cycle_right_sidebar_tab',
          description: m.helpCycleRightSidebarTab(),
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'toggle_terminal',
          description: m.cmdToggleTerminalDock(),
          icon: RiWindowLine,
          keys: '',
        },
        {
          id: 'toggle_terminal_expanded',
          description: m.cmdToggleTerminalExpanded(),
          icon: RiWindowLine,
          keys: '',
        },
        {
          id: 'toggle_context_plan',
          description: m.helpTogglePlanContext(),
          icon: RiTimeLine,
          keys: '',
        },
      ],
    },
    {
      category: m.helpInterface(),
      items: [
        {
          id: 'cycle_theme',
          description: m.helpCycleTheme(),
          icon: RiPaletteLine,
          keys: '',
        },
        {
          keys: [`${mod} + 1...9`],
          description: m.helpSwitchProject(),
          icon: RiLayoutLeftLine,
        },
        {
          id: 'toggle_services_menu',
          description: m.helpToggleServicesMenu(),
          icon: RiStackLine,
          keys: '',
        },
        {
          id: 'cycle_services_tab',
          description: m.helpCycleServicesTab(),
          icon: RiStackLine,
          keys: '',
        },
        {
          id: 'open_settings',
          description: m.cmdOpenSettings(),
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
            {m.helpKeyboardShortcuts()}
          </DialogTitle>
          <DialogDescription>
            {m.helpShortcutsDesc()}
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
                                  {m.helpOr()}
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
                <p className="font-medium mb-1">{m.helpProTips()}</p>
                <ul className="space-y-0.5 typography-meta">
                  <li>
                    • {m.helpTipCommandPalette()} ({renderShortcut('open_command_palette', `${mod} K`, shortcutOverrides)})
                  </li>
                  <li>
                    • {m.helpTipRecentSessions()}
                  </li>
                  <li>
                    • {m.helpTipThemeCycling()}
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
