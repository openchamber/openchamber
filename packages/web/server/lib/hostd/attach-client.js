// Root-owned argv endpoint used by git's ext:: transport. It never interprets a shell command.
import { createHostdClient } from './client.js';
import { parseRequest } from './validation.js';

const args = process.argv.slice(2);
const socketPath = args[0] === '--socket' ? args.splice(0, 2)[1] : undefined;
if (socketPath !== undefined && !socketPath.startsWith('/')) throw new Error('The hostd socket path must be absolute');
const [operation, place, id, ...argv] = args;
if (operation !== 'attach') throw new Error('Expected attach <place> <id> [argv...]');
try {
  const attach = { op: 'attach', place, id };
  if (argv.length) attach.argv = argv;
  const request = parseRequest(attach);
  const stream = await createHostdClient({ socketPath }).attach(request);
  let exit = 1;
  stream.on('exit', (code) => { exit = code; });
  stream.on('stderr', (bytes) => process.stderr.write(bytes));
  stream.on('error', (error) => { process.stderr.write(`${error.code}: ${error.message}\n`); process.exitCode = 1; });
  stream.on('end', () => { process.exitCode = exit; });
  process.stdin.on('error', () => stream.destroy());
  process.stdout.on('error', () => stream.destroy());
  process.stdin.pipe(stream);
  stream.pipe(process.stdout);
} catch (error) { process.stderr.write(`${error.code ?? 'attach_failed'}: ${error.message}\n`); process.exitCode = 1; }
