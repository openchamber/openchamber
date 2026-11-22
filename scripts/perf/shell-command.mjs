import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const scripts = new Map()

const writeScript = (project, path, source) => {
  const file = join(project, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, source)
}

// Only a safe relative filename reaches the shell. JavaScript stays out of shell parsing.
export const javascriptCommand = (source, project) => {
  const path = `.git/verify-commands/${createHash("sha256").update(source).digest("hex")}.cjs`
  scripts.set(path, source)
  if (project) writeScript(project, path, source)
  return `node ${path}`
}

export const writeFixtureCommands = (project) => {
  for (const [path, source] of scripts) writeScript(project, path, source)
}

export const fixtureCommand = ({ output = "", repeat = 1, read, file, content = "ready", append = false, gate, hold = false, rawInput = false, fail = false }, project) => {
  const statements = [
    rawInput && `process.stdin.setRawMode(true);process.stdin.resume();process.stdin.on('data', (data) => {
      if (!data.includes(3)) return
      process.stdout.write(${JSON.stringify(rawInput.output ?? "")}, () => {
        process.stdin.setRawMode(false)
        ${rawInput.file ? `require('node:fs').writeFileSync(${JSON.stringify(rawInput.file)}, 'ready')` : ""}
        process.exit(0)
      })
    })`,
    output && `process.stdout.write(${JSON.stringify(output)}.repeat(${repeat}))`,
    read && `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(read)}))`,
    file && `require('node:fs').${append ? "appendFileSync" : "writeFileSync"}(${JSON.stringify(file)},${JSON.stringify(content)})`,
    hold && "setInterval(() => {}, 1000)",
    fail && "process.exitCode = 1",
  ].filter(Boolean).join(";")
  return javascriptCommand(gate
    ? `const timer = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(gate)})) { clearInterval(timer); ${statements} } }, 50)`
    : statements, project)
}
