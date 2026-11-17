import { create } from 'zustand';

export type ChatSettingsTab = 'messages' | 'composer' | 'assistance';

/**
 * The tab the Settings Chat page shows. It lives outside the page so a
 * Settings search result can open the tab that holds its target before the
 * page highlights it, and so leaving the page and coming back keeps the tab.
 */
export const useChatSettingsTabStore = create<{
  tab: ChatSettingsTab;
  setTab: (tab: ChatSettingsTab) => void;
}>((set) => ({
  tab: 'messages',
  setTab: (tab) => set({ tab }),
}));

const SEARCH_TARGET_TABS = new Map<string, ChatSettingsTab>([
  ['chat.activity-default', 'messages'],
  ['chat.reasoning', 'messages'],
  ['chat.reasoning-traces', 'messages'],
  ['chat.tool-file-icons', 'messages'],
  ['chat.changed-files', 'messages'],
  ['chat.streaming-auto-follow', 'messages'],
  ['chat.message-appearance', 'messages'],
  ['chat.wide-layout', 'messages'],
  ['chat.prompt-navigator', 'messages'],
  ['chat.collapsible-user-messages', 'messages'],
  ['chat.sticky-user-header', 'messages'],
  ['chat.inline-assistant-actions', 'messages'],
  ['chat.user-message-rendering', 'messages'],
  ['chat.mermaid-rendering', 'messages'],
  ['chat.diff-layout', 'messages'],
  ['chat.code-block-line-wrap', 'messages'],
  ['chat.table-cell-wrap', 'messages'],
  ['chat.copy-plain-text', 'messages'],
  ['chat.message-search', 'messages'],
  ['chat.message-search-enabled', 'messages'],
  ['chat.message-search-reasoning', 'messages'],
  ['chat.composer', 'composer'],
  ['chat.enter-to-send', 'composer'],
  ['chat.follow-up-behavior', 'composer'],
  ['chat.large-text-paste', 'composer'],
  ['chat.active-run-model-change', 'composer'],
  ['chat.subagent-read-only-banner', 'composer'],
  ['chat.save-pasted-images', 'composer'],
  ['chat.persist-drafts', 'composer'],
  ['chat.spellcheck', 'composer'],
  ['chat.input-history-scope', 'composer'],
  ['chat.input-history-limit', 'composer'],
  ['chat.session-assistance', 'assistance'],
  ['chat.draft-starters-visible', 'assistance'],
  ['chat.session-recap', 'assistance'],
  ['chat.session-suggestion', 'assistance'],
  ['chat.session-review-offer', 'assistance'],
  ['chat.session-goal', 'assistance'],
  ['chat.session-goal-checker', 'assistance'],
  ['chat.session-goal-max-turns', 'assistance'],
  ['chat.session-goal-budget', 'assistance'],
  ['chat.session-goal-length', 'assistance'],
  ['chat.session-goal-check-length', 'assistance'],
  ['chat.session-goal-writer', 'assistance'],
  ['chat.session-goal-writer-model', 'assistance'],
  ['chat.session-goal-writer-remember', 'assistance'],
  ['chat.session-goal-writer-review', 'assistance'],
  ['chat.session-goal-writer-send-mode', 'assistance'],
  ['chat.session-goal-rewrite-all', 'assistance'],
  ['chat.session-goal-auto-create', 'assistance'],
  ['chat.model-choices', 'assistance'],
  ['chat.model-choice-recording', 'assistance'],
]);

export const chatSettingsTabForSearchTarget = (id: string): ChatSettingsTab | null => SEARCH_TARGET_TABS.get(id) ?? null;
