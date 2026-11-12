import { expect, test } from 'bun:test';
import { DirectoryRequests } from './directoryRequests';

const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
};

test('same-directory callers wait for one request; other directories load independently', async () => {
  const requests = new DirectoryRequests();
  const gate = deferred();
  let calls = 0;
  let complete = false;
  const first = requests.run('/a', async () => { calls++; await gate.promise; complete = true; });
  const second = requests.run('/a', async () => { calls++; });
  expect(second).toBe(first);
  await requests.run('/b', async () => { calls++; });
  expect(calls).toBe(2);
  expect(complete).toBe(false);
  expect(requests.has('/a')).toBe(true);
  gate.resolve();
  await second;
  expect(complete).toBe(true);
  expect(requests.has('/a')).toBe(false);
});

test('a forced mutation refresh supersedes old reads without their cleanup losing the new slot', async () => {
  const requests = new DirectoryRequests();
  const oldGate = deferred();
  const newGate = deferred();
  const published: string[] = [];
  const first = requests.run('/a', async current => { await oldGate.promise; if (current()) published.push('old'); });
  await Promise.resolve();
  const second = requests.run('/a', async current => { await newGate.promise; if (current()) published.push('new'); }, true);
  oldGate.resolve();
  await first;
  expect(requests.has('/a')).toBe(true);
  expect(published).toEqual([]);
  newGate.resolve();
  await second;
  expect(published).toEqual(['new']);
});

test('scope changes reject old completions, and failures leave a retryable slot', async () => {
  const requests = new DirectoryRequests();
  const gate = deferred();
  let published = false;
  const first = requests.run('/a', async current => { await gate.promise; published = current(); });
  await Promise.resolve();
  requests.clear();
  gate.resolve();
  await first;
  expect(published).toBe(false);
  await expect(requests.run('/a', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  expect(requests.has('/a')).toBe(false);
  await requests.run('/a', async current => { published = current(); });
  expect(published).toBe(true);
});
