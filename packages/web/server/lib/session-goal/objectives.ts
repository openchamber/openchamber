
import fs from 'fs';
import os from 'os';
import path from 'path';

export type ObjectiveContent = string | number | boolean | null | ObjectiveContent[] | { [key: string]: ObjectiveContent };

export const GOAL_OBJECTIVE_CHAR_LIMIT = 5_000;

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const goalsDir = () => path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'goals',
);

const objectiveFilePath = (sessionId: string) => path.join(goalsDir(), `${sessionId}.md`);

const isValidObjectiveKey = (sessionId: unknown): sessionId is string =>
  typeof sessionId === 'string' && SESSION_ID_PATTERN.test(sessionId);

const clampContent = (content: ObjectiveContent | undefined) => String(content ?? '').trim().slice(0, GOAL_OBJECTIVE_CHAR_LIMIT);

export const writeObjective = async (sessionId: string, content: ObjectiveContent | undefined) => {
  if (!isValidObjectiveKey(sessionId)) {
    throw Object.assign(new Error('invalid session id'), { statusCode: 400 });
  }
  const text = clampContent(content);
  if (!text) {
    throw Object.assign(new Error('objective content is required'), { statusCode: 400 });
  }
  await fs.promises.mkdir(goalsDir(), { recursive: true });
  await fs.promises.writeFile(objectiveFilePath(sessionId), text, 'utf8');
  return { content: text };
};

export const readObjective = async (sessionId: string) => {
  if (!isValidObjectiveKey(sessionId)) return null;
  try {
    const raw = await fs.promises.readFile(objectiveFilePath(sessionId), 'utf8');
    return clampContent(raw);
  } catch {
    return null;
  }
};

export const deleteObjective = async (sessionId: string) => {
  if (!isValidObjectiveKey(sessionId)) return;
  await fs.promises.unlink(objectiveFilePath(sessionId)).catch(() => undefined);
};
