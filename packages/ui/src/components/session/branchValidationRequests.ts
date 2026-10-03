export const createBranchValidationRequests = () => {
  let currentScope = '';
  const inFlight = new Map<string, symbol>();

  return {
    setScope(scope: string) {
      if (scope === currentScope) return;
      currentScope = scope;
      inFlight.clear();
    },
    begin(scope: string, branch: string): symbol | null {
      if (scope !== currentScope || inFlight.has(branch)) return null;
      const token = Symbol(branch);
      inFlight.set(branch, token);
      return token;
    },
    isCurrent(scope: string, branch: string, token: symbol): boolean {
      return scope === currentScope && inFlight.get(branch) === token;
    },
    finish(scope: string, branch: string, token: symbol) {
      if (scope === currentScope && inFlight.get(branch) === token) inFlight.delete(branch);
    },
  };
};
