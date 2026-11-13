// Task names travel as display data. The host owns the name and its ownership;
// the server inside only keeps an agent proposal and a copy of the user's name.
import { z } from 'zod';
import { readSpaceSettingFile, writeSpaceSettingFile } from './space-setting-file.js';

export const SPACE_TASK_TITLE_EVENT = 'openchamber:space-task-title.updated';
export const SPACE_TASK_TITLE_ROUTE = '/api/openchamber/space-task-title';
export const spaceTaskTitleSchema = z.object({ title: z.string().min(1).max(120), by: z.enum(['user', 'agent']) });
const titleFileSchema = z.object({ title: z.string().max(120) });

/** Repeated at the host boundary: the space can replace its server and files. */
export const sanitizeSpaceTaskTitle = (value) => {
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return '';
  return parsed.data.split(/[\r\n\u2028\u2029]/)[0].replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 120);
};

export const createInsideSpaceTaskNaming = ({ agentFile, userFile, announce }) => {
  const read = async () => ({ title: sanitizeSpaceTaskTitle((await readSpaceSettingFile(agentFile, titleFileSchema))?.title) });
  const nameOnce = async (directory, rawTitle) => {
    const spaceId = /^\/spaces\/([0-9a-f]{12})(?:\/|$)/.exec(directory)?.[1];
    if (!spaceId) return null;
    const userTitle = sanitizeSpaceTaskTitle((await readSpaceSettingFile(userFile, titleFileSchema))?.title);
    if (userTitle) return { task: 'space', title: userTitle, named: false, reason: 'The user named this task; keep their name.' };
    const title = sanitizeSpaceTaskTitle(rawTitle);
    if (!title) throw new Error('title is required');
    await writeSpaceSettingFile(agentFile, { title }, titleFileSchema);
    announce({ type: SPACE_TASK_TITLE_EVENT, properties: { spaceId, title } });
    return { task: 'space', title, named: true };
  };
  let tail = Promise.resolve();
  const name = (directory, title) => {
    const next = tail.then(() => nameOnce(directory, title));
    tail = next.catch(() => {});
    return next;
  };
  return { read, name };
};
