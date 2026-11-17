import fs from 'fs';
import { StringDecoder } from 'string_decoder';

const DEFAULT_TAIL_LINES = 200;
const LOG_ROTATE_MAX_BYTES = 10 * 1024 * 1024;
const LOG_ROTATE_KEEP = 5;

function rotateLogFile(logPath) {
  try {
    const stats = fs.statSync(logPath);
    if (stats.size < LOG_ROTATE_MAX_BYTES) {
      return;
    }
  } catch {
    return;
  }

  for (let i = LOG_ROTATE_KEEP - 1; i >= 1; i--) {
    const src = `${logPath}.${i}`;
    const dst = `${logPath}.${i + 1}`;
    if (fs.existsSync(src)) {
      try {
        fs.renameSync(src, dst);
      } catch {
      }
    }
  }

  try {
    if (fs.existsSync(logPath)) {
      fs.renameSync(logPath, `${logPath}.1`);
    }
  } catch {
  }
}


// Bounded tail window for readTailLines (#1706): the read starts with the
// last TAIL_WINDOW_BYTES of the file and doubles up to
// MAX_TAIL_READ_BYTES until it holds more lines than requested (the extra
// line covers the partial first line of a mid-file window) or the whole
// file has been read. A log is never buffered whole beyond that cap, and
// the window is read positionally from an O_NONBLOCK handle judged
// regular from the handle — the followFile precedent below — so a FIFO or
// other non-regular log path settles promptly with [] instead of blocking
// in open(). For ordinary logs the returned lines are exactly the lines a
// whole-file read returned.
const TAIL_WINDOW_BYTES = 256 * 1024;
const MAX_TAIL_READ_BYTES = 8 * 1024 * 1024;

function readTailLines(filePath, lineCount = DEFAULT_TAIL_LINES) {
  if (!Number.isFinite(lineCount) || lineCount <= 0) {
    return [];
  }
  let fd;
  try {
    fd = fs.openSync(
      filePath,
      process.platform === 'win32' ? 'r' : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK,
    );
  } catch {
    return [];
  }
  try {
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size === 0) {
      return [];
    }
    let windowBytes = Math.min(stats.size, TAIL_WINDOW_BYTES);
    for (;;) {
      const start = stats.size - windowBytes;
      const buffer = Buffer.alloc(windowBytes);
      fs.readSync(fd, buffer, 0, windowBytes, start);
      const lines = buffer.toString('utf8').split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') {
        lines.pop();
      }
      // A window that starts mid-file may open with a partial line, so the
      // first segment is only trusted when the window starts at the file's
      // first byte; otherwise it is dropped and the window must still hold
      // lineCount complete lines (growing until it does, or the cap hits).
      const complete = start > 0 ? lines.slice(1) : lines;
      if (start === 0 || complete.length >= lineCount || windowBytes >= MAX_TAIL_READ_BYTES) {
        return complete.slice(Math.max(0, complete.length - lineCount));
      }
      windowBytes = Math.min(stats.size, windowBytes * 2, MAX_TAIL_READ_BYTES);
    }
  } catch {
    return [];
  } finally {
    fs.closeSync(fd);
  }
}

function followFile(filePath, onLine) {
  let position = 0;
  try {
    position = fs.statSync(filePath).size;
  } catch {
    position = 0;
  }

  let remainder = '';
  // Bytes are decoded incrementally: a multi-byte character split across
  // two polls must not be decoded in halves (each half would become
  // U+FFFD), so the decoder holds the undecoded byte tail between polls.
  let decoder = new StringDecoder('utf8');
  const interval = setInterval(() => {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size < position) {
        // Truncation/rotation: start over with a clean decoder and no
        // carried line fragment — both belong to the file that is gone.
        position = 0;
        remainder = '';
        decoder = new StringDecoder('utf8');
      }
      if (stats.size === position) {
        return;
      }

      const fd = fs.openSync(filePath, 'r');
      try {
        const length = stats.size - position;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, position);
        position = stats.size;
        const chunk = remainder + decoder.write(buffer);
        const parts = chunk.split(/\r?\n/);
        remainder = parts.pop() || '';
        for (const line of parts) {
          onLine(line);
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch {
    }
  }, 400);

  return () => {
    clearInterval(interval);
  };
}


export { rotateLogFile, readTailLines, followFile };
