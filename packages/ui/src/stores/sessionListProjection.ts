export function memoizeSessionListProjection<Inputs extends readonly unknown[], Result>(
  project: (...inputs: Inputs) => Result,
): (...inputs: Inputs) => Result {
  let cached: { inputs: Inputs; result: Result } | undefined;
  return (...inputs) => {
    const previous = cached;
    if (previous && inputs.every((input, index) => Object.is(input, previous.inputs[index]))) {
      return previous.result;
    }
    const result = project(...inputs);
    cached = { inputs, result };
    return result;
  };
}
