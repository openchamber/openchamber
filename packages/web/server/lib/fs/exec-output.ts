import { StringDecoder } from 'node:string_decoder';

export const EXEC_JOB_MAX_OUTPUT_BYTES = 1024 * 1024;

interface ExecOutput {
  stdout: string;
  stderr: string;
  capturedBytes: number;
  outputTruncated?: true;
}

export const createExecOutput = (maxBytes: number) => {
  const output: ExecOutput = { stdout: '', stderr: '', capturedBytes: 0 };
  let finished = false;
  const captureStream = (stream: 'stdout' | 'stderr') => {
    const decoder = new StringDecoder('utf8');
    let truncated = false;
    return {
      append(chunk: Buffer) {
        if (finished) return;
        const remaining = maxBytes - output.capturedBytes;
        if (chunk.length > remaining) truncated = true;
        if (remaining === 0) return;
        const prefix = chunk.subarray(0, remaining);
        output.capturedBytes += prefix.length;
        output[stream] += decoder.write(prefix);
      },
      finish() {
        output[stream] = (truncated ? output[stream] : output[stream] + decoder.end()).trim();
        if (truncated) output.outputTruncated = true;
      },
    };
  };
  const stdout = captureStream('stdout');
  const stderr = captureStream('stderr');

  return {
    stdout: stdout.append,
    stderr: stderr.append,
    finish(): ExecOutput {
      if (!finished) {
        stdout.finish();
        stderr.finish();
        finished = true;
      }
      return output;
    },
  };
};
