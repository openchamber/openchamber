/**
 * Counts the frames the display compositor draws and swaps, per second.
 *
 * Main-thread counters call a composited animation free, yet every frame it
 * produces is drawn by the GPU process and composited by the OS: a spinner or
 * a smooth pulse costs sixty frames a second on an otherwise still page. A
 * frame count is the figure that tells a still page from one that moves, and
 * headless Chrome counts it the same as a headed one (measured on macOS: still
 * page 1, smooth pulse 60, spin 66, `steps(10)` over 4 s 4.5, a 1 s timer 1,
 * an animation under `opacity: 0` 0).
 *
 * The trace records only the `viz` category, so the counter adds almost no
 * work to the processes it measures. `Display::DrawAndSwap` fires once per
 * frame the display compositor draws, whichever renderer or surface asked.
 */

const FRAME_EVENT = "Display::DrawAndSwap"

/**
 * Starts counting on a page-level client. `stop()` ends the trace and returns
 * `{ frames, seconds, framesPerSecond }` for the time between the two calls.
 */
export const startFrameCount = async (client) => {
  let frames = 0
  const unsubscribe = client.on("Tracing.dataCollected", ({ value }) => {
    for (const event of value ?? []) {
      if (event.name === FRAME_EVENT && (event.ph === "X" || event.ph === "B")) frames += 1
    }
  })
  await client.send("Tracing.start", { transferMode: "ReportEvents", categories: "viz" })
  const startedAt = Date.now()

  return {
    stop: async () => {
      const seconds = (Date.now() - startedAt) / 1000
      const complete = client.once("Tracing.tracingComplete", 60_000)
      await client.send("Tracing.end")
      await complete
      unsubscribe()
      return {
        frames,
        seconds: Math.round(seconds * 100) / 100,
        framesPerSecond: seconds > 0 ? Math.round((frames / seconds) * 10) / 10 : null,
      }
    },
  }
}
