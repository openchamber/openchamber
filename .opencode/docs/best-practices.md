# OpenChamber Development Best Practices

## Git & PR Workflow

### Before ANY git push
1. **Check `git status`** - verify only intended files are changed
2. **Check `git diff`** - review actual content changes
3. **Check `git diff --cached`** - verify staged changes
4. **Run `bun run type-check` && `bun run lint`** - ensure code quality

### PR Structure
- Each PR should contain ONLY related files for its purpose
- Split unrelated changes into separate PRs
- Never include documentation files, notes, temp files, or local configs in commits
- Use `git log origin/main..HEAD --oneline` to verify commits before pushing

### Local Files to NEVER commit
Add to `.gitignore` immediately if created:
- `COMPARISON_*.md` - comparison documents
- `OPENCHAMBER_NOTES.md` - personal notes
- `opencode-*-post.html` - draft posts
- `temp/*` - temporary files
- Any file with `.md` in root that isn't project documentation

### Creating Clean PRs
1. Create fresh branch from `origin/main`: `git checkout -b pr-name origin/main`
2. Cherry-pick only the commits needed: `git cherry-pick <commit-hash>`
3. Verify diff: `git diff origin/main --stat`
4. Push and create PR immediately

### Branch Naming
- `fix/*` - bug fixes
- `refactor/*` - code refactoring (no behavior change)
- `feat/*` - new features
- `revert/*` - reverts

### Resolving Merge Conflicts
1. Use `git checkout --theirs <file>` or `git checkout --ours <file>` for clean resolution
2. After resolving, `git add <file>` then `git cherry-pick --continue`
3. Never manually edit conflict markers unless absolutely necessary

### After Creating PR
- Verify PR diff on GitHub matches expectation
- If PR shows extra files, ABORT and recreate with clean commits
- Close/replace old PRs when creating new ones for same feature

---

## OpenChamber UI Development

### Key Rules
- **Theme System** - All UI colors must use theme tokens via `theme-system` skill
- **Styling** - Tailwind v4, typography via `packages/ui/src/lib/typography.ts`
- **State** - Zustand stores in `packages/ui/src/stores/`
- **No hardcoded colors** - Use theme variables, never `bg-red-500` or similar

### Important Files
- Settings shell: `packages/ui/src/components/views/SettingsView.tsx`
- Chat UI: `packages/ui/src/components/chat/`
- Sidebar: `packages/ui/src/components/session/sidebar/`
- Theme: `packages/ui/src/lib/theme/`

### Skills to Load
For UI work: `skill({ name: "theme-system" })`

---

## Custom Agent Development

### Creating Agents
Use the agent-creator skill: `skill({ name: "agent-creator" })`

### Agent File Conventions
- Location: `agents/<domain>/<name>.md`
- Naming: kebab-case, `a-z 0-9 -` only
- YAML frontmatter: name, description, mode, mcps, tools

### Mode Types
- `agent` - general agent
- `guard` - validation/approval
- `standalone` - independent task
- `assistant` - help-focused
- `supervisor`, `planner`, `executor`, `adjudicator` - HATS workflow

### Creating Skills
Use the skill-creator skill: `skill({ name: "skill-creator" })`
