import { z } from 'zod';

import { OpenChamberControlError, controlErrorFields } from '../openchamber-control/error.js';
import type { Request } from '../shared/http-contracts.js';
import type { createReceivedPageStore, ReceivedPage } from './received-store.js';
import type { createShareViewerClient } from './relay-client.js';
import type { JsonValue } from './contracts.js';
import { isPlainObject, isString } from '../shared/guards.js';
import {
  ANSWER_AAD,
  DOCUMENT_AAD,
  deriveShareSecrets,
  fromBase64Url,
  importEncKey,
  openJson,
  sealJson,
  toBase64Url,
} from './crypto.js';
import { parseShareLink, ShareLinkError } from './received-link.js';
import { receivedPageId } from './received-store.js';

const RECEIVED_ID_PATTERN = /^rp_[0-9a-f]{32}$/;
const PIN_PATTERN = /^\d{6}$/;
const MAX_ANSWER_SUMMARY_LENGTH = 500;
const MAX_ANSWER_DATA_LENGTH = 16_000;
const MAX_SOURCE_LENGTH = 200_000;

const ENTERPRISE_ERROR = 'Opening shared pages is not available in enterprise mode without a relay the policy allows.';
const enterpriseRefusal = () => new OpenChamberControlError(ENTERPRISE_ERROR, 403, { code: 'enterprise_mode' });
const relayUnreachable = (cause: unknown) => new OpenChamberControlError(`Could not reach the share relay: ${controlErrorFields(cause)?.message ?? 'unknown error'}`, 502);

const documentSchema = z.object({
  v: z.literal(1),
  title: z.string().catch(''),
  html: z.string(),
  source: z.object({
    format: z.enum(['ui', 'html']),
    text: z.string(),
    summary: z.string().nullish().transform((value) => value || null),
  }).nullish().catch(null),
});

export interface ReceivedPagesOptions {
  crypto: typeof import('node:crypto');
  store: ReturnType<typeof createReceivedPageStore>;
  relay: ReturnType<typeof createShareViewerClient>;
  isAvailable: () => boolean;
  isEnterpriseMode: () => boolean;
  allowedBases: () => Promise<string[]>;
  broadcast?: (event: { type: 'openchamber:received-page'; properties: { receivedId: string } }) => void;
  now?: () => number;
  logger?: Pick<Console, 'warn'>;
}

interface ReceivedAnswerInput {
  summary?: unknown;
  data?: unknown;
}

const answerInputFields = (input: Request['body']): ReceivedAnswerInput | undefined => input == null ? undefined : Object(input);

export const createReceivedPagesRuntime = ({
  crypto,
  store,
  relay,
  isAvailable,
  isEnterpriseMode,
  allowedBases,
  broadcast = () => {},
  now = Date.now,
  logger = console,
}: ReceivedPagesOptions) => {
  const locks = new Map<string | undefined, Promise<unknown>>();
  const withLock = <Result>(id: string | undefined, task: () => Promise<Result>) => {
    const previous = locks.get(id) ?? Promise.resolve();
    const run = previous.then(task);
    const settled = run.catch(() => undefined);
    locks.set(id, settled);
    void settled.then(() => {
      if (locks.get(id) === settled) locks.delete(id);
    });
    return run;
  };

  const persist = async (record: ReceivedPage) => {
    record.updatedAt = now();
    await store.save(record);
    try {
      broadcast({ type: 'openchamber:received-page', properties: { receivedId: record.id } });
    } catch (error) {
      logger.warn('[received-pages] broadcast failed:', controlErrorFields(error)?.message ?? error);
    }
  };

  const viewOf = (record: ReceivedPage) => ({
    receivedId: record.id,
    host: record.host,
    status: record.status === 'open' && record.expiresAt !== null && now() >= record.expiresAt ? 'expired' : record.status,
    kind: record.kind,
    wantsAnswer: record.wantsAnswer,
    expiresAt: record.expiresAt,
    attemptsLeft: record.attemptsLeft,
    opened: record.secrets !== null,
    title: record.title,
    source: record.source,
    answer: record.answer,
  });

  const requireAvailable = () => {
    if (!isAvailable()) throw enterpriseRefusal();
  };

  const findRecord = async (id: string | undefined) => {
    requireAvailable();
    if (!isString(id) || !RECEIVED_ID_PATTERN.test(id)) throw new OpenChamberControlError('No such shared page', 404);
    const record = await store.get(id);
    if (!record) throw new OpenChamberControlError('No such shared page', 404);
    if (isEnterpriseMode() && !(await allowedBases()).includes(record.base)) throw enterpriseRefusal();
    return record;
  };

  const applyPublicState = (record: ReceivedPage, { state }: Awaited<ReturnType<ReceivedPagesOptions['relay']['status']>>) => {
    if (!record.answer) record.status = state.status;
    if (state.kind !== undefined) record.kind = state.kind;
    if (state.wantsAnswer !== undefined) record.wantsAnswer = state.wantsAnswer;
    if (state.expiresAt !== undefined) record.expiresAt = state.expiresAt;
    if (state.attemptsLeft !== undefined) record.attemptsLeft = state.attemptsLeft;
  };

  const readStatus = async (record: ReceivedPage) => {
    try {
      applyPublicState(record, await relay.status(record.base, record.shareId));
    } catch (error) {
      throw relayUnreachable(error);
    }
  };

  const config = async () => {
    if (!isAvailable()) return { available: false, bases: [] };
    return { available: true, bases: await allowedBases() };
  };

  const register = async (url: Request['body']) => {
    requireAvailable();
    let link;
    try {
      link = parseShareLink(url, await allowedBases());
    } catch (error) {
      if (error instanceof ShareLinkError) {
        if (error.code === 'link_not_allowed' && isEnterpriseMode()) throw enterpriseRefusal();
        throw new OpenChamberControlError(error.message, 400, { code: error.code });
      }
      throw error;
    }
    const id = receivedPageId(crypto, link.base, link.shareId);
    return withLock(id, async () => {
      const existing = await store.get(id);
      const record: ReceivedPage = existing ?? {
        version: 1,
        id,
        base: link.base,
        shareId: link.shareId,
        host: link.host,
        linkKey: link.linkKey,
        secrets: null,
        createdAt: now(),
        updatedAt: now(),
        status: 'open',
        kind: null,
        wantsAnswer: false,
        expiresAt: null,
        attemptsLeft: null,
        title: null,
        source: null,
        answer: null,
      };
      if (!record.secrets) record.linkKey = link.linkKey;
      await persist(record);
      return viewOf(record);
    });
  };

  const refreshStatus = async (id: string | undefined) => {
    const record = await findRecord(id);
    return withLock(id, async () => {
      if (!record.answer) {
        await readStatus(record);
        await persist(record);
      }
      return viewOf(record);
    });
  };

  const get = async (id: string | undefined) => viewOf(await findRecord(id));

  const list = async () => {
    requireAvailable();
    const bases = isEnterpriseMode() ? await allowedBases() : null;
    const pages = (await store.list())
      .filter((record) => !bases || bases.includes(record.base))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((record) => {
        const { source: _source, answer, ...view } = viewOf(record);
        return { ...view, createdAt: record.createdAt, answer: answer ? { summary: answer.summary, submittedAt: answer.submittedAt } : null };
      });
    return { pages };
  };

  const document = async (id: string | undefined) => {
    const record = await findRecord(id);
    const html = record.secrets ? await store.readDocument(record.id) : null;
    if (html === null) throw new OpenChamberControlError('The page has not been opened yet', 404);
    return { html };
  };

  const readSource = (source: z.infer<typeof documentSchema>['source']) => (source
    ? { format: source.format, text: source.text.slice(0, MAX_SOURCE_LENGTH), summary: source.summary ? source.summary.slice(0, 500) : null }
    : null);

  const open = async (id: string | undefined, pin: Request['body']) => {
    if (!isString(pin) || !PIN_PATTERN.test(pin)) throw new OpenChamberControlError('pin must be six digits', 400);
    const record = await findRecord(id);
    return withLock(id, async () => {
      if (record.secrets) return viewOf(record);
      const secrets = await deriveShareSecrets(fromBase64Url(record.linkKey), pin);
      const auth = toBase64Url(secrets.auth);
      let opened;
      try {
        opened = await relay.open(record.base, record.shareId, auth);
      } catch (error) {
        throw relayUnreachable(error);
      }
      if (!opened.ok) {
        applyPublicState(record, opened);
        await persist(record);
        return { ...viewOf(record), pinRejected: opened.state?.error === 'wrong-pin' };
      }
      let value;
      try {
        value = documentSchema.parse(await openJson(await importEncKey(secrets.enc), opened.blob, DOCUMENT_AAD));
      } catch {
        throw new OpenChamberControlError('The page could not be decrypted', 502);
      }
      await store.saveDocument(record.id, value.html);
      Object.assign(record, {
        secrets: { auth, enc: toBase64Url(secrets.enc) },
        status: 'open',
        attemptsLeft: null,
        title: value.title.trim() || null,
        source: readSource(value.source),
      });
      await persist(record);
      return viewOf(record);
    });
  };

  const readAnswerInput = (input: Request['body']) => {
    const fields = answerInputFields(input);
    const summary = isString(fields?.summary) ? fields.summary.trim().slice(0, MAX_ANSWER_SUMMARY_LENGTH) : '';
    if (!summary) throw new OpenChamberControlError('summary is required', 400);
    const data = isPlainObject(input) && input.data !== undefined ? input.data : null;
    const encoded = JSON.stringify(data);
    if (encoded === undefined || encoded.length > MAX_ANSWER_DATA_LENGTH) {
      throw new OpenChamberControlError(`The answer is larger than the ${MAX_ANSWER_DATA_LENGTH} characters a shared page takes`, 413);
    }
    const parsed: JsonValue = JSON.parse(encoded);
    return { summary, data: parsed };
  };

  const answer = async (id: string | undefined, input: Request['body']) => {
    const record = await findRecord(id);
    const { summary, data } = readAnswerInput(input);
    return withLock(id, async () => {
      if (!record.secrets) throw new OpenChamberControlError('Open the page with its PIN first', 409);
      if (record.answer) throw new OpenChamberControlError('The answer was already sent', 409);
      if (!record.wantsAnswer) throw new OpenChamberControlError('This page does not take an answer', 409);
      const submittedAt = now();
      const sealed = await sealJson(await importEncKey(fromBase64Url(record.secrets.enc)), { v: 1, data, summary, submittedAt }, ANSWER_AAD);
      let sent;
      try {
        sent = await relay.answer(record.base, record.shareId, record.secrets.auth, toBase64Url(sealed));
      } catch (error) {
        throw relayUnreachable(error);
      }
      if (!sent.ok) {
        if (![409, 410, 423].includes(sent.httpStatus)) {
          throw new OpenChamberControlError(`The share relay refused the answer (${sent.httpStatus})`, 502);
        }
        applyPublicState(record, sent);
        await persist(record);
        throw new OpenChamberControlError(`The page no longer takes an answer (${record.status})`, 409, { code: `page_${record.status}` });
      }
      Object.assign(record, { answer: { summary, data, submittedAt }, status: 'answered' });
      await persist(record);
      return viewOf(record);
    });
  };

  return { config, register, refreshStatus, get, list, document, open, answer };
};
