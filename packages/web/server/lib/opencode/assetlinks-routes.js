export const registerAssetlinksRoute = (app, dependencies) => {
  const { process } = dependencies;

  app.get('/.well-known/assetlinks.json', (_req, res, next) => {
    const sha256Fingerprint = typeof process.env.TWA_SHA256_FINGERPRINT === 'string'
      ? process.env.TWA_SHA256_FINGERPRINT.trim()
      : '';
    const packageName = typeof process.env.TWA_PACKAGE_NAME === 'string'
      ? process.env.TWA_PACKAGE_NAME.trim()
      : '';

	if (!sha256Fingerprint || !packageName) {
		res.status(404).json({ error: 'assetlinks not configured' });
		return;
	}

    const assetlinks = [{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: packageName,
        sha256_cert_fingerprints: [sha256Fingerprint],
      },
    }];

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('application/json');
    res.send(JSON.stringify(assetlinks));
  });
};
