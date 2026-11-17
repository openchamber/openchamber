import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-objectives-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;
const {
  GOAL_OBJECTIVE_HARD_CAP,
  GOAL_OBJECTIVE_VERSION_CAP,
  appendObjectiveVersion,
  deleteObjectiveVersion,
  deleteObjectiveVersions,
  goalObjectiveLimits,
  listObjectiveVersions,
  readObjective,
  readObjectiveVersion,
  writeObjective,
} = await import('./objectives.js');
afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  delete process.env.OPENCHAMBER_DATA_DIR;
});

describe('goal objective limits', () => {
  it('reads both limits from Settings, and the defaults for missing or out-of-range values', () => {
    expect(goalObjectiveLimits({ sessionGoalObjectiveCharLimit: 12_000, sessionGoalCheckObjectiveCharLimit: 30_000 }))
      .toEqual({ objective: 12_000, check: 30_000 });
    expect(goalObjectiveLimits({ sessionGoalObjectiveCharLimit: 10, sessionGoalCheckObjectiveCharLimit: 'big' }))
      .toEqual({ objective: 5_000, check: 20_000 });
    expect(goalObjectiveLimits(null)).toEqual({ objective: 5_000, check: 20_000 });
  });

  // The goal's own limit is applied before the write; the file must keep a
  // goal whose limit was raised or switched off.
  it('stores and reads back an objective longer than the default limit', async () => {
    const long = 'x'.repeat(12_000);
    await expect(writeObjective('ses_long1', long)).resolves.toEqual({ content: long });
    await expect(readObjective('ses_long1')).resolves.toBe(long);
  });
});

describe('goal objective read bound (#1582)', () => {  const goalsDir = path.join(dataDir, 'goals');
  const plant = (sessionId, content) => {
    fs.mkdirSync(goalsDir, { recursive: true });
    fs.writeFileSync(path.join(goalsDir, `${sessionId}.md`), content);
  };

  // The write path clamps before writing, so an over-cap file only arrives
  // out-of-band; the read must clamp it without buffering it whole.
  it('clamps an over-cap objective planted on disk to the hard cap', async () => {
    plant('ses_big1', 'y'.repeat(5_000_000));
    const read = await readObjective('ses_big1');
    expect(read).toBe('y'.repeat(1_000_000));
  });

  it('reads a goal at exactly the hard cap byte-identical', async () => {
    const atCap = 'z'.repeat(1_000_000);
    plant('ses_cap1', atCap);
    await expect(readObjective('ses_cap1')).resolves.toBe(atCap);
  });

  it('rejects a FIFO at the objective path promptly instead of blocking', async () => {
    fs.mkdirSync(goalsDir, { recursive: true });
    const fifoPath = path.join(goalsDir, 'ses_fifo1.md');
    execFileSync('mkfifo', [fifoPath]);
    const settled = await Promise.race([
      readObjective('ses_fifo1').then((value) => ({ value })),
      new Promise((resolve) => { setTimeout(() => resolve({ value: 'did-not-settle' }), 2_000); }),
    ]);
    expect(settled.value).toBeNull();
  });

  it('rejects a directory at the objective path as null', async () => {
    fs.mkdirSync(path.join(goalsDir, 'ses_dir1.md'), { recursive: true });
    await expect(readObjective('ses_dir1')).resolves.toBeNull();
  });
});

describe('goal objective version history (#1830)', () => {
  const goalsDir = path.join(dataDir, 'goals');
  const versionsFile = (sessionId) => path.join(goalsDir, `${sessionId}.versions.json`);

  it('retains each saved version with a timestamp, newest first', async () => {
    const first = await appendObjectiveVersion('ses_ver1', 'first spec', 1_000);
    expect(first.versions).toHaveLength(1);
    expect(first.versionId).toBe(first.versions[0].id);
    expect(first.versions[0]).toMatchObject({ content: 'first spec', savedAt: 1_000 });
    expect(first.versions[0].id).toMatch(/^v[0-9a-z]+$/);

    const second = await appendObjectiveVersion('ses_ver1', 'second spec', 2_000);
    expect(second.versions.map((version) => version.content)).toEqual(['second spec', 'first spec']);
    await expect(listObjectiveVersions('ses_ver1')).resolves.toEqual(second.versions);
  });

  it('records nothing when the text equals the newest version', async () => {
    await appendObjectiveVersion('ses_ver2', 'same spec', 1_000);
    const unchanged = await appendObjectiveVersion('ses_ver2', 'same spec', 2_000);
    expect(unchanged.versionId).toBeNull();
    expect(unchanged.versions).toHaveLength(1);
    expect(unchanged.versions[0].savedAt).toBe(1_000);
  });

  it('reads one version back by id, and null for an unknown id', async () => {
    const { versions } = await appendObjectiveVersion('ses_ver3', 'readable spec', 1_000);
    const [version] = versions;
    await expect(readObjectiveVersion('ses_ver3', version.id)).resolves.toMatchObject({
      id: version.id,
      content: 'readable spec',
      savedAt: 1_000,
    });
    await expect(readObjectiveVersion('ses_ver3', 'vmissing')).resolves.toBeNull();
  });

  it('deletes one version by id, and is a no-op for an unknown id', async () => {
    const { versionId } = await appendObjectiveVersion('ses_ver9', 'undo me', 1_000);
    await appendObjectiveVersion('ses_ver9', 'keep me', 2_000);
    await expect(listObjectiveVersions('ses_ver9')).resolves.toHaveLength(2);
    await deleteObjectiveVersion('ses_ver9', versionId);
    const remaining = await listObjectiveVersions('ses_ver9');
    expect(remaining.map((version) => version.content)).toEqual(['keep me']);
    // An unknown id changes nothing.
    await deleteObjectiveVersion('ses_ver9', 'vmissing');
    await expect(listObjectiveVersions('ses_ver9')).resolves.toEqual(remaining);
  });

  it('prunes the oldest versions beyond the cap', async () => {
    const sessionId = 'ses_ver4';
    for (let index = 0; index < GOAL_OBJECTIVE_VERSION_CAP + 5; index += 1) {
      await appendObjectiveVersion(sessionId, `spec ${index}`, index);
    }
    const versions = await listObjectiveVersions(sessionId);
    expect(versions).toHaveLength(GOAL_OBJECTIVE_VERSION_CAP);
    // The newest survives, the oldest five are gone.
    expect(versions[0].content).toBe(`spec ${GOAL_OBJECTIVE_VERSION_CAP + 4}`);
    expect(versions.at(-1).content).toBe('spec 5');
    expect(versions.some((version) => version.content === 'spec 0')).toBe(false);
  });

  it('keeps the history bounded on disk at the cap', async () => {
    for (let index = 0; index < GOAL_OBJECTIVE_VERSION_CAP + 3; index += 1) {
      await appendObjectiveVersion('ses_ver5', `disk spec ${index}`, index);
    }
    const stored = JSON.parse(fs.readFileSync(versionsFile('ses_ver5'), 'utf8'));
    expect(stored).toHaveLength(GOAL_OBJECTIVE_VERSION_CAP);
  });

  it('reads a malformed history file as empty instead of failing', async () => {
    fs.mkdirSync(goalsDir, { recursive: true });
    fs.writeFileSync(versionsFile('ses_ver6'), '{not json');
    await expect(listObjectiveVersions('ses_ver6')).resolves.toEqual([]);
    // A save over a corrupt history still records the new version.
    const { versions } = await appendObjectiveVersion('ses_ver6', 'recovered spec', 1_000);
    expect(versions.map((version) => version.content)).toEqual(['recovered spec']);
  });

  it('drops malformed entries but keeps the valid ones', async () => {
    fs.mkdirSync(goalsDir, { recursive: true });
    fs.writeFileSync(versionsFile('ses_ver7'), JSON.stringify([
      { id: 'vok1', content: 'kept', savedAt: 5 },
      { id: 'bad id', content: 'dropped', savedAt: 4 },
      { id: 'vok2', content: 7, savedAt: 3 },
      null,
    ]));
    const versions = await listObjectiveVersions('ses_ver7');
    expect(versions.map((version) => version.content)).toEqual(['kept']);
  });

  it('deletes the history and is a no-op for an invalid session id', async () => {
    await appendObjectiveVersion('ses_ver8', 'to delete', 1_000);
    await deleteObjectiveVersions('ses_ver8');
    await expect(listObjectiveVersions('ses_ver8')).resolves.toEqual([]);
    await expect(appendObjectiveVersion('../escape', 'x')).rejects.toMatchObject({ statusCode: 400 });
    await expect(listObjectiveVersions('../escape')).resolves.toEqual([]);
  });

  it('rejects a FIFO at the versions path promptly instead of blocking (#2295)', async () => {
    fs.mkdirSync(goalsDir, { recursive: true });
    execFileSync('mkfifo', [versionsFile('ses_verfifo')]);
    const settled = await Promise.race([
      listObjectiveVersions('ses_verfifo').then((value) => ({ value })),
      new Promise((resolve) => { setTimeout(() => resolve({ value: 'did-not-settle' }), 2_000); }),
    ]);
    expect(settled.value).toEqual([]);
  });

  it('reads a directory at the versions path as empty history (#2295)', async () => {
    fs.mkdirSync(versionsFile('ses_verdir'), { recursive: true });
    await expect(listObjectiveVersions('ses_verdir')).resolves.toEqual([]);
  });

  it('reads an over-bound versions file as empty instead of buffering it whole (#2295)', async () => {
    fs.mkdirSync(goalsDir, { recursive: true });
    const huge = JSON.stringify([
      { id: 'vbig', content: 'x'.repeat(GOAL_OBJECTIVE_VERSION_CAP * GOAL_OBJECTIVE_HARD_CAP * 4 + 1_000_000), savedAt: 1 },
    ]);
    fs.writeFileSync(versionsFile('ses_verbig'), huge);
    await expect(listObjectiveVersions('ses_verbig')).resolves.toEqual([]);
  });
});

describe('objective clamp surrogate-pair boundary (#1949)', () => {
  const EMOJI = '\u{1F600}';

  it('a pair straddling the hard cap is dropped whole and never persisted as U+FFFD', async () => {
    const content = `${'a'.repeat(999_999)}${EMOJI}${'z'.repeat(500)}`;
    const written = await writeObjective('ses_pair1', content);
    expect(written.content).toBe('a'.repeat(999_999));
    const read = await readObjective('ses_pair1');
    expect(read).toBe('a'.repeat(999_999));
    expect(Buffer.from(read, 'utf8').toString('utf8')).toBe(read);
  });

  it('a pair ending exactly at the cap is kept whole', async () => {
    const content = `${'a'.repeat(999_998)}${EMOJI}`;
    const written = await writeObjective('ses_pair2', content);
    expect(written.content).toBe(content);
    expect(written.content.length).toBe(1_000_000);
  });
});

describe('goal objective durable writes (#2330)', () => {
  const goalsDir = path.join(dataDir, 'goals');
  // An fs whose writeFile always fails the way a full disk would, threaded
  // through the durable helper's own fs seam. Everything else (mkdir,
  // rename, rm) stays real, so only the write itself is broken.
  const failingFs = {
    ...fs.promises,
    writeFile: async () => {
      throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    },
  };
  const tempFiles = () => fs.readdirSync(goalsDir).filter((name) => name.includes('.tmp-'));

  it('a failed objective write leaves the previous objective readable and unchanged', async () => {
    await writeObjective('ses_atomic1', 'the original objective');
    await expect(writeObjective('ses_atomic1', 'the replacement', { fs: failingFs }))
      .rejects.toThrow('ENOSPC');
    await expect(readObjective('ses_atomic1')).resolves.toBe('the original objective');
    expect(tempFiles()).toEqual([]);
  });

  it('a failed version-history write leaves the previous versions readable and unchanged', async () => {
    await appendObjectiveVersion('ses_atomic2', 'version one', 1_000);
    const before = await listObjectiveVersions('ses_atomic2');
    expect(before).toHaveLength(1);
    await expect(appendObjectiveVersion('ses_atomic2', 'version two', 2_000, { fs: failingFs }))
      .rejects.toThrow('ENOSPC');
    await expect(listObjectiveVersions('ses_atomic2')).resolves.toEqual(before);
    expect(tempFiles()).toEqual([]);
  });

  it('written goal files carry the mode they were created with before the durable writer', async () => {
    await writeObjective('ses_atomic3', 'mode check');
    const stat = fs.statSync(path.join(goalsDir, 'ses_atomic3.md'));
    expect(stat.mode & 0o777).toBe(0o666 & ~process.umask());
  });
});
