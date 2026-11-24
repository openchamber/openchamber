import { describe, expect, test } from 'bun:test';
import { writeTempFiles } from './temp-files';

describe('writeTempFiles', () => {
  test('a name Windows cannot hold is written with those characters replaced, under the name it was given', async () => {
    const written: string[] = [];
    const results = await writeTempFiles('C:\\Temp\\', [{ filename: 'plan<final>?.docx', bytes: new Uint8Array([1]) }], () => {}, async (path) => {
      written.push(path);
      return path;
    });
    expect(written).toHaveLength(1);
    expect(written[0]?.startsWith('C:\\Temp/openchamber/')).toBe(true);
    expect(written[0]?.endsWith('/plan_final__.docx')).toBe(true);
    expect(results).toEqual([{ filename: 'plan<final>?.docx', path: written[0] }]);
  });
});
