import { verifyGitHubSignature } from './verify-hmac.js';
import { dispatchWebhookEvent } from './dispatch.js';
import { getDb } from '../db.js';

export function registerWebhookRoutes(app) {
  app.post('/webhooks/github', async (req, res) => {
    try {
      const signature = req.headers['x-hub-signature-256'];
      const eventName = req.headers['x-github-event'];
      const deliveryId = req.headers['x-github-delivery'];

      if (!signature || !eventName || !req.rawBody) {
        return res.status(400).send('Missing signature, event name, or raw body');
      }

      // Try to find a matching workspace based on installation ID if present
      const installationId = req.body?.installation?.id;
      if (!installationId) {
        // App webhooks must have an installation ID. We reject if not.
        return res.status(400).send('Missing installation ID');
      }

      const db = await getDb();
      const workspace = db.prepare('SELECT id, settings_json FROM workspaces WHERE github_installation_id = ?').get(installationId);

      if (!workspace) {
        return res.status(404).send('Workspace not found for this installation');
      }

      let secret = null;
      try {
        const settings = JSON.parse(workspace.settings_json || '{}');
        secret = settings.webhook_secret;
      } catch (e) {
        // ignore
      }

      if (!secret) {
        // If we don't have a secret configured for this workspace, we can't verify.
        // For development/testing, you might want to allow this, but production must reject.
        return res.status(403).send('Webhook secret not configured');
      }

      if (!verifyGitHubSignature(req.rawBody, signature, secret)) {
        return res.status(401).send('Signature verification failed');
      }

      // Valid signature. Acknowledge GitHub immediately.
      res.status(202).send('Accepted');

      // Dispatch event to queue/handlers asynchronously
      dispatchWebhookEvent(workspace.id, eventName, req.body, deliveryId).catch((error) => {
        console.error(`Error processing webhook ${deliveryId} (${eventName}):`, error);
      });

    } catch (error) {
      console.error('Webhook receiver error:', error);
      if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
      }
    }
  });
}
