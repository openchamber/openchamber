import type { LoopDetectionConfig } from "./types"

export const DEFAULT_LOOP_DETECTION_CONFIG: LoopDetectionConfig = {
  bufferSize: 3,
  maxAfkRetries: 3,
}
