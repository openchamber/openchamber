// Reads a new password from the person at the terminal, without showing it. The installer often
// runs as `curl ... | sudo bash`, where stdin is the script itself, so the terminal is opened by name.
import fs from 'node:fs';
import tty from 'node:tty';

/** The line the keys make so far, and whether Enter, Ctrl-D or Ctrl-C ended it. */
export function typed(state, keys) {
  // An arrow or function key arrives as one escape sequence: nothing of it is typed.
  if (keys.startsWith('\u001b')) return state;
  let { value } = state;
  for (const key of keys) {
    if (key === '\r' || key === '\n' || key === '\u0004') return { value, done: true, cancelled: false };
    if (key === '\u0003') return { value: '', done: true, cancelled: true };
    if (key === '\u007f' || key === '\b') value = [...value].slice(0, -1).join('');
    else if (key >= ' ') value += key;
  }
  return { value, done: false, cancelled: false };
}

async function readHidden(prompt, device) {
  let input = null;
  let output = null;
  try {
    input = new tty.ReadStream(fs.openSync(device, 'r'));
    output = new tty.WriteStream(fs.openSync(device, 'w'));
  } catch {
    input?.destroy();
    return null;
  }
  try {
    output.write(prompt);
    input.setRawMode(true);
    const result = await new Promise((resolve, reject) => {
      let state = { value: '', done: false, cancelled: false };
      input.on('data', (chunk) => {
        state = typed(state, chunk.toString('utf8'));
        if (state.done) resolve(state);
      });
      input.once('error', reject);
    });
    output.write('\n');
    if (result.cancelled) throw Object.assign(new Error('The password was not given'), { code: 'cancelled' });
    return result.value;
  } finally {
    input.setRawMode(false);
    input.destroy();
    output.destroy();
  }
}

/** A new password, typed twice at the terminal; null when there is no terminal to ask. */
export async function askNewPassword({ device = '/dev/tty' } = {}) {
  const first = await readHidden('Password for OpenChamber: ', device);
  if (first === null) return null;
  const again = await readHidden('The same password again: ', device);
  if (first !== again) throw Object.assign(new Error('The two passwords differ'), { code: 'ui_password_mismatch' });
  return first;
}
