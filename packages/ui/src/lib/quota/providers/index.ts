import type { QuotaProviderId } from '@/types';

interface QuotaProviderMeta {
  id: QuotaProviderId;
  name: string;
}

export const QUOTA_PROVIDERS: QuotaProviderMeta[] = [
  { id: 'claude', name: 'Claude' },
  { id: 'cline-pass', name: 'ClinePass' },
  { id: 'codex', name: 'Codex' },
  { id: 'command-code', name: 'Command Code' },
  { id: 'cursor', name: 'Cursor' },
  { id: 'github-copilot', name: 'GitHub Copilot' },
  // #1042: this read is the Code Assist subscription viewed per-model, not a
  // separate Google pool — the label matches the server's providerName.
  { id: 'google', name: 'Google (Code Assist, per-model)' },
  { id: 'antigravity', name: 'Antigravity' },
  { id: 'kimi-for-coding', name: 'Kimi for Coding' },
  { id: 'meta', name: 'Meta Model API' },
  { id: 'mistral', name: 'Mistral AI' },
  { id: 'nano-gpt', name: 'NanoGPT' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'zai-coding-plan', name: 'z.ai' },
  { id: 'zhipuai-coding-plan', name: 'Zhipu AI Coding Plan' },
  { id: 'minimax-cn-coding-plan', name: 'MiniMax Coding Plan (minimaxi.com)' },
  { id: 'minimax-coding-plan', name: 'MiniMax Coding Plan (minimax.io)' },
  { id: 'ollama-cloud', name: 'Ollama Cloud' },
  { id: 'wafer', name: 'Wafer.ai' },
  { id: 'opencode-go', name: 'OpenCode Go' },
  { id: 'deepinfra', name: 'DeepInfra' },
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'exe-dev', name: 'exe.dev' },
  { id: 'hyper', name: 'Charm Hyper' },
  { id: 'neuralwatt', name: 'NeuralWatt' },
  { id: 'kilo', name: 'Kilo Code' },
  { id: 'zenmux', name: 'ZenMux' },
  { id: 'opendesign', name: 'Open Design' },
  { id: 'xai', name: 'xAI' },
];
