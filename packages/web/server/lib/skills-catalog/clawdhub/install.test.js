import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

// Mock the ClawdHub network client so no real HTTP happens. The download
// function is what feeds the ZIP buffer into adm-zip inside install.js.
vi.mock('./api.js', () => ({
  downloadClawdHubSkill: vi.fn(),
  fetchClawdHubSkillInfo: vi.fn(),
}));

const { downloadClawdHubSkill } = await import('./api.js');
const { installSkillsFromClawdHub } = await import('./install.js');

/**
 * Build a real ZIP archive with adm-zip (the dependency under test).
 * Returns the raw Buffer, mirroring what downloadClawdHubSkill resolves to.
 */
function buildSkillZip(entries) {
  const zip = new AdmZip();
  for (const [entryName, content] of Object.entries(entries)) {
    zip.addFile(entryName, Buffer.from(content, 'utf8'));
  }
  return zip.toBuffer();
}

describe('installSkillsFromClawdHub (adm-zip extraction path)', () => {
  let userSkillDir;

  beforeEach(async () => {
    // Keep the target dir under os.tmpdir() so the temp->target rename in
    // install.js stays on one filesystem (avoids EXDEV cross-device errors).
    userSkillDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'clawdhub-test-skills-'));
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await fs.promises.rm(userSkillDir, { recursive: true, force: true }).catch(() => {});
  });

  it('extracts a real ZIP (incl. nested subdirectories) into the target skill dir', async () => {
    const skillMd = 'name: demo-skill\ndescription: adm-zip extraction regression guard\n';
    const nested = 'nested file content for subdirectory extraction check\n';
    downloadClawdHubSkill.mockResolvedValue(
      buildSkillZip({ 'SKILL.md': skillMd, 'nested/data.txt': nested }),
    );

    const result = await installSkillsFromClawdHub({
      scope: 'user',
      targetSource: 'opencode',
      userSkillDir,
      // Non-'latest' version avoids the fetchClawdHubSkillInfo resolve branch.
      selections: [{ clawdhub: { slug: 'demo-skill', version: '1.0.0' } }],
    });

    expect(result.ok).toBe(true);
    expect(result.installed).toEqual([
      { skillName: 'demo-skill', scope: 'user', source: 'opencode' },
    ]);
    expect(result.skipped).toEqual([]);

    // downloadClawdHubSkill received the resolved (non-latest) version.
    expect(downloadClawdHubSkill).toHaveBeenCalledWith('demo-skill', '1.0.0');

    // adm-zip actually wrote the files, preserving the nested subdirectory.
    const targetDir = path.join(userSkillDir, 'demo-skill');
    const skillMdPath = path.join(targetDir, 'SKILL.md');
    const nestedPath = path.join(targetDir, 'nested', 'data.txt');

    expect(fs.existsSync(skillMdPath)).toBe(true);
    expect(fs.existsSync(nestedPath)).toBe(true);
    expect(fs.readFileSync(skillMdPath, 'utf8')).toBe(skillMd);
    expect(fs.readFileSync(nestedPath, 'utf8')).toBe(nested);
  });

  it('skips a package whose extracted contents lack SKILL.md', async () => {
    // Valid ZIP, but no SKILL.md at the root -> install.js must skip it and
    // must NOT create the target dir. This exercises the extractAllTo path
    // followed by the post-extraction validation.
    downloadClawdHubSkill.mockResolvedValue(
      buildSkillZip({ 'README.md': 'no skill manifest here\n' }),
    );

    const result = await installSkillsFromClawdHub({
      scope: 'user',
      targetSource: 'opencode',
      userSkillDir,
      selections: [{ clawdhub: { slug: 'broken-skill', version: '1.0.0' } }],
    });

    expect(result.ok).toBe(true);
    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([
      { skillName: 'broken-skill', reason: 'SKILL.md not found in downloaded package' },
    ]);
    expect(fs.existsSync(path.join(userSkillDir, 'broken-skill'))).toBe(false);
  });
});
