import express from 'express';

/**
 * `PUT /api/config/device-settings`: a window reports its device settings
 * (`store.js`), behind the same UI auth as `/api/config/settings`. There is no
 * route to read them back: only the agent tool reads the store
 * (`settings.devices`), so one client never sees another's reports.
 */
export const registerDeviceSettingsRoutes = (app, { store }) => {
  app.put('/api/config/device-settings', express.json({ limit: '128kb' }), (req, res) => {
    const result = store.report(req.body);
    if (!result.ok) return res.status(result.status).json({ error: result.error });
    return res.status(204).end();
  });
};
