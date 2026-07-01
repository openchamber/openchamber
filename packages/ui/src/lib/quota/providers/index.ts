import type { QuotaProviderId } from '@/types';

export interface QuotaProviderMeta {
  id: QuotaProviderId;
  name: string;
  headerPinEligible?: boolean;
  manualCredential?: boolean;
  schemaKey?: string;
  aliases?: string[];
}

// Canonical provider ID mapping (mystatus aliases → OpenChamber canonical IDs):
// OpenAI → openai
// Anthropic → claude
// Google (Antigravity) → google
// GitHub Copilot → github-copilot
// OpenCode Go+Zen → opencode-go
// Ollama Cloud → ollama-cloud
// LongCat API → longcat
// Poe → poe
// Z.AI (GLM Coding Plan) → zai-coding-plan
// xAI/Grok → xai
// MiniMax Token Plan → minimax-coding-plan (minimax.io) / minimax-cn-coding-plan (minimaxi.com)
// NanoGPT → nano-gpt
// StepFun Token Plan → stepfun
// QwenCloud Token Plan → qwencloud
// Mistral Vibe → mistral
// AtlasCloud Coding Plan → atlascloud
// BytePlus Coding Plan → byteplus
//
// OpenChamber-only providers (no mystatus equivalent):
// codex, cursor, github-copilot-addon, kimi-for-coding, openrouter, zhipuai-coding-plan, wafer
export const QUOTA_PROVIDERS: QuotaProviderMeta[] = [
  { id: 'claude', name: 'Claude', headerPinEligible: true, aliases: ['anthropic'] },
  { id: 'codex', name: 'Codex', headerPinEligible: true },
  { id: 'cursor', name: 'Cursor', headerPinEligible: true },
  { id: 'github-copilot', name: 'GitHub Copilot', headerPinEligible: true },
  { id: 'github-copilot-addon', name: 'GitHub Copilot Addon', headerPinEligible: true },
  { id: 'google', name: 'Google', headerPinEligible: true },
  { id: 'kimi-for-coding', name: 'Kimi for Coding', headerPinEligible: true },
  { id: 'nano-gpt', name: 'NanoGPT', headerPinEligible: true },
  { id: 'openai', name: 'OpenAI', headerPinEligible: true },
  { id: 'openrouter', name: 'OpenRouter', headerPinEligible: true },
  { id: 'zai-coding-plan', name: 'z.ai', headerPinEligible: true },
  { id: 'zhipuai-coding-plan', name: 'Zhipu AI Coding Plan', headerPinEligible: true },
  { id: 'minimax-cn-coding-plan', name: 'MiniMax Coding Plan (minimaxi.com)', headerPinEligible: true },
  { id: 'minimax-coding-plan', name: 'MiniMax Coding Plan (minimax.io)', headerPinEligible: true },
  { id: 'ollama-cloud', name: 'Ollama Cloud', headerPinEligible: true, manualCredential: true, schemaKey: 'ollama-cloud' },
  { id: 'wafer', name: 'Wafer.ai', headerPinEligible: true },
  { id: 'atlascloud', name: 'AtlasCloud', headerPinEligible: true, manualCredential: true, schemaKey: 'atlascloud' },
  { id: 'byteplus', name: 'BytePlus', headerPinEligible: true, manualCredential: true, schemaKey: 'byteplus' },
  { id: 'longcat', name: 'LongCat', headerPinEligible: true, manualCredential: true, schemaKey: 'longcat' },
  { id: 'mistral', name: 'Mistral', headerPinEligible: true, manualCredential: true, schemaKey: 'mistral' },
  { id: 'poe', name: 'Poe', headerPinEligible: true },
  { id: 'qwencloud', name: 'QwenCloud', headerPinEligible: true, manualCredential: true, schemaKey: 'qwencloud' },
  { id: 'stepfun', name: 'StepFun', headerPinEligible: true, manualCredential: true, schemaKey: 'stepfun' },
  { id: 'xai', name: 'xAI', headerPinEligible: true },
  { id: 'opencode-go', name: 'OpenCode Go', headerPinEligible: true, manualCredential: true, schemaKey: 'opencode-go' },
];
