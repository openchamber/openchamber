import 'node:assert';

declare module 'node:assert' {
  function match(value: unknown, regExp: RegExp, message?: string | Error): asserts value is string;
}

declare global {
  interface RegExp {
    exec(value: string | undefined): RegExpExecArray | null;
  }
}
