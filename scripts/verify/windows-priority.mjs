import { constants, setPriority } from "node:os"
import process from "node:process"

// Windows resets high-priority parents' children to Normal. Windowless
// verification processes otherwise slow down enough to hit API timeouts.
export const prioritizeWindowsProcess = (pid = 0) => {
  if (process.platform === "win32") setPriority(pid, constants.priority.PRIORITY_HIGH)
}
