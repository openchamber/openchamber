import fs from 'fs/promises';
import path from 'path';
import os from 'os';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'openchamber', 'teams');
const SNOOZE_FILE = path.join(CONFIG_DIR, 'inbox-snooze.json');

export async function getSnoozes() {
  try {
    const data = await fs.readFile(SNOOZE_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export async function snoozeItem(id, untilTimestamp) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  const snoozes = await getSnoozes();
  snoozes[id] = untilTimestamp;
  await fs.writeFile(SNOOZE_FILE, JSON.stringify(snoozes, null, 2), { mode: 0o600 });
}

export async function unsnoozeItem(id) {
  const snoozes = await getSnoozes();
  if (id in snoozes) {
    delete snoozes[id];
    await fs.writeFile(SNOOZE_FILE, JSON.stringify(snoozes, null, 2), { mode: 0o600 });
  }
}

export async function filterSnoozed(items, getId) {
  const snoozes = await getSnoozes();
  const now = Date.now();
  let dirty = false;

  const activeSnoozes = new Set();
  for (const [id, until] of Object.entries(snoozes)) {
    if (until < now) {
      delete snoozes[id];
      dirty = true;
    } else {
      activeSnoozes.add(id);
    }
  }

  if (dirty) {
    await fs.writeFile(SNOOZE_FILE, JSON.stringify(snoozes, null, 2), { mode: 0o600 });
  }

  return items.filter((item) => !activeSnoozes.has(getId(item)));
}
