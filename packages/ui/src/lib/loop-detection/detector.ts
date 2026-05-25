import type {
  ToolCallRecord,
  LoopDetectionSnapshot,
  LoopDetectionConfig,
  ToolCallInput,
  LoopPattern,
} from "./types"
import { stringifyToolInput } from "./types"
import { DEFAULT_LOOP_DETECTION_CONFIG } from "./config"

export class LoopDetector {
  private config: LoopDetectionConfig

  private toolBuffer: ToolCallRecord[] = []
  private reasoningBuffer: string[] = []
  private lastCleanMessageId: string | undefined
  private loopDetected = false
  private loopRetryCount = 0
  private detectedPattern: LoopPattern = null
  private lastUserMessageId: string | undefined

  constructor(config?: Partial<LoopDetectionConfig>) {
    this.config = { ...DEFAULT_LOOP_DETECTION_CONFIG, ...config }
  }

  recordToolCall(sessionId: string, input: ToolCallInput): void {
    const record: ToolCallRecord = {
      tool: input.tool,
      input: stringifyToolInput(input.input),
      messageID: input.messageID,
    }

    this.toolBuffer.push(record)
    if (this.toolBuffer.length > this.config.bufferSize) {
      this.toolBuffer.shift()
    }

    this.updateLastCleanMessage(input.messageID)
    void sessionId

    this.checkToolLoop()
  }

  recordReasoning(sessionId: string, text: string, messageId: string): void {
    this.reasoningBuffer.push(text)
    if (this.reasoningBuffer.length > this.config.bufferSize) {
      this.reasoningBuffer.shift()
    }

    this.updateLastCleanMessage(messageId)
    void sessionId

    this.checkReasoningLoop()
  }

  recordUserMessage(messageId: string): void {
    this.lastUserMessageId = messageId
    this.reset()
  }

  isLoopDetected(): boolean {
    return this.loopDetected
  }

  getSnapshot(): LoopDetectionSnapshot {
    return {
      loopDetected: this.loopDetected,
      loopRetryCount: this.loopRetryCount,
      lastCleanMessageId: this.lastCleanMessageId,
      detectedPattern: this.detectedPattern,
    }
  }

  incrementRetryCount(): number {
    this.loopRetryCount += 1
    return this.loopRetryCount
  }

  reset(): void {
    this.toolBuffer = []
    this.reasoningBuffer = []
    this.loopDetected = false
    this.detectedPattern = null
  }

  fullReset(): void {
    this.reset()
    this.loopRetryCount = 0
    this.lastCleanMessageId = undefined
  }

  private updateLastCleanMessage(messageId: string): void {
    if (!this.lastCleanMessageId || !this.isLoopDetected()) {
      this.lastCleanMessageId = messageId
    }
  }

  private checkToolLoop(): void {
    if (this.toolBuffer.length < this.config.bufferSize) return

    const pairs = this.getConsecutivePairs(this.toolBuffer)
    if (pairs.length === 0) return

    const allMatch = pairs.every(
      ([a, b]) => a.tool === b.tool && a.input === b.input,
    )

    if (allMatch) {
      this.loopDetected = true
      this.detectedPattern = "tool"
    }
  }

  private checkReasoningLoop(): void {
    if (this.reasoningBuffer.length < this.config.bufferSize) return

    const pairs = this.getConsecutivePairs(this.reasoningBuffer)
    if (pairs.length === 0) return

    const allMatch = pairs.every(([a, b]) => a === b)

    if (allMatch) {
      this.loopDetected = true
      this.detectedPattern = "reasoning"
    }
  }

  private getConsecutivePairs<T>(buffer: T[]): [T, T][] {
    const pairs: [T, T][] = []
    for (let i = buffer.length - this.config.bufferSize; i < buffer.length - 1; i++) {
      pairs.push([buffer[i], buffer[i + 1]])
    }
    return pairs
  }
}
