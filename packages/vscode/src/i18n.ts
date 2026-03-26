export type VSCodeLocale = 'en' | 'zh-CN';

export const normalizeVSCodeLocale = (locale: string | null | undefined): VSCodeLocale => {
  if (typeof locale !== 'string') {
    return 'en';
  }

  const normalized = locale.trim().replace(/_/g, '-').toLowerCase();
  if (
    normalized === 'zh'
    || normalized === 'zh-cn'
    || normalized.startsWith('zh-cn-')
    || normalized === 'zh-hans'
    || normalized.startsWith('zh-hans-')
  ) {
    return 'zh-CN';
  }

  return 'en';
};

export const resolveVSCodeLocale = (locale: string | null | undefined): VSCodeLocale => normalizeVSCodeLocale(locale);

export const getVSCodeRuntimeCopy = (locale: VSCodeLocale) => {
  if (locale === 'zh-CN') {
    return {
      host: {
        agentManagerTitle: '代理管理器',
        newSessionTitle: '新建会话',
        sessionTitle: '会话',
        cliNotFoundStatus: '未找到 OpenCode CLI。请安装并确保它已加入 PATH。',
        cliNotFoundMessage: '未找到 OpenCode CLI。请安装并确保它已加入 PATH。',
        moreInfo: '更多信息',
        failedToStartPrefix: '启动 OpenCode 失败',
        failedToOpenSidebar: (error: unknown) => `OpenChamber：打开侧边栏失败 - ${String(error)}`,
        noActiveSession: 'OpenChamber：当前没有活动会话',
        apiRestarted: 'OpenChamber：API 连接已重启',
        failedToRestartApi: (error: unknown) => `OpenChamber：重启 API 失败 - ${String(error)}`,
        addToContextNoActiveEditor: 'OpenChamber【添加到上下文】：当前没有活动编辑器',
        addToContextNoSelection: 'OpenChamber【添加到上下文】：未选择文本',
        noFileSelectedToMention: 'OpenChamber：没有可提及的已选文件',
        skippedEntries: 'OpenChamber：部分已选条目已跳过（文件夹或不支持的资源）',
        explainNoActiveEditor: 'OpenChamber【解释】：当前没有活动编辑器',
        explainPromptPrefix: '请解释以下代码 / 文本：',
        explainPromptWithoutSelection: (filePath: string) => `请解释以下代码 / 文本：\n\n${filePath}`,
        improveNoActiveEditor: 'OpenChamber【改进代码】：当前没有活动编辑器',
        improveNoSelection: 'OpenChamber【改进代码】：未选择文本',
        improvePromptPrefix: '请改进以下代码：',
      },
      webview: {
        startingApi: '正在启动 OpenCode API…',
        initializing: '正在初始化…',
        connecting: '正在连接…',
        cliMissing: '未找到 OpenCode CLI。请先安装。',
        connected: '已连接！',
        connectionError: '连接错误',
        disconnected: '已断开连接',
        reconnecting: '正在重新连接…',
        initialDataFailed: 'OpenCode 已连接，但初始数据加载失败。',
        providersReady: '✓ 提供商',
        providersPending: '… 提供商',
        agentsReady: '✓ 代理',
        agentsPending: '… 代理',
        loadingData: (providersText: string, agentsText: string) => `正在加载数据（${providersText}，${agentsText}）…`,
        startingDevServer: (hostLabel: string) => `正在启动 webview 开发服务器（${hostLabel}）…`,
        waitingDevServer: (hostLabel: string, attempt: number) => `正在等待 webview 开发服务器（${hostLabel}）… 第 ${attempt} 次尝试`,
      },
    };
  }

  return {
    host: {
      agentManagerTitle: 'Agent Manager',
      newSessionTitle: 'New Session',
      sessionTitle: 'Session',
      cliNotFoundStatus: 'OpenCode CLI not found. Install it and ensure it\'s in PATH.',
      cliNotFoundMessage: 'OpenCode CLI not found. Please install it and ensure it\'s in PATH.',
      moreInfo: 'More Info',
      failedToStartPrefix: 'Failed to start OpenCode',
      failedToOpenSidebar: (error: unknown) => `OpenChamber: Failed to open sidebar - ${String(error)}`,
      noActiveSession: 'OpenChamber: No active session',
      apiRestarted: 'OpenChamber: API connection restarted',
      failedToRestartApi: (error: unknown) => `OpenChamber: Failed to restart API - ${String(error)}`,
      addToContextNoActiveEditor: 'OpenChamber [Add to Context]: No active editor',
      addToContextNoSelection: 'OpenChamber [Add to Context]: No text selected',
      noFileSelectedToMention: 'OpenChamber: No file selected to mention',
      skippedEntries: 'OpenChamber: Some selected entries were skipped (folders or unsupported resources)',
      explainNoActiveEditor: 'OpenChamber [Explain]: No active editor',
      explainPromptPrefix: 'Explain the following Code / Text:',
      explainPromptWithoutSelection: (filePath: string) => `Explain the following Code / Text:\n\n${filePath}`,
      improveNoActiveEditor: 'OpenChamber [Improve Code]: No active editor',
      improveNoSelection: 'OpenChamber [Improve Code]: No text selected',
      improvePromptPrefix: 'Improve the following Code:',
    },
    webview: {
      startingApi: 'Starting OpenCode API…',
      initializing: 'Initializing…',
      connecting: 'Connecting…',
      cliMissing: 'OpenCode CLI not found. Please install it first.',
      connected: 'Connected!',
      connectionError: 'Connection error',
      disconnected: 'Disconnected',
      reconnecting: 'Reconnecting…',
      initialDataFailed: 'OpenCode connected, but initial data load failed.',
      providersReady: '✓ Providers',
      providersPending: '… Providers',
      agentsReady: '✓ Agents',
      agentsPending: '… Agents',
      loadingData: (providersText: string, agentsText: string) => `Loading data (${providersText}, ${agentsText})…`,
      startingDevServer: (hostLabel: string) => `Starting webview dev server (${hostLabel})...`,
      waitingDevServer: (hostLabel: string, attempt: number) => `Waiting for webview dev server (${hostLabel})... attempt ${attempt}`,
    },
  };
};

export const buildVSCodeCodeBlockPrompt = (
  prefix: string,
  filePath: string,
  lineRange: string,
  languageId: string,
  selectedText: string,
) => `${prefix}\n\n${filePath}:${lineRange}\n\`\`\`${languageId}\n${selectedText}\n\`\`\``;
