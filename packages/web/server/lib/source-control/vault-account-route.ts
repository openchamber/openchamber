// The fork's `POST /auth/vault` handler: adds an account whose token stays in
// a vault; `reference` is an op://vault/item/field reference.
import { hasProperties, isString } from '../shared/guards.js';
import { isVaultReference } from '../environment/vault.js';
import type { RegisteredProvider } from './provider-registry.js';
import type { Request, Response } from '../shared/http-contracts.js';

export const vaultAccountRoute = ({ load, requestInstance, fail }: {
  load: () => Promise<RegisteredProvider>;
  requestInstance: (req: Pick<Request, 'query'>) => string;
  fail: (res: Response, error: Error, impl: RegisteredProvider | undefined) => Response;
}) => async (req: Request, res: Response) => {
  let impl: RegisteredProvider | undefined;
  try {
    impl = await load();
    if (!(impl.auth.addFromVault instanceof Function)) {
      return res.status(501).json({ error: 'This source control provider does not support this operation', code: 'SOURCE_CONTROL_CAPABILITY_UNSUPPORTED' });
    }
    let instance;
    try { instance = requestInstance(req); }
    catch (error) { return res.status(400).json({ error: error instanceof Error ? error.message : undefined }); }
    const reference = hasProperties(req.body) ? req.body.reference : undefined;
    return res.json(await impl.auth.addFromVault({ instance, reference: isString(reference) ? reference : '' }));
  } catch (error) {
    return fail(res, error instanceof Error ? error : new Error(String(error)), impl);
  }
};

/** A vault reference (op://…) given in place of a token adds an account that keeps only the reference; null otherwise. */
export const addFromVaultReference = async (impl: RegisteredProvider, instance: string, token: string) => (
  isVaultReference(token) && impl.auth.addFromVault instanceof Function ? impl.auth.addFromVault({ instance, reference: token }) : null
);
