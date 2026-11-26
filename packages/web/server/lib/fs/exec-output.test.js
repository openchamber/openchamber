import { expect, it } from 'vitest';
import { createExecOutput } from './exec-output.js';

it('keeps the result and byte count unchanged after settlement', () => {
  const output = createExecOutput(4);
  output.stdout(Buffer.from('ok'));
  const result = { stdout: 'ok', stderr: '', capturedBytes: 2 };
  expect(output.finish()).toEqual(result);

  output.stdout(Buffer.from('later'));
  output.stderr(Buffer.from('late diagnostics'));

  expect(output.finish()).toEqual(result);
});
