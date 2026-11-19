import { getTrustRefusal } from './client.js';
import type { Application } from '../shared/http-contracts.js';
import type { GenerationOptions } from './index.js';

type GenerationFields = Partial<Pick<GenerationOptions,
  'prompt' | 'system' | 'maxOutputTokens' | 'model' | 'directory' | 'preferredProviderID' | 'preferredModelID'>>;

export type SmallModelRouteService = Pick<typeof import('./index.js'),
  'describeSmallModel' | 'listAuthenticatedProviders' | 'generateSmallModelText'>;

interface FailureFields {
  message?: unknown;
  statusCode?: unknown;
  code?: unknown;
}

interface FailureResponse {
  error: unknown;
  code?: unknown;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const hasGenerationFields = (value: unknown): value is GenerationFields => Boolean(value);
const hasFailureFields = (value: unknown): value is FailureFields => value !== null && value !== undefined;

export function registerSmallModelRoutes(app: Application, { getSmallModelService }: {
  getSmallModelService: () => Promise<SmallModelRouteService>;
}) {
  app.get('/api/small-model', async (req, res) => {
    try {
      const { describeSmallModel, listAuthenticatedProviders } = await getSmallModelService();
      const directory = isString(req.query.directory) ? req.query.directory : undefined;
      const resolved = await describeSmallModel({
        directory,
        preferredProviderID: isString(req.query.providerID) ? req.query.providerID : undefined,
        preferredModelID: isString(req.query.modelID) ? req.query.modelID : undefined,
      });
      res.json({
        available: Boolean(resolved),
        model: resolved,
        authenticatedProviders: await listAuthenticatedProviders(directory),
      });
    } catch (error) {
      const refusal = getTrustRefusal(error);
      if (refusal) {
        return res.status(403).json({ error: refusal.message, code: refusal.code, directory: refusal.directory });
      }
      console.error('Failed to resolve small model:', error);
      if (!hasFailureFields(error)) {
        throw new TypeError(process.versions.bun
          ? `${error} is not an object (evaluating 'error.message')`
          : `Cannot read properties of ${error} (reading 'message')`);
      }
      res.status(500).json({ error: error.message || 'Failed to resolve small model' });
    }
  });

  app.post('/api/small-model/generate', async (req, res) => {
    try {
      const { generateSmallModelText } = await getSmallModelService();
      const { prompt, system, maxOutputTokens, model, directory, preferredProviderID, preferredModelID } = hasGenerationFields(req.body) ? req.body : {};
      const result = await generateSmallModelText({
        prompt,
        system,
        maxOutputTokens,
        model,
        directory,
        preferredProviderID,
        preferredModelID,
      });
      res.json(result);
    } catch (error) {
      const refusal = getTrustRefusal(error);
      if (refusal) {
        return res.status(403).json({ error: refusal.message, code: refusal.code, directory: refusal.directory });
      }
      const failure = hasFailureFields(error) ? error : undefined;
      const statusCode = Number(failure?.statusCode) || 500;
      if (statusCode >= 500) {
        console.error('Small model generation failed:', error);
      }
      const payload: FailureResponse = {
        error: statusCode === 404 || failure?.code === 'small-model-unavailable' || failure?.code === 'generation-timeout'
          ? (failure?.message || 'No small model is available')
          : 'The selected Small Model could not complete this action. Choose another model in Settings → Sessions → Small Model and try again.',
      };
      if (failure?.code) payload.code = failure.code;
      res.status(statusCode).json(payload);
    }
  });
}
