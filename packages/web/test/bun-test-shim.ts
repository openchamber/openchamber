import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  test,
  vi,
} from 'vitest';

const mock = Object.assign(
  <T extends (...args: never[]) => unknown>(implementation?: T) => vi.fn(implementation),
  {
    module: vi.mock,
  },
);
const setSystemTime = (time?: Date | number) => {
  if (time === undefined) {
    vi.useRealTimers();
    return;
  }
  vi.useFakeTimers();
  vi.setSystemTime(time);
};
const spyOn = vi.spyOn;

export {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  setSystemTime,
  spyOn,
  test,
  vi,
};
