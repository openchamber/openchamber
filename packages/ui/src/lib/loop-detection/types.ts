import type { ToolPart } from "@opencode-ai/sdk/v2/client"

export interface ToolCallRecord {
  tool: string
  input: string
  messageID: string
}

export type LoopPattern = "tool" | "reasoning" | null

export interface LoopDetectionSnapshot {
  loopDetected: boolean
  loopRetryCount: number
  lastCleanMessageId: string | undefined
  detectedPattern: LoopPattern
}

export interface LoopDetectionConfig {
  bufferSize: number
  maxAfkRetries: number
}

export interface ToolCallInput {
  tool: string
  input: Record<string, unknown>
  messageID: string
}

export function extractToolCallInput(part: ToolPart): ToolCallInput | null {
  const state = part.state as { input?: Record<string, unknown> }
  if (!state.input) return null
  return {
    tool: part.tool,
    input: state.input,
    messageID: part.messageID,
  }
}

export function stringifyToolInput(input: Record<string, unknown>): string {
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}
