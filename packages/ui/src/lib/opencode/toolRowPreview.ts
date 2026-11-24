const MAX_COMMAND_LENGTH = 400
const MAX_LABEL_LENGTH = 100

export const PANEL_COMMAND_LENGTH = 100

export function commandPreview(value: string, max: number = MAX_COMMAND_LENGTH): string {
  const line = value.split("\n")[0]
  if (line.length <= max) return line
  const last = line.charCodeAt(max - 1)
  return line.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max)
}

export const labelPreview = (label: string): string => label.slice(0, MAX_LABEL_LENGTH)
