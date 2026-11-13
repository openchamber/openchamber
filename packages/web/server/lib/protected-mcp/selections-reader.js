// Serialized into the managed OpenCode plugin with the personal MCP reader.
// Every dependency is an argument, so bundling the host cannot rewrite imports.
export function protectedSelectionReader(dataDir, { fs, path, isBoolean, isPlainObject, isString }) {
  class ProtectedSelectionError extends Error {
    constructor(code) {
      super('Protected MCP selections could not be applied');
      this.name = 'ProtectedSelectionError';
      this.code = code;
    }
  }
  const fail = (code = 'PROTECTED_SELECTION_INVALID') => { throw new ProtectedSelectionError(code); };
  const directory = path.join(dataDir, 'mcp-protected');
  const NAME = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;
  const CONNECTION = /^pmcp_[0-9a-f]{16}$/;
  const validateName = (name) => {
    if (!isString(name) || name.length > 64 || !NAME.test(name)) fail();
  };
  const parseEntry = (value) => {
    if (!isPlainObject(value)) fail();
    for (const key of Object.keys(value)) if (key !== 'connection' && key !== 'disabled') fail();
    if (!isString(value.connection) || !CONNECTION.test(value.connection)) fail();
    if ('disabled' in value && !isBoolean(value.disabled)) fail();
    return value.disabled === true ? { connection: value.connection, disabled: true } : { connection: value.connection };
  };
  const readDocument = (file, identity) => {
    let content;
    try { content = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') return { servers: {}, exists: false };
      fail('PROTECTED_SELECTION_UNREADABLE');
    }
    let document;
    try { document = JSON.parse(content); }
    catch { fail(); }
    if (!isPlainObject(document) || document.version !== 1 || !isPlainObject(document.servers)) fail();
    if (identity !== null && document.identity !== identity) fail();
    const servers = {};
    for (const [name, entry] of Object.entries(document.servers)) {
      validateName(name);
      servers[name] = parseEntry(entry);
    }
    return { servers, exists: true };
  };
  /** The two files of a location, from the personal MCP reader's target for it. */
  const resolve = (localTarget) => ({
    directory,
    identity: localTarget.identity,
    global: path.join(directory, 'global.json'),
    project: path.join(directory, `project-${path.basename(localTarget.path)}`),
  });
  const readTarget = (target) => {
    const global = readDocument(target.global, null).servers;
    const project = readDocument(target.project, target.identity).servers;
    const effective = {};
    for (const [name, entry] of Object.entries(global)) if (!entry.disabled) effective[name] = entry;
    for (const [name, entry] of Object.entries(project)) {
      if (entry.disabled) delete effective[name];
      else effective[name] = entry;
    }
    return { global, project, effective };
  };
  /** What OpenChamber installed for reaching the service, or null when it is absent or unreadable. */
  const readClientConfig = (file) => {
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch { return null; }
    if (!isPlainObject(value) || value.version !== 1 || !isString(value.socket) || !path.isAbsolute(value.socket)) return null;
    if (!Array.isArray(value.relay) || value.relay.length === 0 || !value.relay.every((part) => isString(part) && part.length > 0)) return null;
    return { socket: value.socket, relay: [...value.relay] };
  };
  const unavailable = ['/bin/sh', '-c', 'echo "OpenChamber protected MCP service is not installed or not readable on this host" >&2; exit 69'];
  /** OpenCode MCP entries for the effective selections: each starts the relay for one connection id. */
  const materialize = (effective, clientConfigFile) => {
    const client = readClientConfig(clientConfigFile);
    const entries = {};
    for (const [name, entry] of Object.entries(effective)) {
      entries[name] = {
        type: 'local',
        command: client ? [...client.relay, '--socket', client.socket, entry.connection] : [...unavailable],
      };
    }
    return entries;
  };
  return { resolve, readTarget, readDocument, materialize, validateName, parseEntry, readClientConfig };
}
