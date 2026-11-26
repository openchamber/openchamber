import { z } from 'zod';

export const failureStatus = z.object({ status: z.number().int() });

export class KeyedCallRefusal extends Error {}

export const echoesKey = (key: string | undefined, ...answers: (string | Buffer)[]) =>
  key !== undefined && key !== '' && answers.some((answer) => answer.includes(key));

export const keyedCallFailure = (what: string, status: number | undefined) => {
  console.warn(`[voice] ${what} failed`, { status: status ?? null });
  return new Error(status === undefined ? `${what} failed: the server could not be reached` : `${what} failed: the server answered ${status}`);
};

export const keyedCallRefused = (what: string) => {
  console.warn(`[voice] ${what} refused: the answer was not one the server accepts`);
  return new KeyedCallRefusal(`${what} failed: the server's answer was not accepted`);
};
