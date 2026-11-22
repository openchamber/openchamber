/**
 * `POST /api/openchamber/model-choices` records one manual model or effort
 * choice (`store.js` names the fields; never message text). Answers
 * `{ recorded }`, false while recording is off.
 *
 * `GET /api/openchamber/model-choices?limit=` answers
 * `{ enabled, total, notes, events, suggestions }`.
 *
 * `POST /api/openchamber/model-choices/decision` with `{ id, decision }`
 * (`approved` or `declined`) answers a suggestion; approve writes its
 * settings. 404 when that suggestion is not on offer.
 *
 * `DELETE /api/openchamber/model-choices` removes every event and decision.
 */
import express from 'express';
import { z } from 'zod';

const decisionBodySchema = z.object({
  id: z.string().min(1).max(400),
  decision: z.enum(['approved', 'declined']),
});

const statusOf = (error) => (Number.isInteger(error?.statusCode) ? error.statusCode : 500);

const fail = (res, error, fallback) => res.status(statusOf(error)).json({ error: error?.message || fallback });

// The limit is judged the strict way the git routes judge their numeric
// parameters (#554 class): the value's whole text must be digits, else
// undefined so the service applies its default. z.coerce reinterpreted
// '1e3' as 1000 and '' / '-5' as 0 / -5 (read as no-events) instead of the
// default 50. A plain '0' stays 0: the service's deliberate no-events answer.
const parseLimit = (value) => {
  const text = String(value ?? '');
  return /^\d+$/.test(text) ? Number(text) : undefined;
};

export const registerModelChoiceRoutes = (app, { modelChoiceService }) => {
  app.post('/api/openchamber/model-choices', express.json({ limit: '16kb' }), async (req, res) => {
    try {
      return res.json(await modelChoiceService.record(req.body));
    } catch (error) {
      return fail(res, error, 'Could not record the model choice');
    }
  });

  app.get('/api/openchamber/model-choices', async (req, res) => {
    const limit = parseLimit(req.query.limit);
    try {
      return res.json(await modelChoiceService.summary({ limit }));
    } catch (error) {
      return fail(res, error, 'Could not read the model choices');
    }
  });

  app.post('/api/openchamber/model-choices/decision', express.json({ limit: '4kb' }), async (req, res) => {
    const parsed = decisionBodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'id and decision (approved or declined) are required' });
    try {
      return res.json(await modelChoiceService.decide(parsed.data.id, parsed.data.decision));
    } catch (error) {
      return fail(res, error, 'Could not answer the suggestion');
    }
  });

  app.delete('/api/openchamber/model-choices', async (_req, res) => {
    try {
      await modelChoiceService.clear();
      return res.status(204).end();
    } catch (error) {
      return fail(res, error, 'Could not clear the model choices');
    }
  });
};
