import path from 'node:path';

import { isBoolean, isRecord, isString } from '../shared/guards.js';
import { SpaceError } from '../spaces/errors.js';

export const MAX_FILL_BYTES = 64 * 1024 * 1024;
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f\x85\u2028\u2029]/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const invalid = (field) => { throw new SpaceError('invalid_request', `Invalid hostd request field: ${field}`); };
// hostd parses every request on its one event loop, as root: each check here costs what a plain
// comparison costs, and a size limit comes before any look at the elements it bounds.
const objectOf = (value, field) => {
  if (!isRecord(value)) invalid(field);
  return value;
};
const text = (value, field, max = 1024) => {
  if (!isString(value) || value.length === 0 || Buffer.byteLength(value) > max || CONTROL_CHARACTERS.test(value)) invalid(field);
  return value;
};
function fields(value, allowed, required = allowed) {
  objectOf(value, 'object');
  if (Object.keys(value).some((key) => !allowed.includes(key)) || required.some((key) => !Object.hasOwn(value, key))) invalid('fields');
  return value;
}
const integer = (value, field, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(field);
  return value;
};
export const spaceId = (value) => /^[0-9a-f]{12}$/.test(text(value, 'id', 12)) ? value : invalid('id');
export const toolsKey = (value) => /^[0-9a-f]{16}$/.test(text(value, 'key', 16)) ? value : invalid('key');
const place = (value) => ['host', 'host-root'].includes(value) ? value : invalid('place');

function command(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) invalid('argv');
  if (value.some((arg) => !isString(arg) || arg.includes('\0')) || value[0] === '') invalid('argv');
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) invalid('argv size');
  return [...value];
}

function parseSpec(value) {
  fields(value, ['id', 'name', 'project', 'created', 'memoryBytes', 'purpose'], ['id', 'name', 'project', 'created', 'memoryBytes']);
  const project = text(value.project, 'project', 16);
  const created = text(value.created, 'created', 32);
  if (!/^[0-9a-f]{16}$/.test(project) || !Number.isFinite(Date.parse(created)) || new Date(created).toISOString() !== created) invalid('project/created');
  const purpose = value.purpose ?? 'general';
  if (!['general', 'pr-fix-loop-approval'].includes(purpose)) invalid('purpose');
  const spec = { id: spaceId(value.id), name: text(value.name, 'name', 100), project, created, memoryBytes: integer(value.memoryBytes, 'memoryBytes', 64 * 1024 * 1024, 1024 ** 4) };
  if (purpose !== 'general') spec.purpose = purpose;
  return spec;
}

function startConfiguration(value) {
  if (value === null || value === undefined) return null;
  text(value, 'startConfig', 64 * 1024);
  let parsed;
  try { parsed = JSON.parse(value); } catch { invalid('startConfig JSON'); }
  fields(parsed, ['providers']);
  if (Object.keys(objectOf(parsed.providers, 'providers')).length > 100) invalid('providers');
  for (const [id, entry] of Object.entries(parsed.providers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id)) invalid('provider');
    fields(entry, ['settings']);
    fields(entry.settings, ['baseURL', 'apiKey']);
    if (entry.settings.baseURL !== `http://gatekeeper:8080/model/${id}` || entry.settings.apiKey !== 'space-window') invalid('provider settings');
  }
  return value;
}

export function parseRequest(value) {
  objectOf(value, 'request');
  const op = text(value.op, 'op', 32);
  switch (op) {
    case 'check': fields(value, ['op']); return { op };
    case 'list': case 'disk': fields(value, ['op', 'place']); return { op, place: place(value.place) };
    case 'create': {
      fields(value, ['op', 'place', 'spec', 'startConfig', 'toolsKey', 'assertion'], ['op', 'place', 'spec', 'toolsKey']);
      return { op, place: place(value.place), spec: parseSpec(value.spec), startConfig: startConfiguration(value.startConfig), toolsKey: toolsKey(value.toolsKey), ...assertionField(value) };
    }
    case 'start':
      fields(value, ['op', 'place', 'id', 'assertion'], ['op', 'place', 'id']);
      return { op, place: place(value.place), id: spaceId(value.id), ...assertionField(value) };
    case 'stop': case 'remove': case 'verify':
      fields(value, ['op', 'place', 'id']); return { op, place: place(value.place), id: spaceId(value.id) };
    case 'exec': {
      fields(value, ['op', 'place', 'id', 'target', 'argv', 'timeoutMs', 'maxOutputBytes', 'keepTail'], ['op', 'place', 'id', 'target', 'argv']);
      if (!['space', 'gatekeeper'].includes(value.target)) throw new SpaceError('invalid_exec_target', 'A command runs in the space or gatekeeper');
      if (value.keepTail !== undefined && !isBoolean(value.keepTail)) invalid('keepTail');
      const keepTail = value.keepTail === true;
      return { op, place: place(value.place), id: spaceId(value.id), target: value.target, argv: command(value.argv), timeoutMs: integer(value.timeoutMs ?? 60_000, 'timeoutMs', 1, 4 * 3600_000), maxOutputBytes: integer(value.maxOutputBytes ?? 4 * 1024 * 1024, 'maxOutputBytes', 1, 128 * 1024 * 1024), keepTail };
    }
    case 'attach': {
      fields(value, ['op', 'place', 'id', 'argv'], ['op', 'place', 'id']);
      const request = { op, place: place(value.place), id: spaceId(value.id) };
      if (value.argv !== undefined) request.argv = command(value.argv);
      return request;
    }
    case 'tools-ensure': {
      fields(value, ['op', 'key', 'input']);
      const input = value.input;
      if (input !== null && (!isString(input) || input.length > Math.ceil(MAX_FILL_BYTES / 3) * 4 || !BASE64.test(input))) invalid('input');
      return { op, key: toolsKey(value.key), input };
    }
    case 'tools-prune':
      fields(value, ['op', 'keep']);
      if (!Array.isArray(value.keep) || value.keep.length > 16384) invalid('keep');
      return { op, keep: value.keep.map(toolsKey) };
    case 'root-status': case 'project-shares':
      fields(value, ['op']);
      return { op };
    case 'root-approval-challenge':
      fields(value, ['op', 'code']);
      return { op, code: text(value.code, 'code', 16) };
    case 'root-approval-complete': {
      fields(value, ['op', 'code', 'credential', 'response', 'label'], ['op', 'code', 'credential', 'response']);
      const credential = fields(value.credential, ['id', 'publicKey', 'rpID']);
      const request = {
        op,
        code: text(value.code, 'code', 16),
        credential: { id: text(credential.id, 'credential id', 1366), publicKey: text(credential.publicKey, 'credential key', 2048), rpID: text(credential.rpID, 'credential rpID', 255) },
        response: assertionOf(value.response),
      };
      if (value.label !== undefined) request.label = text(value.label, 'label', 480);
      return request;
    }
    case 'root-activation-options':
      if (value.action === 'create') {
        fields(value, ['op', 'action', 'spec']);
        return { op, action: 'create', spec: activationSpec(value.spec) };
      }
      fields(value, ['op', 'action', 'id']);
      if (value.action !== 'start') invalid('action');
      return { op, action: 'start', id: spaceId(value.id) };
    case 'share-project': case 'unshare-project': case 'project-owner':
      fields(value, ['op', 'path']);
      if (!path.isAbsolute(text(value.path, 'path', 4096)) || path.normalize(value.path) !== value.path) invalid('path');
      return { op, path: value.path };
    default: invalid('op');
  }
}

const base64url = (value, field, max) => (/^[A-Za-z0-9_-]+$/.test(text(value, field, max)) ? value : invalid(field));

/** A WebAuthn assertion as @simplewebauthn/browser hands it over; the root operations check its signature. */
function assertionOf(value) {
  fields(value, ['id', 'rawId', 'type', 'response', 'clientExtensionResults', 'authenticatorAttachment'], ['id', 'rawId', 'type', 'response']);
  if (value.type !== 'public-key') invalid('assertion type');
  const response = fields(value.response, ['clientDataJSON', 'authenticatorData', 'signature', 'userHandle'], ['clientDataJSON', 'authenticatorData', 'signature']);
  const extensions = objectOf(value.clientExtensionResults ?? {}, 'assertion extensions');
  if (JSON.stringify(extensions).length > 4096) invalid('assertion extensions');
  if (value.authenticatorAttachment !== undefined && !['platform', 'cross-platform'].includes(value.authenticatorAttachment)) invalid('assertion attachment');
  const id = base64url(value.id, 'assertion id', 2048);
  const rawId = base64url(value.rawId, 'assertion rawId', 2048);
  const signed = {
    clientDataJSON: base64url(response.clientDataJSON, 'clientDataJSON', 16_384),
    authenticatorData: base64url(response.authenticatorData, 'authenticatorData', 16_384),
    signature: base64url(response.signature, 'signature', 4096),
  };
  if (response.userHandle !== undefined) signed.userHandle = base64url(response.userHandle, 'userHandle', 1024);
  const assertion = { id, rawId, type: 'public-key', response: signed, clientExtensionResults: extensions };
  if (value.authenticatorAttachment !== undefined) assertion.authenticatorAttachment = value.authenticatorAttachment;
  return assertion;
}

// Only a root space's create and start carry a passkey assertion.
const assertionField = (value) => {
  if (value.assertion === undefined) return {};
  if (value.place !== 'host-root') invalid('assertion');
  return { assertion: assertionOf(value.assertion) };
};

/** What the confirmation of a root creation is bound to: the spec without its creation time. */
function activationSpec(value) {
  fields(value, ['id', 'name', 'project', 'memoryBytes', 'purpose'], ['id', 'name', 'project', 'memoryBytes']);
  const project = text(value.project, 'project', 16);
  if (!/^[0-9a-f]{16}$/.test(project)) invalid('project');
  const purpose = value.purpose ?? 'general';
  if (!['general', 'pr-fix-loop-approval'].includes(purpose)) invalid('purpose');
  const spec = { id: spaceId(value.id), name: text(value.name, 'name', 100), project, memoryBytes: integer(value.memoryBytes, 'memoryBytes', 64 * 1024 * 1024, 1024 ** 4) };
  if (purpose !== 'general') spec.purpose = purpose;
  return spec;
}
