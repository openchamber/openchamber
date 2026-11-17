
export const usage = 'Usage: opencode serve [--stdio] [--hostname <host>] [--port <port>] [--cors <origin>]... | opencode --version';

export const parseArgs = (argv) => {
  if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-v')) return { command: 'version' };
  if (argv[0] !== 'serve') return { command: 'unsupported' };
  const options = { command: 'serve', mode: 'default', cors: [] };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    const split = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = split === -1 ? arg : arg.slice(0, split);
    const inline = split === -1 ? undefined : arg.slice(split + 1);
    const value = () => {
      const next = inline ?? argv[++index];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === '--stdio') options.mode = 'stdio';
    else if (flag === '--hostname') options.hostname = value();
    else if (flag === '--port') {
      const raw = value();
      const port = Number(raw);
      if (!/^\d+$/.test(raw) || port > 65_535) throw new Error(`Invalid --port: ${raw}`);
      options.port = port;
    } else if (flag === '--cors') options.cors.push(value());
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
};
