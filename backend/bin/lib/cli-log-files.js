import fs from 'fs';

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


function readTailLines(filePath, lineCount = DEFAULT_TAIL_LINES) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.slice(Math.max(0, lines.length - lineCount));
}

function followFile(filePath, onLine) {
  let position = 0;
  try {
    position = fs.statSync(filePath).size;
  } catch {
    position = 0;
  }

  let remainder = '';
  const interval = setInterval(() => {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size < position) {
        position = 0;
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
        const chunk = remainder + buffer.toString('utf8');
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
