import type { I18nKey } from '@/lib/i18n/store';
import type { SettingsPageSlug, SettingsRuntimeContext } from './metadata';
import { getSettingsPageMeta } from './metadata';

interface SettingsSearchItem {
  id: string;
  page: SettingsPageSlug;
  titleKey: I18nKey;
  descriptionKey?: I18nKey;
  keywords?: string[];
  isAvailable?: (ctx: SettingsSearchAvailabilityContext) => boolean;
}

export interface SettingsSearchResult extends SettingsSearchItem {
  title: string;
  description: string | null;
  pageTitle: string;
}

interface SettingsSearchAvailabilityContext extends SettingsRuntimeContext {
  isMobile: boolean;
  isDesktopLocalOrigin: boolean;
  // macOS desktop shell — for controls that only render on darwin (e.g. dock badge).
  isMac: boolean;
  // Windows desktop shell — for controls that only render on win32.
  isWindows: boolean;
}

const SETTINGS_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'appearance.language',
    page: 'appearance',
    titleKey: 'settings.appearance.language.label',
    descriptionKey: 'settings.appearance.language.description',
    keywords: ['locale', 'translation', 'ui language'],
  },
  {
    id: 'appearance.time-format',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.timeFormat',
    keywords: ['clock', '12h', '24h'],
  },
  {
    id: 'appearance.week-start',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.weekStartsOn',
    keywords: ['calendar', 'monday', 'sunday'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.light-theme',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.lightTheme',
    keywords: ['theme', 'color', 'light mode'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.dark-theme',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.darkTheme',
    keywords: ['theme', 'color', 'dark mode'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.window-transparency',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.macVibrancy',
    descriptionKey: 'settings.openchamber.visual.field.macVibrancyHint',
    keywords: ['transparent', 'transparency', 'vibrancy', 'blur', 'macos', 'opaque'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'appearance.dock-badge',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.dockBadge',
    descriptionKey: 'settings.openchamber.visual.field.dockBadgeHint',
    keywords: ['dock', 'badge', 'unread', 'unseen', 'counter', 'count', 'notification', 'macos'],
    // Exactly matches the render guard in OpenChamberVisualSettings: any darwin
    // Electron shell (isMac already implies isDesktopShell), local or remote host.
    isAvailable: (ctx) => ctx.isMac,
  },
  {
    id: 'appearance.pwa-install-name',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.installAppName',
    descriptionKey: 'settings.openchamber.visual.field.installAppNameHint',
    keywords: ['pwa', 'installed app'],
    isAvailable: (ctx) => ctx.isWeb && !ctx.isDesktop && !ctx.isVSCode,
  },
  {
    id: 'appearance.pwa-orientation',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.installOrientation',
    descriptionKey: 'settings.openchamber.visual.field.installOrientationHint',
    keywords: ['pwa', 'portrait', 'landscape'],
    isAvailable: (ctx) => ctx.isWeb && !ctx.isDesktop && !ctx.isVSCode,
  },
  {
    id: 'appearance.mobile-keyboard-mode',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.mobileKeyboardMode',
    descriptionKey: 'settings.openchamber.visual.field.mobileKeyboardModeHint',
    keywords: ['mobile', 'keyboard', 'resize'],
    isAvailable: (ctx) => ctx.isMobile && ctx.isWeb && !ctx.isDesktop && !ctx.isVSCode,
  },
  {
    id: 'appearance.interface-font-size',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.interfaceFontSize',
    keywords: ['font', 'text size', 'ui scale'],
    isAvailable: (ctx) => !ctx.isMobile,
  },
  {
    id: 'appearance.terminal-font-size',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.terminalFontSize',
    keywords: ['terminal', 'font', 'text size'],
  },
  {
    id: 'appearance.terminal-shell',
    page: 'general',
    titleKey: 'settings.openchamber.visual.field.terminalShell',
    descriptionKey: 'settings.openchamber.visual.field.terminalShellHint',
    keywords: ['terminal', 'shell', 'bash', 'zsh', 'fish', 'pwsh', 'powershell'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.editor-font-size',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.editorFontSize',
    keywords: ['editor', 'font', 'text size', 'code'],
  },
  {
    id: 'appearance.spacing-density',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.spacingDensity',
    keywords: ['density', 'compact', 'comfortable', 'spacing'],
  },
  {
    id: 'appearance.input-bar-offset',
    page: 'appearance',
    titleKey: 'settings.openchamber.visual.field.inputBarOffset',
    descriptionKey: 'settings.openchamber.visual.field.inputBarOffsetTooltip',
    keywords: ['input', 'home bar', 'offset'],
    // Only the mobile composer applies this offset (ChatInput gates on isMobile).
    isAvailable: (ctx) => ctx.isMobile,
  },
  {
    id: 'appearance.expanded-editor-toolbar',
    page: 'general',
    titleKey: 'settings.openchamber.visual.field.expandedEditorToolbar',
    keywords: ['editor', 'toolbar', 'tabs', 'docked', 'files'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'appearance.file-editor-keymap',
    page: 'general',
    titleKey: 'settings.openchamber.visual.field.fileEditorKeymap',
    keywords: ['editor', 'vim', 'keymap'],
  },
  {
    id: 'appearance.terminal-quick-keys',
    page: 'general',
    titleKey: 'settings.openchamber.visual.field.terminalQuickKeys',
    descriptionKey: 'settings.openchamber.visual.field.terminalQuickKeysTooltip',
    keywords: ['terminal', 'keyboard', 'esc', 'ctrl', 'arrows'],
    isAvailable: (ctx) => !ctx.isMobile && !ctx.isVSCode,
  },
  {
    id: 'appearance.usage-reports',
    page: 'general',
    titleKey: 'settings.openchamber.visual.field.sendAnonymousUsageReports',
    descriptionKey: 'settings.openchamber.visual.field.sendAnonymousUsageReportsHint',
    keywords: ['telemetry', 'analytics'],
  },
  {
    id: 'chat.render-mode',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.section.chatRenderMode',
    keywords: ['messages', 'conversation', 'rendering'],
  },
  {
    id: 'chat.message-transport',
    page: 'general',
    titleKey: 'settings.openchamber.visual.section.messageStreamTransport',
    keywords: ['streaming', 'sse', 'websocket'],
  },
  {
    id: 'chat.session-recap',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.sessionRecap',
    keywords: ['recap', 'assist', 'small model', 'summary'],
  },
  {
    id: 'chat.session-assistance',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.section.sessionAssistance',
    keywords: ['recap', 'suggestion', 'subagent'],
  },
  {
    id: 'chat.session-suggestion',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.sessionSuggestion',
    keywords: ['suggestion', 'assist', 'small model', 'follow up'],
  },
  {
    id: 'chat.session-goal',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.sessionGoal',
    keywords: ['goal', 'objective', 'auto continue', 'small model'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.session-goal-budget',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.goal.budgetLabel',
    keywords: ['goal', 'budget', 'tokens', 'limit'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.reasoning-traces',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.showReasoningTraces',
    keywords: ['thinking', 'reasoning'],
  },
  {
    id: 'chat.reasoning',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.section.reasoning',
    keywords: ['thinking', 'traces'],
  },
  {
    id: 'chat.sticky-user-header',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.stickyUserHeader',
    keywords: ['messages', 'header'],
  },
  {
    id: 'chat.prompt-navigator',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.promptNavigatorEnabled',
    keywords: ['prompt', 'navigator', 'navigation', 'timeline', 'scroll'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.collapsible-user-messages',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.collapsibleUserMessages',
    keywords: ['collapse', 'expand', 'clamp', 'long messages', 'user messages'],
  },
  {
    id: 'chat.message-width',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.section.chatMessageWidth',
    keywords: ['layout', 'wide', 'fluid', 'full width', 'messages'],
  },
  {
    id: 'chat.message-appearance',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.section.messageAppearance',
    keywords: ['layout', 'messages', 'appearance'],
  },
  {
    id: 'chat.code-block-line-wrap',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.codeBlockLineWrap',
    keywords: ['code', 'wrap', 'line wrap', 'markdown'],
  },
  {
    id: 'chat.inline-assistant-actions',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.showSplitAssistantMessageActions',
    descriptionKey: 'settings.openchamber.visual.field.showSplitAssistantMessageActionsTooltip',
    keywords: ['copy', 'save image', 'read aloud'],
  },
  {
    id: 'chat.subagent-read-only-banner',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.allowPromptingSubagentSessions',
    keywords: ['subagent', 'read only', 'prompt', 'banner'],
  },
  {
    id: 'chat.tool-file-icons',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.showToolFileIcons',
    keywords: ['tools', 'files', 'icons'],
  },
  {
    id: 'chat.tools-and-files',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.section.toolsAndFiles',
    keywords: ['tools', 'files', 'dotfiles'],
  },
  {
    id: 'chat.changed-files',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.showTurnChangedFiles',
    keywords: ['changed files', 'turns'],
  },
  {
    id: 'chat.dotfiles',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.showDotfiles',
    keywords: ['hidden files'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'chat.follow-up-behavior',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.section.followUpBehavior',
    descriptionKey: 'settings.openchamber.visual.field.followUpBehaviorDescription',
    keywords: ['follow up', 'queue', 'steer', 'send immediately'],
  },
  {
    id: 'chat.persist-drafts',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.persistDraftMessages',
    keywords: ['draft', 'message'],
  },
  {
    id: 'chat.composer',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.section.composer',
    keywords: ['input', 'draft', 'spellcheck'],
  },
  {
    id: 'chat.spellcheck',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.enableSpellcheckInTextInputs',
    keywords: ['spelling', 'input'],
    isAvailable: (ctx) => !ctx.isMobile,
  },
  {
    id: 'sessions.default-model',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.defaultModel',
    keywords: ['model', 'provider', 'new sessions'],
  },
  {
    id: 'sessions.default-thinking',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.defaultThinking',
    keywords: ['thinking', 'reasoning', 'variant'],
  },
  {
    id: 'sessions.default-agent',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.defaultAgent',
    keywords: ['agent', 'new sessions'],
  },
  {
    id: 'sessions.deletion-dialog',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.showDeletionDialog',
    keywords: ['delete', 'confirmation'],
  },
  {
    id: 'sessions.small-model',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.smallModel.title',
    descriptionKey: 'settings.openchamber.defaults.smallModel.description',
    keywords: ['small model', 'utility', 'summary', 'recap', 'cheap', 'override'],
  },
  {
    id: 'sessions.auto-cleanup',
    page: 'sessions',
    titleKey: 'settings.openchamber.sessionRetention.field.enableAutoCleanup',
    descriptionKey: 'settings.openchamber.sessionRetention.tooltip',
    keywords: ['retention', 'archive', 'delete'],
  },
  {
    id: 'sessions.retention-period',
    page: 'sessions',
    titleKey: 'settings.openchamber.sessionRetention.field.retentionPeriod',
    keywords: ['days', 'cleanup', 'retention'],
  },
  {
    id: 'sessions.retention-action',
    page: 'sessions',
    titleKey: 'settings.openchamber.sessionRetention.field.whenSessionsExpire',
    keywords: ['archive', 'delete', 'expire'],
  },
  {
    id: 'sessions.desktop-launch-at-login',
    page: 'general',
    titleKey: 'settings.openchamber.desktopNetwork.field.launchAtLogin',
    descriptionKey: 'settings.openchamber.desktopNetwork.field.launchAtLoginDescription',
    keywords: ['desktop', 'startup', 'login'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.desktop-window-controls-position',
    page: 'general',
    titleKey: 'settings.openchamber.desktopNetwork.field.windowControlsPosition',
    descriptionKey: 'settings.openchamber.desktopNetwork.field.windowControlsPositionDescription',
    keywords: ['desktop', 'window', 'controls', 'minimize', 'maximize', 'close', 'titlebar', 'linux', 'windows'],
    isAvailable: (ctx) => ctx.isDesktop && (ctx.isWindows || !ctx.isMac),
  },
  {
    id: 'sessions.desktop-mac-menu-bar',
    page: 'general',
    titleKey: 'settings.openchamber.desktopNetwork.field.macMenuBar',
    descriptionKey: 'settings.openchamber.desktopNetwork.field.macMenuBarDescription',
    keywords: ['desktop', 'menu bar', 'tray', 'status item', 'macos', 'background'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin && ctx.isMac,
  },
  {
    id: 'sessions.desktop-minimize-to-tray',
    page: 'general',
    titleKey: 'settings.openchamber.desktopNetwork.field.minimizeToTray',
    descriptionKey: 'settings.openchamber.desktopNetwork.field.minimizeToTrayDescription',
    keywords: ['desktop', 'tray', 'system tray', 'minimize', 'close', 'background', 'windows'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin && ctx.isWindows,
  },
  {
    id: 'sessions.desktop-keep-awake',
    page: 'general',
    titleKey: 'settings.openchamber.desktopNetwork.field.keepAwake',
    descriptionKey: 'settings.openchamber.desktopNetwork.field.keepAwakeDescription',
    keywords: ['desktop', 'sleep', 'awake', 'server', 'mobile', 'phone'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.desktop-ui-password',
    page: 'general',
    titleKey: 'settings.openchamber.desktopPassword.field.password',
    descriptionKey: 'settings.openchamber.desktopPassword.field.passwordDescription',
    keywords: ['desktop', 'password', 'auth', 'login'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.desktop-lan-access',
    page: 'general',
    titleKey: 'settings.openchamber.desktopNetwork.field.allowLanAccess',
    descriptionKey: 'settings.openchamber.desktopNetwork.field.allowLanAccessDescription',
    keywords: ['desktop', 'lan', 'network', 'phone', 'tablet'],
    isAvailable: (ctx) => ctx.isDesktopLocalOrigin,
  },
  {
    id: 'sessions.opencode-binary',
    page: 'general',
    titleKey: 'settings.openchamber.opencodeCli.field.binaryPath',
    keywords: ['opencode', 'cli', 'binary', 'path'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'sessions.opencode-update-notifications',
    page: 'general',
    titleKey: 'settings.openchamber.opencodeCli.field.showUpdateNotifications',
    keywords: ['opencode', 'cli', 'updates'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'git.github-account',
    page: 'git',
    titleKey: 'settings.github.page.actions.connect',
    keywords: ['github', 'account', 'oauth', 'prs', 'issues'],
  },
  {
    id: 'git.identities',
    page: 'git',
    titleKey: 'settings.gitIdentities.page.section.title',
    descriptionKey: 'settings.gitIdentities.page.empty.description',
    keywords: ['identity', 'profile', 'author', 'email', 'credentials', 'signing', 'commit signing', 'ssh signing', 'gpg'],
  },
  {
    id: 'git.changes-view',
    page: 'git',
    titleKey: 'settings.openchamber.git.changesViewTitle',
    keywords: ['changes', 'flat list', 'tree view'],
  },
  {
    id: 'git.gitmoji',
    page: 'git',
    titleKey: 'settings.openchamber.git.enableGitmoji',
    keywords: ['commit', 'emoji'],
  },
  {
    id: 'git.gitignored-files',
    page: 'git',
    titleKey: 'settings.openchamber.git.showGitignored',
    keywords: ['ignored', 'files', 'gitignore'],
  },
  {
    id: 'usage.header-menu',
    page: 'usage',
    titleKey: 'settings.usage.page.options.showInHeader',
    descriptionKey: 'settings.usage.page.options.showInHeaderTooltip',
    keywords: ['quota', 'header', 'dropdown'],
  },
  {
    id: 'usage.model-quotas',
    page: 'usage',
    titleKey: 'settings.usage.page.section.modelQuotas',
    keywords: ['models', 'quota', 'limits', 'tokens'],
  },
  {
    id: 'projects.name',
    page: 'projects',
    titleKey: 'settings.projects.page.field.projectName',
    keywords: ['label', 'display name', 'project metadata'],
  },
  {
    id: 'projects.accent-color',
    page: 'projects',
    titleKey: 'settings.projects.page.field.accentColor',
    keywords: ['color', 'appearance', 'project metadata'],
  },
  {
    id: 'projects.icon',
    page: 'projects',
    titleKey: 'settings.projects.page.field.projectIcon',
    keywords: ['icon', 'favicon', 'upload', 'project metadata'],
  },
  {
    id: 'projects.worktree',
    page: 'projects',
    titleKey: 'settings.projects.page.section.worktree',
    keywords: ['worktree', 'branch', 'repository'],
  },
  {
    id: 'projects.worktree.setup.wait',
    page: 'projects',
    titleKey: 'settings.openchamber.worktrees.setup.waitForCommands',
    keywords: ['worktree', 'setup commands', 'bootstrap', 'wait'],
  },
  {
    id: 'remote-instances.client-auth',
    page: 'remote-instances',
    titleKey: 'settings.remoteInstances.clientAuth.title',
    descriptionKey: 'settings.remoteInstances.clientAuth.description',
    keywords: ['pairing link', 'client token', 'connect desktop', 'remote access', 'relay', 'devices', 'connect from anywhere'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'remote-instances.direct-hosts',
    page: 'remote-instances',
    titleKey: 'settings.remoteInstances.direct.title',
    descriptionKey: 'settings.remoteInstances.direct.description',
    keywords: ['server url', 'connection token', 'import link', 'host switcher', 'additional headers', 'request headers', 'cloudflare access', 'service token'],
    isAvailable: (ctx) => ctx.isDesktop,
  },
  {
    id: 'behavior.system-prompt',
    page: 'behavior',
    titleKey: 'settings.behavior.page.section.systemPrompt',
    descriptionKey: 'settings.behavior.page.warning.title',
    keywords: ['agents.md', 'global instructions', 'system prompt'],
  },
  {
    id: 'behavior.response-style',
    page: 'behavior',
    titleKey: 'settings.behavior.page.section.responseStyle',
    descriptionKey: 'settings.behavior.page.responseStyle.tooltip',
    keywords: ['tone', 'concise', 'detailed', 'custom instructions'],
  },
  {
    id: 'agents.create',
    page: 'agents',
    titleKey: 'settings.agents.page.title.new',
    keywords: ['create', 'add', 'new agent'],
  },
  {
    id: 'agents.name',
    page: 'agents',
    titleKey: 'settings.agents.page.field.agentName',
    keywords: ['agent', 'name'],
  },
  {
    id: 'agents.mode',
    page: 'agents',
    titleKey: 'settings.agents.page.field.mode',
    descriptionKey: 'settings.agents.page.field.modeTooltip',
    keywords: ['primary', 'subagent', 'visibility'],
  },
  {
    id: 'agents.model',
    page: 'agents',
    titleKey: 'settings.agents.page.field.overrideModel',
    keywords: ['model', 'provider'],
  },
  {
    id: 'agents.variant',
    page: 'agents',
    titleKey: 'settings.agents.page.field.variant',
    descriptionKey: 'settings.agents.page.field.variantTooltip',
    keywords: ['thinking', 'reasoning', 'variant', 'depth'],
  },
  {
    id: 'agents.temperature',
    page: 'agents',
    titleKey: 'settings.agents.page.field.temperature',
    descriptionKey: 'settings.agents.page.field.temperatureTooltip',
    keywords: ['randomness', 'creative'],
  },
  {
    id: 'agents.top-p',
    page: 'agents',
    titleKey: 'settings.agents.page.field.topP',
    descriptionKey: 'settings.agents.page.field.topPTooltip',
    keywords: ['sampling', 'nucleus'],
  },
  {
    id: 'agents.system-prompt',
    page: 'agents',
    titleKey: 'settings.agents.page.section.systemPrompt',
    keywords: ['prompt', 'instructions'],
  },
  {
    id: 'agents.permissions',
    page: 'agents',
    titleKey: 'settings.agents.page.section.toolPermissions',
    keywords: ['tools', 'permissions', 'allow', 'ask', 'deny'],
  },
  {
    id: 'commands.create',
    page: 'commands',
    titleKey: 'settings.commands.page.title.new',
    keywords: ['create', 'add', 'new command'],
  },
  {
    id: 'commands.name',
    page: 'commands',
    titleKey: 'settings.commands.page.field.commandName',
    keywords: ['slash command', 'name'],
  },
  {
    id: 'commands.agent',
    page: 'commands',
    titleKey: 'settings.commands.page.field.overrideAgent',
    keywords: ['agent', 'execution'],
  },
  {
    id: 'commands.model',
    page: 'commands',
    titleKey: 'settings.agents.page.field.overrideModel',
    keywords: ['model', 'provider'],
  },
  {
    id: 'commands.template',
    page: 'commands',
    titleKey: 'settings.commands.page.section.template',
    keywords: ['prompt', 'template', 'arguments', 'shell', 'file'],
  },
  {
    id: 'mcp.create',
    page: 'mcp',
    titleKey: 'settings.mcp.sidebar.actions.addServerTitle',
    keywords: ['create', 'add', 'server'],
  },
  {
    id: 'mcp.server',
    page: 'mcp',
    titleKey: 'settings.mcp.page.server.title',
    keywords: ['server', 'name', 'transport'],
  },
  {
    id: 'mcp.command',
    page: 'mcp',
    titleKey: 'settings.mcp.page.connection.command',
    keywords: ['stdio', 'local', 'command'],
  },
  {
    id: 'mcp.environment',
    page: 'mcp',
    titleKey: 'settings.mcp.page.env.title',
    keywords: ['env', 'variables', 'api key'],
  },
  {
    id: 'mcp.advanced',
    page: 'mcp',
    titleKey: 'settings.mcp.page.advanced.title',
    keywords: ['oauth', 'headers', 'timeout'],
  },
  {
    id: 'plugins.create',
    page: 'plugins',
    titleKey: 'settings.plugins.sidebar.actions.addTitle',
    keywords: ['add', 'plugin', 'npm', 'path', 'file'],
  },
  {
    id: 'plugins.spec',
    page: 'plugins',
    titleKey: 'settings.plugins.page.field.spec',
    keywords: ['npm', 'package', 'path'],
  },
  {
    id: 'plugins.options',
    page: 'plugins',
    titleKey: 'settings.plugins.page.field.options',
    keywords: ['json', 'configuration'],
  },
  {
    id: 'plugins.content',
    page: 'plugins',
    titleKey: 'settings.plugins.page.field.content',
    keywords: ['file', 'code'],
  },
  {
    id: 'snippets.create',
    page: 'snippets',
    titleKey: 'settings.snippets.sidebar.actions.create',
    keywords: ['add', 'new snippet'],
  },
  {
    id: 'snippets.content',
    page: 'snippets',
    titleKey: 'settings.snippets.page.field.content',
    keywords: ['markdown', 'prompt', 'template'],
  },
  {
    id: 'providers.connect',
    page: 'providers',
    titleKey: 'settings.providers.page.connect.title',
    keywords: ['add provider', 'connect provider', 'credentials'],
  },
  {
    id: 'providers.auth',
    page: 'providers',
    titleKey: 'settings.providers.page.auth.title',
    keywords: ['api key', 'oauth', 'credentials'],
  },
  {
    id: 'providers.connection-details',
    page: 'providers',
    titleKey: 'settings.providers.page.connectionDetails.title',
    keywords: ['config', 'source', 'disconnect'],
  },
  {
    id: 'providers.models',
    page: 'providers',
    titleKey: 'settings.providers.page.models.title',
    keywords: ['models', 'hide', 'show'],
  },
  {
    id: 'skills.create',
    page: 'skills.installed',
    titleKey: 'settings.skills.page.title.newSkill',
    keywords: ['create', 'add', 'new skill'],
  },
  {
    id: 'skills.basic-information',
    page: 'skills.installed',
    titleKey: 'settings.skills.page.section.basicInformation',
    keywords: ['name', 'location', 'description'],
  },
  {
    id: 'skills.instructions',
    page: 'skills.installed',
    titleKey: 'settings.skills.page.section.instructions',
    keywords: ['markdown', 'skill.md', 'content'],
  },
  {
    id: 'skills.supporting-files',
    page: 'skills.installed',
    titleKey: 'settings.skills.page.section.supportingFiles',
    keywords: ['files', 'resources'],
  },
  {
    id: 'skills.catalog.source',
    page: 'skills.catalog',
    titleKey: 'settings.skills.catalog.page.section.sourceRepository',
    keywords: ['catalog', 'repository', 'source', 'refresh'],
  },
  {
    id: 'skills.catalog.search',
    page: 'skills.catalog',
    titleKey: 'settings.skills.catalog.shared.field.searchSkillsPlaceholder',
    keywords: ['find skills', 'install skills', 'catalog search'],
  },
  {
    id: 'skills.catalog.add-catalog',
    page: 'skills.catalog',
    titleKey: 'settings.skills.catalog.page.actions.addCatalog',
    keywords: ['external repository', 'add source', 'catalog'],
  },
  {
    id: 'magic-prompts.visible-prompt',
    page: 'magic-prompts',
    titleKey: 'settings.magicPrompts.page.block.visiblePrompt',
    keywords: ['prompt text', 'user message', 'template'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'magic-prompts.instructions',
    page: 'magic-prompts',
    titleKey: 'settings.magicPrompts.page.block.instructions',
    keywords: ['hidden prompt', 'instructions', 'template'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'magic-prompts.reset-overrides',
    page: 'magic-prompts',
    titleKey: 'settings.magicPrompts.page.actions.resetAllOverrides',
    keywords: ['reset', 'default prompts', 'overrides'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'shortcuts.keyboard-shortcuts',
    page: 'shortcuts',
    titleKey: 'settings.openchamber.keyboardShortcuts.title',
    descriptionKey: 'settings.openchamber.keyboardShortcuts.tooltip',
    keywords: ['keyboard', 'hotkeys', 'bindings'],
  },
  {
    id: 'voice.playback',
    page: 'voice',
    titleKey: 'settings.voice.page.section.playbackAndSummary',
    keywords: ['tts', 'read aloud', 'voice', 'provider', 'speech rate', 'speech pitch', 'speech volume', 'tts input mode', 'markdown'],
  },
  {
    id: 'voice.speech-recognition',
    page: 'voice',
    titleKey: 'settings.voice.page.section.speechRecognition',
    keywords: ['stt', 'dictation', 'voice input', 'transcribe', 'whisper', 'parakeet', 'microphone'],
  },
  {
    id: 'tunnel.provider',
    page: 'tunnel',
    titleKey: 'settings.openchamber.tunnel.field.provider',
    descriptionKey: 'settings.openchamber.tunnel.description',
    keywords: ['remote access', 'cloudflare', 'ngrok'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'tunnel.type',
    page: 'tunnel',
    titleKey: 'settings.openchamber.tunnel.field.tunnelType',
    keywords: ['quick', 'managed remote', 'managed local'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'tunnel.ttl',
    page: 'tunnel',
    titleKey: 'settings.openchamber.tunnel.field.connectLinkTtl',
    descriptionKey: 'settings.openchamber.tunnel.field.tunnelSessionTtl',
    keywords: ['expiry', 'expiration', 'session ttl', 'connect link ttl'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'tunnel.managed-remote',
    page: 'tunnel',
    titleKey: 'settings.openchamber.tunnel.section.savedManagedRemoteTunnels',
    keywords: ['cloudflare', 'hostname', 'token', 'managed remote'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'tunnel.managed-local-config',
    page: 'tunnel',
    titleKey: 'settings.openchamber.tunnel.field.configurationFile',
    descriptionKey: 'settings.openchamber.tunnel.note.managedLocalUsesConfig',
    keywords: ['cloudflared', 'config', 'yaml', 'json', 'managed local'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'tunnel.start',
    page: 'tunnel',
    titleKey: 'settings.openchamber.tunnel.actions.startTunnel',
    descriptionKey: 'settings.openchamber.tunnel.note.connectLinksOneTime',
    keywords: ['connect link', 'qr code', 'public url', 'remote access'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'notifications.delivery',
    page: 'notifications',
    titleKey: 'settings.notifications.page.delivery.title',
    keywords: ['desktop notifications', 'system notifications'],
  },
  {
    id: 'notifications.events',
    page: 'notifications',
    titleKey: 'settings.notifications.page.events.title',
    keywords: ['completion', 'subtasks', 'errors', 'questions'],
  },
  {
    id: 'notifications.push',
    page: 'notifications',
    titleKey: 'settings.notifications.page.push.title',
    keywords: ['background', 'push'],
    isAvailable: (ctx) => ctx.isWeb && !ctx.isDesktop && !ctx.isVSCode,
  },
] as const;

interface BuildSettingsSearchResultsOptions {
  query: string;
  runtimeCtx: SettingsSearchAvailabilityContext;
  visiblePageSlugs?: SettingsPageSlug[];
  t: (key: I18nKey) => string;
  getPageTitle: (slug: SettingsPageSlug) => string;
}

function normalizeSearchText(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function buildSettingsSearchResults({
  query,
  runtimeCtx,
  visiblePageSlugs,
  t,
  getPageTitle,
}: BuildSettingsSearchResultsOptions): SettingsSearchResult[] {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return [];
  }

  const allowedPages = visiblePageSlugs ? new Set<SettingsPageSlug>(visiblePageSlugs) : null;
  const terms = normalizedQuery.split(/\s+/).filter(Boolean);

  return SETTINGS_SEARCH_ITEMS.flatMap((item) => {
    if (allowedPages && !allowedPages.has(item.page)) {
      return [];
    }

    const pageMeta = getSettingsPageMeta(item.page);
    if (!pageMeta || (pageMeta.isAvailable && !pageMeta.isAvailable(runtimeCtx)) || (item.isAvailable && !item.isAvailable(runtimeCtx))) {
      return [];
    }

    const title = t(item.titleKey);
    const description = item.descriptionKey ? t(item.descriptionKey) : null;
    const haystack = normalizeSearchText([
      title,
      description,
      getPageTitle(item.page),
      ...(item.keywords ?? []),
    ].filter(Boolean).join(' '));

    if (!terms.every((term) => haystack.includes(term))) {
      return [];
    }

    return [{
      ...item,
      title,
      description,
      pageTitle: getPageTitle(item.page),
    }];
  });
}
