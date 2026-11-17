import React from 'react';

import { NumberInput } from '@/components/ui/number-input';
import { SortableTabsStrip, type SortableTabsStripItem } from '@/components/ui/sortable-tabs-strip';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsChipGroup,
  SettingsControlGroup,
  SettingsRadioGroup,
  SettingsRadioOption,
  SETTINGS_NUMBER_INPUT_CLASS,
  SETTINGS_NUMBER_STEPPER_ROW_CLASS,
  SETTINGS_NUMBER_UNIT_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { JevAccessNote } from '@/components/sections/classification/JevAccessNote';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useDeviceInfo } from '@/lib/device';
import { useI18n, type I18nKey } from '@/lib/i18n';
import {
  MAX_INPUT_HISTORY_LIMIT,
  MIN_INPUT_HISTORY_LIMIT,
  isInputHistoryLimit,
  type InputHistoryScope,
} from '@/lib/inputHistoryScope';
import { updateDesktopSettings } from '@/lib/persistence';
import { useInputHistoryStore } from '@/stores/useInputHistoryStore';
import { useMessageQueueStore, type FollowUpBehavior } from '@/stores/messageQueueStore';
import { selectSafetyNetAvailable, useRoutingStore } from '@/stores/useRoutingStore';
import {
  useUIStore,
  type ActiveRunModelChangeBehavior,
  type LargeTextPasteBehavior,
} from '@/stores/useUIStore';

import { MessageSearchSettings } from './MessageSearchSettings';
import { ModelChoiceSettings } from './ModelChoiceSettings';
import { SessionGoalCheckerField, SessionGoalLengthFields, SessionGoalMaxTurnsField } from './SessionGoalCheckerField';
import { SessionGoalWriterFields } from './SessionGoalWriterFields';
import { useChatSettingsTabStore, type ChatSettingsTab } from './chatSettingsTabs';

type ChipOption<T extends string> = { id: T; labelKey: I18nKey };

const ACTIVITY_RENDER_MODE_OPTIONS: ChipOption<'collapsed' | 'summary'>[] = [
  { id: 'collapsed', labelKey: 'settings.openchamber.visual.option.activityRenderMode.collapsed.label' },
  { id: 'summary', labelKey: 'settings.openchamber.visual.option.activityRenderMode.summary.label' },
];

const USER_MESSAGE_RENDERING_OPTIONS: ChipOption<'markdown' | 'plain'>[] = [
  { id: 'markdown', labelKey: 'settings.openchamber.visual.option.userMessageRendering.markdown.label' },
  { id: 'plain', labelKey: 'settings.openchamber.visual.option.userMessageRendering.plain.label' },
];

const MERMAID_RENDERING_OPTIONS: ChipOption<'svg' | 'ascii'>[] = [
  { id: 'svg', labelKey: 'settings.openchamber.visual.option.mermaidRendering.svg.label' },
  { id: 'ascii', labelKey: 'settings.openchamber.visual.option.mermaidRendering.ascii.label' },
];

const DIFF_LAYOUT_OPTIONS: ChipOption<'dynamic' | 'inline' | 'side-by-side'>[] = [
  { id: 'dynamic', labelKey: 'settings.openchamber.visual.option.diffLayout.dynamic.label' },
  { id: 'inline', labelKey: 'settings.openchamber.visual.option.diffLayout.inline.label' },
  { id: 'side-by-side', labelKey: 'settings.openchamber.visual.option.diffLayout.sideBySide.label' },
];

const FOLLOW_UP_BEHAVIOR_OPTIONS: ChipOption<FollowUpBehavior>[] = [
  { id: 'steer', labelKey: 'settings.openchamber.visual.option.followUpBehavior.steer.label' },
  { id: 'queue', labelKey: 'settings.openchamber.visual.option.followUpBehavior.queue.label' },
];

const INPUT_HISTORY_SCOPE_OPTIONS: ChipOption<InputHistoryScope>[] = [
  { id: 'global', labelKey: 'settings.openchamber.visual.option.inputHistoryScope.global.label' },
  { id: 'session', labelKey: 'settings.openchamber.visual.option.inputHistoryScope.session.label' },
];

const LARGE_TEXT_PASTE_BEHAVIOR_OPTIONS: ChipOption<LargeTextPasteBehavior>[] = [
  { id: 'ask', labelKey: 'settings.openchamber.visual.option.largeTextPaste.ask.label' },
  { id: 'attach', labelKey: 'settings.openchamber.visual.option.largeTextPaste.attach.label' },
  { id: 'inline', labelKey: 'settings.openchamber.visual.option.largeTextPaste.inline.label' },
  { id: 'inline-double-paste', labelKey: 'settings.openchamber.visual.option.largeTextPaste.inlineDoublePaste.label' },
];

const ACTIVE_RUN_MODEL_CHANGE_OPTIONS: ChipOption<ActiveRunModelChangeBehavior>[] = [
  { id: 'next-message', labelKey: 'settings.openchamber.visual.option.activeRunModelChange.nextMessage.label' },
  { id: 'restart', labelKey: 'settings.openchamber.visual.option.activeRunModelChange.restart.label' },
];

/** A sub-option that only matters while the option above it is on. */
const NESTED_OPTION_CLASS = 'ps-6';

const useChipOptions = <T extends string>(options: ChipOption<T>[]) => {
  const { t } = useI18n();
  return React.useMemo(() => options.map((option) => ({ value: option.id, label: t(option.labelKey) })), [options, t]);
};

/** How the transcript reads: agent activity, layout, formatting, search. */
const MessagesTab: React.FC = () => {
  const { t } = useI18n();
  const isVSCode = isVSCodeRuntime();
  const activityRenderMode = useUIStore((state) => state.activityRenderMode);
  const setActivityRenderMode = useUIStore((state) => state.setActivityRenderMode);
  const showReasoningTraces = useUIStore((state) => state.showReasoningTraces);
  const setShowReasoningTraces = useUIStore((state) => state.setShowReasoningTraces);
  const collapsibleThinkingBlocks = useUIStore((state) => state.collapsibleThinkingBlocks);
  const setCollapsibleThinkingBlocks = useUIStore((state) => state.setCollapsibleThinkingBlocks);
  const expandReasoningWhileStreaming = useUIStore((state) => state.expandReasoningWhileStreaming);
  const setExpandReasoningWhileStreaming = useUIStore((state) => state.setExpandReasoningWhileStreaming);
  const showToolFileIcons = useUIStore((state) => state.showToolFileIcons);
  const setShowToolFileIcons = useUIStore((state) => state.setShowToolFileIcons);
  const showTurnChangedFiles = useUIStore((state) => state.showTurnChangedFiles);
  const setShowTurnChangedFiles = useUIStore((state) => state.setShowTurnChangedFiles);
  const streamingAutoFollowEnabled = useUIStore((state) => state.streamingAutoFollowEnabled);
  const setStreamingAutoFollowEnabled = useUIStore((state) => state.setStreamingAutoFollowEnabled);
  const wideChatLayoutEnabled = useUIStore((state) => state.wideChatLayoutEnabled);
  const setWideChatLayoutEnabled = useUIStore((state) => state.setWideChatLayoutEnabled);
  const promptNavigatorEnabled = useUIStore((state) => state.promptNavigatorEnabled);
  const setPromptNavigatorEnabled = useUIStore((state) => state.setPromptNavigatorEnabled);
  const collapsibleUserMessages = useUIStore((state) => state.collapsibleUserMessages);
  const setCollapsibleUserMessages = useUIStore((state) => state.setCollapsibleUserMessages);
  const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
  const setStickyUserHeader = useUIStore((state) => state.setStickyUserHeader);
  const showSplitAssistantMessageActions = useUIStore((state) => state.showSplitAssistantMessageActions);
  const setShowSplitAssistantMessageActions = useUIStore((state) => state.setShowSplitAssistantMessageActions);
  const userMessageRenderingMode = useUIStore((state) => state.userMessageRenderingMode);
  const setUserMessageRenderingMode = useUIStore((state) => state.setUserMessageRenderingMode);
  const mermaidRenderingMode = useUIStore((state) => state.mermaidRenderingMode);
  const setMermaidRenderingMode = useUIStore((state) => state.setMermaidRenderingMode);
  const diffLayoutPreference = useUIStore((state) => state.diffLayoutPreference);
  const setDiffLayoutPreference = useUIStore((state) => state.setDiffLayoutPreference);
  const codeBlockLineWrap = useUIStore((state) => state.codeBlockLineWrap);
  const setCodeBlockLineWrap = useUIStore((state) => state.setCodeBlockLineWrap);
  const tableCellWrap = useUIStore((state) => state.tableCellWrap);
  const setTableCellWrap = useUIStore((state) => state.setTableCellWrap);
  const copyMessagesAsPlainText = useUIStore((state) => state.copyMessagesAsPlainText);
  const setCopyMessagesAsPlainText = useUIStore((state) => state.setCopyMessagesAsPlainText);
  const activityOptions = useChipOptions(ACTIVITY_RENDER_MODE_OPTIONS);
  const userMessageOptions = useChipOptions(USER_MESSAGE_RENDERING_OPTIONS);
  const mermaidOptions = useChipOptions(MERMAID_RENDERING_OPTIONS);
  const diffLayoutOptions = useChipOptions(DIFF_LAYOUT_OPTIONS);

  const handleActivityRenderModeChange = (mode: 'collapsed' | 'summary') => {
    setActivityRenderMode(mode);
    // A stored legacy 'sorted' chat mode reads as Collapsed until the user
    // picks a mode here; retire it so the choice sticks.
    void updateDesktopSettings({ activityRenderMode: mode, chatRenderMode: 'live' });
  };

  return (
    <>
      <SettingsSection title={t('settings.layout.chat.section.activity')} divider={false} contentClassName="space-y-3">
        <SettingsFieldRow label={t('settings.openchamber.visual.section.activityDefault')} settingsItem="chat.activity-default">
          <SettingsChipGroup
            value={activityRenderMode}
            options={activityOptions}
            onChange={handleActivityRenderModeChange}
            aria-label={t('settings.openchamber.visual.section.activityDefaultAria')}
          />
        </SettingsFieldRow>
        <div className={SETTINGS_OPTION_STACK_CLASS} data-settings-item="chat.reasoning">
          <SettingsCheckboxRow
            checked={showReasoningTraces}
            onChange={setShowReasoningTraces}
            label={t('settings.openchamber.visual.field.showReasoningTraces')}
            ariaLabel={t('settings.openchamber.visual.field.showReasoningTracesAria')}
            settingsItem="chat.reasoning-traces"
          />
          {showReasoningTraces ? (
            <SettingsCheckboxRow
              checked={collapsibleThinkingBlocks}
              onChange={setCollapsibleThinkingBlocks}
              label={t('settings.openchamber.visual.field.collapsibleThinkingBlocks')}
              ariaLabel={t('settings.openchamber.visual.field.collapsibleThinkingBlocksAria')}
              className={NESTED_OPTION_CLASS}
            />
          ) : null}
          {/* Only a collapsible block can fold while it streams. */}
          {showReasoningTraces && collapsibleThinkingBlocks ? (
            <SettingsCheckboxRow
              checked={expandReasoningWhileStreaming}
              onChange={setExpandReasoningWhileStreaming}
              label={t('settings.openchamber.visual.field.expandReasoningWhileStreaming')}
              ariaLabel={t('settings.openchamber.visual.field.expandReasoningWhileStreamingAria')}
              info={t('settings.openchamber.visual.field.expandReasoningWhileStreamingInfo')}
              className={NESTED_OPTION_CLASS}
            />
          ) : null}
          <SettingsCheckboxRow
            checked={showToolFileIcons}
            onChange={(enabled) => {
              setShowToolFileIcons(enabled);
              void updateDesktopSettings({ showToolFileIcons: enabled });
            }}
            label={t('settings.openchamber.visual.field.showToolFileIcons')}
            ariaLabel={t('settings.openchamber.visual.field.showToolFileIconsAria')}
            settingsItem="chat.tool-file-icons"
          />
          <SettingsCheckboxRow
            checked={showTurnChangedFiles}
            onChange={(enabled) => {
              setShowTurnChangedFiles(enabled);
              void updateDesktopSettings({ showTurnChangedFiles: enabled });
            }}
            label={t('settings.openchamber.visual.field.showTurnChangedFiles')}
            ariaLabel={t('settings.openchamber.visual.field.showTurnChangedFilesAria')}
            settingsItem="chat.changed-files"
          />
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.layout.chat.section.reading')}
        settingsItem="chat.message-appearance"
        contentClassName={SETTINGS_OPTION_STACK_CLASS}
      >
        <SettingsCheckboxRow
          checked={wideChatLayoutEnabled}
          onChange={(enabled) => {
            setWideChatLayoutEnabled(enabled);
            void updateDesktopSettings({ wideChatLayoutEnabled: enabled });
          }}
          label={t('settings.openchamber.visual.field.wideChatLayout')}
          ariaLabel={t('settings.openchamber.visual.field.wideChatLayoutAria')}
          settingsItem="chat.wide-layout"
        />
        <SettingsCheckboxRow
          checked={streamingAutoFollowEnabled}
          onChange={setStreamingAutoFollowEnabled}
          label={t('settings.openchamber.visual.field.streamingAutoFollow')}
          ariaLabel={t('settings.openchamber.visual.field.streamingAutoFollowAria')}
          info={t('settings.openchamber.visual.field.streamingAutoFollowInfo')}
          settingsItem="chat.streaming-auto-follow"
        />
        <SettingsCheckboxRow
          checked={collapsibleUserMessages}
          onChange={(enabled) => {
            setCollapsibleUserMessages(enabled);
            void updateDesktopSettings({ collapsibleUserMessages: enabled });
          }}
          label={t('settings.openchamber.visual.field.collapsibleUserMessages')}
          ariaLabel={t('settings.openchamber.visual.field.collapsibleUserMessagesAria')}
          settingsItem="chat.collapsible-user-messages"
        />
        <SettingsCheckboxRow
          checked={stickyUserHeader}
          onChange={(enabled) => {
            setStickyUserHeader(enabled);
            void updateDesktopSettings({ stickyUserHeader: enabled });
          }}
          label={t('settings.openchamber.visual.field.stickyUserHeader')}
          ariaLabel={t('settings.openchamber.visual.field.stickyUserHeaderAria')}
          settingsItem="chat.sticky-user-header"
        />
        <SettingsCheckboxRow
          checked={promptNavigatorEnabled}
          onChange={(enabled) => {
            setPromptNavigatorEnabled(enabled);
            void updateDesktopSettings({ promptNavigatorEnabled: enabled });
          }}
          label={t('settings.openchamber.visual.field.promptNavigatorEnabled')}
          ariaLabel={t('settings.openchamber.visual.field.promptNavigatorEnabledAria')}
          settingsItem="chat.prompt-navigator"
        />
        <SettingsCheckboxRow
          checked={showSplitAssistantMessageActions}
          onChange={(enabled) => {
            setShowSplitAssistantMessageActions(enabled);
            void updateDesktopSettings({ showSplitAssistantMessageActions: enabled });
          }}
          label={t('settings.openchamber.visual.field.showSplitAssistantMessageActions')}
          ariaLabel={t('settings.openchamber.visual.field.showSplitAssistantMessageActionsAria')}
          info={t('settings.openchamber.visual.field.showSplitAssistantMessageActionsTooltip')}
          settingsItem="chat.inline-assistant-actions"
        />
      </SettingsSection>

      <SettingsSection title={t('settings.layout.chat.section.formatting')} contentClassName="space-y-3">
        <div>
          <SettingsFieldRow label={t('settings.openchamber.visual.section.userMessageRendering')} settingsItem="chat.user-message-rendering">
            <SettingsChipGroup
              value={userMessageRenderingMode === 'markdown' ? 'markdown' : 'plain'}
              options={userMessageOptions}
              onChange={(mode) => {
                setUserMessageRenderingMode(mode);
                void updateDesktopSettings({ userMessageRenderingMode: mode });
              }}
              aria-label={t('settings.openchamber.visual.section.userMessageRenderingAria')}
            />
          </SettingsFieldRow>
          <SettingsFieldRow label={t('settings.openchamber.visual.section.mermaidRendering')} settingsItem="chat.mermaid-rendering">
            <SettingsChipGroup
              value={mermaidRenderingMode}
              options={mermaidOptions}
              onChange={(mode) => {
                setMermaidRenderingMode(mode);
                void updateDesktopSettings({ mermaidRenderingMode: mode });
              }}
              aria-label={t('settings.openchamber.visual.section.mermaidRenderingAria')}
            />
          </SettingsFieldRow>
          {isVSCode ? null : (
            <SettingsFieldRow label={t('settings.openchamber.visual.section.diffLayout')} settingsItem="chat.diff-layout">
              <SettingsChipGroup
                value={diffLayoutPreference}
                options={diffLayoutOptions}
                onChange={setDiffLayoutPreference}
                aria-label={t('settings.openchamber.visual.section.diffLayoutAria')}
              />
            </SettingsFieldRow>
          )}
        </div>
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            checked={codeBlockLineWrap}
            onChange={setCodeBlockLineWrap}
            label={t('settings.openchamber.visual.field.codeBlockLineWrap')}
            ariaLabel={t('settings.openchamber.visual.field.codeBlockLineWrapAria')}
            settingsItem="chat.code-block-line-wrap"
          />
          <SettingsCheckboxRow
            checked={tableCellWrap}
            onChange={setTableCellWrap}
            label={t('settings.openchamber.visual.field.tableCellWrap')}
            ariaLabel={t('settings.openchamber.visual.field.tableCellWrapAria')}
            info={t('settings.openchamber.visual.field.tableCellWrapInfo')}
            settingsItem="chat.table-cell-wrap"
          />
          <SettingsCheckboxRow
            checked={copyMessagesAsPlainText}
            onChange={setCopyMessagesAsPlainText}
            label={t('settings.openchamber.visual.field.copyMessagesAsPlainText')}
            ariaLabel={t('settings.openchamber.visual.field.copyMessagesAsPlainTextAria')}
            info={t('settings.openchamber.visual.field.copyMessagesAsPlainTextInfo')}
            settingsItem="chat.copy-plain-text"
          />
        </div>
      </SettingsSection>

      {isVSCode ? null : <MessageSearchSettings />}
    </>
  );
};

/** Typing and sending: the send key, follow-ups, pastes, drafts, history. */
const ComposerTab: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const enterToSend = useUIStore((state) => state.enterToSend);
  const setEnterToSend = useUIStore((state) => state.setEnterToSend);
  const enterToSendConfigured = useUIStore((state) => state.enterToSendConfigured);
  const setEnterToSendConfigured = useUIStore((state) => state.setEnterToSendConfigured);
  const followUpBehavior = useMessageQueueStore((state) => state.followUpBehavior);
  const setFollowUpBehavior = useMessageQueueStore((state) => state.setFollowUpBehavior);
  const largeTextPasteBehavior = useUIStore((state) => state.largeTextPasteBehavior);
  const setLargeTextPasteBehavior = useUIStore((state) => state.setLargeTextPasteBehavior);
  const activeRunModelChangeBehavior = useUIStore((state) => state.activeRunModelChangeBehavior);
  const setActiveRunModelChangeBehavior = useUIStore((state) => state.setActiveRunModelChangeBehavior);
  const allowPromptingSubagentSessions = useUIStore((state) => state.allowPromptingSubagentSessions);
  const setAllowPromptingSubagentSessions = useUIStore((state) => state.setAllowPromptingSubagentSessions);
  const savePastedImagesAsFiles = useUIStore((state) => state.savePastedImagesAsFiles);
  const setSavePastedImagesAsFiles = useUIStore((state) => state.setSavePastedImagesAsFiles);
  const persistChatDraft = useUIStore((state) => state.persistChatDraft);
  const setPersistChatDraft = useUIStore((state) => state.setPersistChatDraft);
  const inputSpellcheckEnabled = useUIStore((state) => state.inputSpellcheckEnabled);
  const setInputSpellcheckEnabled = useUIStore((state) => state.setInputSpellcheckEnabled);
  const inputHistoryScope = useInputHistoryStore((state) => state.scope);
  const inputHistoryLimit = useInputHistoryStore((state) => state.entryLimit);
  const applyInputHistoryScope = useInputHistoryStore((state) => state.applyScope);
  const applyInputHistoryLimit = useInputHistoryStore((state) => state.applyEntryLimit);
  const followUpOptions = useChipOptions(FOLLOW_UP_BEHAVIOR_OPTIONS);
  const historyScopeOptions = useChipOptions(INPUT_HISTORY_SCOPE_OPTIONS);
  const enterSendSelected = enterToSendConfigured ? enterToSend : !isMobile;

  const handleEnterToSendChange = (enabled: boolean) => {
    setEnterToSend(enabled);
    setEnterToSendConfigured(true);
    void updateDesktopSettings({ enterToSend: enabled, enterToSendConfigured: true });
  };

  const handleInputHistoryLimitChange = (value: number) => {
    const nextLimit = Math.round(value);
    if (!isInputHistoryLimit(nextLimit)) {
      return;
    }
    applyInputHistoryLimit(nextLimit);
    void updateDesktopSettings({ inputHistoryLimit: nextLimit });
  };

  return (
    <>
      <SettingsSection title={t('settings.layout.chat.section.sending')} divider={false} settingsItem="chat.composer" contentClassName="space-y-5">
        <div>
          {/* Phones send with the keyboard's own button, so there is no send key to pick. */}
          {isMobile ? null : (
            <SettingsFieldRow
              label={t('settings.openchamber.visual.field.enterToSend')}
              info={t('settings.openchamber.visual.field.enterToSendHint')}
              settingsItem="chat.enter-to-send"
            >
              <SettingsChipGroup
                value={enterSendSelected ? 'enter' : 'modifier'}
                options={[
                  { value: 'enter', label: t('settings.openchamber.visual.option.enterToSend.enter.label') },
                  { value: 'modifier', label: t('settings.openchamber.visual.option.enterToSend.modifier.label') },
                ]}
                onChange={(value) => handleEnterToSendChange(value === 'enter')}
                aria-label={t('settings.openchamber.visual.field.enterToSend')}
              />
            </SettingsFieldRow>
          )}
          <SettingsFieldRow
            label={t('settings.openchamber.visual.section.followUpBehavior')}
            settingsItem="chat.follow-up-behavior"
          >
            <SettingsChipGroup
              value={followUpBehavior}
              options={followUpOptions}
              onChange={setFollowUpBehavior}
              aria-label={t('settings.openchamber.visual.section.followUpBehaviorAria')}
            />
          </SettingsFieldRow>
        </div>
        <SettingsControlGroup
          title={t('settings.openchamber.visual.field.largeTextPaste')}
          info={t('settings.openchamber.visual.field.largeTextPasteHint')}
          settingsItem="chat.large-text-paste"
        >
          <SettingsRadioGroup aria-label={t('settings.openchamber.visual.field.largeTextPasteAria')}>
            {LARGE_TEXT_PASTE_BEHAVIOR_OPTIONS.map((option) => (
              <SettingsRadioOption
                key={option.id}
                selected={largeTextPasteBehavior === option.id}
                onSelect={() => setLargeTextPasteBehavior(option.id)}
                label={t(option.labelKey)}
                ariaLabel={t('settings.openchamber.visual.field.largeTextPasteOptionAria', { option: t(option.labelKey) })}
              />
            ))}
          </SettingsRadioGroup>
        </SettingsControlGroup>
        <SettingsControlGroup
          title={t('settings.openchamber.visual.field.activeRunModelChange')}
          info={t('settings.openchamber.visual.field.activeRunModelChangeInfo')}
          settingsItem="chat.active-run-model-change"
        >
          <SettingsRadioGroup aria-label={t('settings.openchamber.visual.field.activeRunModelChange')}>
            {ACTIVE_RUN_MODEL_CHANGE_OPTIONS.map((option) => (
              <SettingsRadioOption
                key={option.id}
                selected={activeRunModelChangeBehavior === option.id}
                onSelect={() => setActiveRunModelChangeBehavior(option.id)}
                label={t(option.labelKey)}
                ariaLabel={t(option.labelKey)}
              />
            ))}
          </SettingsRadioGroup>
        </SettingsControlGroup>
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            checked={allowPromptingSubagentSessions}
            onChange={setAllowPromptingSubagentSessions}
            label={t('settings.openchamber.visual.field.allowPromptingSubagentSessions')}
            ariaLabel={t('settings.openchamber.visual.field.allowPromptingSubagentSessionsAria')}
            settingsItem="chat.subagent-read-only-banner"
          />
          <SettingsCheckboxRow
            checked={savePastedImagesAsFiles}
            onChange={setSavePastedImagesAsFiles}
            label={t('settings.openchamber.visual.field.savePastedImagesAsFiles')}
            ariaLabel={t('settings.openchamber.visual.field.savePastedImagesAsFiles')}
            info={t('settings.openchamber.visual.field.savePastedImagesAsFilesInfo')}
            settingsItem="chat.save-pasted-images"
          />
        </div>
      </SettingsSection>

      <SettingsSection title={t('settings.layout.chat.section.draftsAndHistory')} contentClassName="space-y-3">
        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            checked={persistChatDraft}
            onChange={setPersistChatDraft}
            label={t('settings.openchamber.visual.field.persistDraftMessages')}
            ariaLabel={t('settings.openchamber.visual.field.persistDraftMessagesAria')}
            settingsItem="chat.persist-drafts"
          />
          {isMobile ? null : (
            <SettingsCheckboxRow
              checked={inputSpellcheckEnabled}
              onChange={(enabled) => {
                setInputSpellcheckEnabled(enabled);
                void updateDesktopSettings({ inputSpellcheckEnabled: enabled });
              }}
              label={t('settings.openchamber.visual.field.enableSpellcheckInTextInputs')}
              ariaLabel={t('settings.openchamber.visual.field.enableSpellcheckInTextInputsAria')}
              settingsItem="chat.spellcheck"
            />
          )}
        </div>
        <div>
          <SettingsFieldRow
            label={t('settings.openchamber.visual.field.inputHistoryScope')}
            info={t('settings.openchamber.visual.field.inputHistoryScopeDescription')}
            settingsItem="chat.input-history-scope"
          >
            <SettingsChipGroup
              value={inputHistoryScope}
              options={historyScopeOptions}
              onChange={(scope) => {
                applyInputHistoryScope(scope);
                void updateDesktopSettings({ inputHistoryScope: scope });
              }}
              aria-label={t('settings.openchamber.visual.section.inputHistoryScopeAria')}
            />
          </SettingsFieldRow>
          <SettingsFieldRow
            label={t('settings.openchamber.visual.field.inputHistoryLimit')}
            // Lowering the number drops prompts for good, so this stays visible.
            description={t('settings.openchamber.visual.field.inputHistoryLimitDescription')}
            settingsItem="chat.input-history-limit"
          >
            <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
              <NumberInput
                value={inputHistoryLimit}
                onValueChange={handleInputHistoryLimitChange}
                min={MIN_INPUT_HISTORY_LIMIT}
                max={MAX_INPUT_HISTORY_LIMIT}
                step={1}
                className={SETTINGS_NUMBER_INPUT_CLASS}
                deferExternalValueWhileFocused
                aria-label={t('settings.openchamber.visual.field.inputHistoryLimitAria')}
              />
              <span className={SETTINGS_NUMBER_UNIT_CLASS}>
                {t('settings.openchamber.visual.field.inputHistoryLimitUnit')}
              </span>
            </div>
          </SettingsFieldRow>
        </div>
      </SettingsSection>
    </>
  );
};

/** What OpenChamber adds around a session: starters, recaps, reviews, goals. */
const AssistanceTab: React.FC = () => {
  const { t } = useI18n();
  const isVSCode = isVSCodeRuntime();
  const draftStartersVisible = useUIStore((state) => state.draftStartersVisible);
  const setDraftStartersVisible = useUIStore((state) => state.setDraftStartersVisible);
  const sessionRecapEnabled = useUIStore((state) => state.sessionRecapEnabled);
  const setSessionRecapEnabled = useUIStore((state) => state.setSessionRecapEnabled);
  const sessionSuggestionEnabled = useUIStore((state) => state.sessionSuggestionEnabled);
  const setSessionSuggestionEnabled = useUIStore((state) => state.setSessionSuggestionEnabled);
  const sessionReviewOfferEnabled = useUIStore((state) => state.sessionReviewOfferEnabled);
  const setSessionReviewOfferEnabled = useUIStore((state) => state.setSessionReviewOfferEnabled);
  const jevAvailable = useRoutingStore(selectSafetyNetAvailable);
  const sessionGoalEnabled = useUIStore((state) => state.sessionGoalEnabled);
  const setSessionGoalEnabled = useUIStore((state) => state.setSessionGoalEnabled);
  const sessionGoalDefaultBudgetEnabled = useUIStore((state) => state.sessionGoalDefaultBudgetEnabled);
  const setSessionGoalDefaultBudgetEnabled = useUIStore((state) => state.setSessionGoalDefaultBudgetEnabled);
  const sessionGoalDefaultBudget = useUIStore((state) => state.sessionGoalDefaultBudget);
  const setSessionGoalDefaultBudget = useUIStore((state) => state.setSessionGoalDefaultBudget);

  return (
    <>
      <SettingsSection
        title={t('settings.openchamber.visual.section.sessionAssistance')}
        settingsItem="chat.session-assistance"
        divider={false}
        contentClassName={SETTINGS_OPTION_STACK_CLASS}
      >
        <SettingsCheckboxRow
          checked={draftStartersVisible}
          onChange={(enabled) => {
            setDraftStartersVisible(enabled);
            void updateDesktopSettings({ draftStartersVisible: enabled });
          }}
          label={t('settings.openchamber.visual.field.draftStartersVisible')}
          ariaLabel={t('settings.openchamber.visual.field.draftStartersVisibleAria')}
          settingsItem="chat.draft-starters-visible"
        />
        <SettingsCheckboxRow
          checked={sessionRecapEnabled}
          onChange={setSessionRecapEnabled}
          label={t('settings.openchamber.visual.field.sessionRecap')}
          ariaLabel={t('settings.openchamber.visual.field.sessionRecapAria')}
          settingsItem="chat.session-recap"
        />
        <SettingsCheckboxRow
          checked={sessionSuggestionEnabled}
          onChange={setSessionSuggestionEnabled}
          label={t('settings.openchamber.visual.field.sessionSuggestion')}
          ariaLabel={t('settings.openchamber.visual.field.sessionSuggestionAria')}
          settingsItem="chat.session-suggestion"
        />
        {/* Jev runs on the OpenChamber server, which VS Code does not have.
            The line naming who decides sits under the label, so it reads as
            part of this option rather than text between two checkboxes. */}
        {isVSCode ? null : (
          <SettingsCheckboxRow
            checked={jevAvailable && sessionReviewOfferEnabled}
            onChange={setSessionReviewOfferEnabled}
            disabled={!jevAvailable}
            label={t('settings.openchamber.visual.field.sessionReviewOffer')}
            ariaLabel={t('settings.openchamber.visual.field.sessionReviewOffer')}
            info={t('settings.openchamber.visual.field.sessionReviewOfferInfo')}
            footer={<JevAccessNote />}
            settingsItem="chat.session-review-offer"
          />
        )}
      </SettingsSection>

      {/* The goal loop runs in the web server; VS Code only renders goal state. */}
      {isVSCode ? null : (
        <SettingsSection
          title={t('settings.openchamber.visual.goal.sectionTitle')}
          info={t('settings.openchamber.visual.goal.description')}
          contentClassName="space-y-3"
        >
          <SettingsCheckboxRow
            checked={sessionGoalEnabled}
            onChange={setSessionGoalEnabled}
            label={t('settings.openchamber.visual.field.sessionGoal')}
            ariaLabel={t('settings.openchamber.visual.field.sessionGoalAria')}
            settingsItem="chat.session-goal"
          />
          <div>
            <SessionGoalCheckerField disabled={!sessionGoalEnabled} />
            <SessionGoalMaxTurnsField disabled={!sessionGoalEnabled} />
            <SessionGoalLengthFields disabled={!sessionGoalEnabled} />
            <SettingsFieldRow
              label={(
                <SettingsCheckboxRow
                  checked={sessionGoalDefaultBudgetEnabled}
                  onChange={setSessionGoalDefaultBudgetEnabled}
                  disabled={!sessionGoalEnabled}
                  label={t('settings.openchamber.visual.goal.budgetLabel')}
                  ariaLabel={t('settings.openchamber.visual.goal.budgetAria')}
                />
              )}
              settingsItem="chat.session-goal-budget"
            >
              {/* The field keeps its place while the budget is off, so
                  turning it on does not move the rows around it. */}
              <NumberInput
                value={sessionGoalDefaultBudget}
                onValueChange={(value) => {
                  if (Number.isFinite(value) && value > 0) {
                    setSessionGoalDefaultBudget(Math.floor(value));
                  }
                }}
                min={1000}
                max={100000000}
                step={50000}
                disabled={!sessionGoalEnabled || !sessionGoalDefaultBudgetEnabled}
                className={SETTINGS_NUMBER_INPUT_CLASS}
                aria-label={t('settings.openchamber.visual.goal.budgetAria')}
              />
            </SettingsFieldRow>
            <SessionGoalWriterFields disabled={!sessionGoalEnabled} />
          </div>
        </SettingsSection>
      )}

      {/* The history lives on the OpenChamber server, which VS Code does not have. */}
      {isVSCode ? null : <ModelChoiceSettings />}
    </>
  );
};

/**
 * Settings → Chat. Three tabs split what used to be one long page: how the
 * transcript reads, how the composer sends, and what OpenChamber adds around
 * a session. The tab lives in `chatSettingsTabs.ts`, so a search result can
 * open the tab that holds its target.
 */
export const ChatSettings: React.FC = () => {
  const { t } = useI18n();
  const tab = useChatSettingsTabStore((state) => state.tab);
  const setTab = useChatSettingsTabStore((state) => state.setTab);
  const tabs = React.useMemo<Array<SortableTabsStripItem & { id: ChatSettingsTab }>>(() => [
    { id: 'messages', label: t('settings.layout.chat.tab.messages') },
    { id: 'composer', label: t('settings.layout.chat.tab.composer') },
    { id: 'assistance', label: t('settings.layout.chat.tab.assistance') },
  ], [t]);

  return (
    <>
      <div className="mb-8">
        <SortableTabsStrip
          items={tabs}
          activeId={tab}
          onSelect={(id) => {
            const next = tabs.find((item) => item.id === id);
            if (next) setTab(next.id);
          }}
          layoutMode="fit"
          variant="active-pill"
          pillSize="form"
          className="h-8 max-w-[28rem]"
        />
      </div>
      {tab === 'messages' ? <MessagesTab /> : null}
      {tab === 'composer' ? <ComposerTab /> : null}
      {tab === 'assistance' ? <AssistanceTab /> : null}
    </>
  );
};
