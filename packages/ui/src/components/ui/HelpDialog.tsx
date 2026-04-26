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
  RiFileLine,
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
      category: "Navigation & Commands",
      items: [
        {
          id: 'open_command_palette',
          description: "Open Command Palette",
          icon: RiCommandLine,
          keys: '',
        },
        {
          id: 'open_quick_open',
          description: 'Quick open file',
          icon: RiFileLine,
          keys: '',
        },
        {
          id: 'open_help',
          description: "Show Keyboard Shortcuts (this dialog)",
          icon: RiQuestionLine,
          keys: '',
        },
        {
          id: 'toggle_sidebar',
          description: "Toggle Session Sidebar",
          icon: RiLayoutLeftLine,
          keys: '',
        },
        {
          keys: ["Tab"],
          description: "Cycle Agent (chat input)",
          icon: RiAiAgentLine,
        },
        {
          id: 'open_model_selector',
          description: "Open Model Selector",
          icon: RiAiGenerate2,
          keys: '',
        },
        {
          keys: ["↑↓"],
          description: "Navigate Models (in picker)",
          icon: RiAiGenerate2,
        },
        {
          keys: ["←→"],
          description: "Adjust Thinking Mode (in picker, when supported)",
          icon: RiBrainAi3Line,
        },
        {
          id: 'cycle_thinking_variant',
          description: "Cycle Thinking Variant (global shortcut)",
          icon: RiBrainAi3Line,
          keys: '',
        },
        {
          keys: [`Shift + Alt + ${mod} + N`],
          description: "New Window (desktop only)",
          icon: RiWindowLine,
        },
      ],
    },
    {
      category: "Session Management",
      items: [
        {
          id: 'new_chat',
          description: "Create New Session",
          icon: RiAddLine,
          keys: '',
        },
        {
          id: 'new_chat_worktree',
          description: "Create New Worktree Draft",
          icon: RiGitBranchLine,
          keys: '',
        },
        { id: 'focus_input', description: "Focus Chat Input", icon: RiText, keys: '' },
        {
          id: 'abort_run',
          description: "Abort active run (double press)",
          icon: RiCloseCircleLine,
          keys: '',
        },
      ],
    },
    {
      category: "Panels",
      items: [
        {
          id: 'toggle_right_sidebar',
          description: 'Toggle Right Sidebar',
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'open_right_sidebar_git',
          description: 'Open Right Sidebar Git Tab',
          icon: RiGitBranchLine,
          keys: '',
        },
        {
          id: 'open_right_sidebar_files',
          description: 'Open Right Sidebar Files Tab',
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'cycle_right_sidebar_tab',
          description: 'Cycle Right Sidebar Tab',
          icon: RiLayoutRightLine,
          keys: '',
        },
        {
          id: 'toggle_terminal',
          description: 'Toggle Terminal Dock',
          icon: RiWindowLine,
          keys: '',
        },
        {
          id: 'toggle_terminal_expanded',
          description: 'Toggle Terminal Expanded',
          icon: RiWindowLine,
          keys: '',
        },
        {
          id: 'toggle_context_plan',
          description: 'Toggle Plan Context Panel',
          icon: RiTimeLine,
          keys: '',
        },
      ],
    },
    {
      category: "Interface",
      items: [
        {
          id: 'cycle_theme',
          description: "Cycle Theme (Light → Dark → System)",
          icon: RiPaletteLine,
          keys: '',
        },
        {
          keys: [`${mod} + 1...9`],
          description: "Switch Project",
          icon: RiLayoutLeftLine,
        },
        {
          id: 'toggle_services_menu',
          description: 'Toggle Services Menu',
          icon: RiStackLine,
          keys: '',
        },
        {
          id: 'cycle_services_tab',
          description: 'Cycle Services Tab',
          icon: RiStackLine,
          keys: '',
        },
        {
          id: 'open_settings',
          description: "Open Settings",
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
            Keyboard Shortcuts
          </DialogTitle>
          <DialogDescription>
            Use these keyboard shortcuts to navigate OpenChamber efficiently
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
                  {section.items.map((shortcut) => {
                    const displayKeys = shortcut.id
                      ? renderShortcut(shortcut.id, Array.isArray(shortcut.keys) ? shortcut.keys[0] : shortcut.keys, shortcutOverrides)
                      : (Array.isArray(shortcut.keys) ? shortcut.keys : shortcut.keys.split(" / "));

                    return (
                      <div
                        key={shortcut.id || shortcut.description}
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
                                  or
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
                <p className="font-medium mb-1">Pro Tips:</p>
                <ul className="space-y-0.5 typography-meta">
                  <li>
                    • Use Command Palette ({renderShortcut('open_command_palette', `${mod} K`, shortcutOverrides)}) to quickly access all
                    actions
                  </li>
                  <li>
                    • The 5 most recent sessions appear in the Command Palette
                  </li>
                  <li>
                    • Theme cycling remembers your preference across sessions
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
