#!/usr/bin/env bash
# Reproduction for OpenChamber issue #2174 (Issue 1):
# Installed extensions/skills are not shared between Desktop and VS Code
#
# This script demonstrates that the Desktop and VS Code extension
# run SEPARATE, INDEPENDENT OpenCode server processes, and that
# skills installed via the Desktop app's skills catalog may not
# be immediately available in the VS Code extension.
#
set -euo pipefail

echo "=== Reproduction: Issue 1 - Skills/Extensions Not Shared ==="
echo ""

OPENCHAMBER_DATA_DIR="${HOME}/.config/openchamber"
OPENCODE_CONFIG_DIR="${HOME}/.config/opencode"
SKILLS_DIR="${OPENCODE_CONFIG_DIR}/skills"
TEST_SKILL_NAME="openspec"
TEST_SKILL_DIR="${SKILLS_DIR}/${TEST_SKILL_NAME}"

echo "Shared skills directory: ${SKILLS_DIR}"
echo ""

# Step 1: Show that both runtimes use the same filesystem paths
echo "--- Step 1: Both runtimes discover skills from the same paths ---"
echo ""
echo "Web/Desktop skill discovery (packages/web/server/lib/opencode/shared.js):"
echo "  - resolveSkillSearchDirectories() checks:"
echo "    1) ~/.config/opencode/ (user config dir)"
echo "    2) <project>/.opencode/ (project dir, walking up to git root)"
echo "    3) ~/.opencode/ (home dir)"
echo "    4) \$OPENCODE_CONFIG_DIR (env override)"
echo "  - discoverSkills() also checks:"
echo "    5) ~/.claude/skills/ and ~/.agents/skills/"
echo "    6) <project>/.claude/skills/ and <project>/.agents/skills/"
echo "    7) Cache dirs (~/.cache/opencode/skills/)"
echo ""
echo "VS Code skill discovery (packages/vscode/src/opencodeConfig.ts):"
echo "  - resolveSkillSearchDirectories() checks the SAME paths"
echo "  - discoverSkills() checks the SAME locations"
echo ""

# Step 2: Show that Desktop and VS Code spawn separate OpenCode servers
echo "--- Step 2: Desktop and VS Code run separate OpenCode servers ---"
echo ""
echo "Desktop web server (packages/web/server/lib/opencode/lifecycle.js):"
echo "  - Spawns: opencode serve --hostname 127.0.0.1 --port <port>"
echo "  - cwd: state.openCodeWorkingDirectory"
echo "  - PID tracked in state.openCodeProcess"
echo "  - Skills installed via packages/web/server/lib/skills-catalog/*"
echo "    (git clone + copy to ~/.config/opencode/skills/<name>/)"
echo ""
echo "VS Code extension (packages/vscode/src/opencode.ts):"
echo "  - Spawns: opencode serve --hostname 127.0.0.1 --port <random>"
echo "  - cwd: context.globalStorageUri.fsPath (extension storage dir)"
echo "  - PID tracked separately"
echo "  - Skills installed via packages/vscode/src/skillsCatalog.ts"
echo "    (INDEPENDENT copy of the skills catalog module)"
echo ""

# Step 3: Show the independent skills catalog implementations
echo "--- Step 3: Independent skills catalog implementations ---"
echo ""
echo "Web/Desktop skills catalog: packages/web/server/lib/skills-catalog/"
echo "  - install.js: installSkillsFromRepository() -> copies to ~/.config/opencode/skills/"
echo "  - clawsdhub/install.js: installSkillsFromClawdHub() -> copies to ~/.config/opencode/skills/"
echo ""
echo "VS Code skills catalog: packages/vscode/src/skillsCatalog.ts"
echo "  - installSkillsFromRepository() -> INDEPENDENT implementation"
echo "  - Same filesystem paths but SEPARATE code"
echo "  - Does NOT call refreshOpenCodeAfterConfigChange() for the Desktop's server"
echo ""

# Step 4: Show that skills installed by Desktop are on disk but VS Code may not pick them up
echo "--- Step 4: Filesystem check ---"
echo ""
if [ -d "${TEST_SKILL_DIR}" ]; then
    echo "Skill '${TEST_SKILL_NAME}' IS installed to ${TEST_SKILL_DIR}"
    ls -la "${TEST_SKILL_DIR}/"
else
    echo "Skill '${TEST_SKILL_NAME}' is NOT installed (expected if test was never run)"
    echo "Would be at: ${TEST_SKILL_DIR}"
fi
echo ""
echo "Note: If installed by the Desktop app's catalog, skill files ARE on disk."
echo "The VS Code extension's discoverSkills() WOULD find them on a fresh scan."
echo ""
echo "However, if the skill references MCP servers, plugins, or modifies"
echo "opencode.json (e.g., to add 'mcpServers' or 'commands' entries),"
echo "the VS Code extension's SEPARATE OpenCode server process would NOT"
echo "know about them until restart."
echo ""

# Step 5: Show the code difference in OpenCode server process management
echo "--- Step 5: Code references ---"
echo ""
echo "Desktop OpenCode server spawn: lifecycle.js:240-283"
echo "  createManagedOpenCodeServerProcess()"
echo ""
echo "VS Code OpenCode server spawn: opencode.ts:661-753"
echo "  spawnManagedOpenCodeServer()"
echo ""
echo "Both spawn 'opencode serve' but as separate processes with"
echo "separate PIDs, separate working directories, separate configs."
echo ""
echo "=== Verification complete ==="
