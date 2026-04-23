import crypto from 'crypto';

/**
 * Verify GitHub Webhook HMAC signature.
 * @param {string} payload - Raw string/buffer body of the request
 * @param {string} signatureHeader - The x-hub-signature-256 header
 * @param {string} secret - The configured webhook secret
 * @returns {boolean}
 */
export function verifyGitHubSignature(payload, signatureHeader, secret) {
  if (!signatureHeader || !secret) {
    return false;
  }

  const expectedPrefix = 'sha256=';
  if (!signatureHeader.startsWith(expectedPrefix)) {
    return false;
  }

  const signature = signatureHeader.slice(expectedPrefix.length);
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const digest = hmac.digest('hex');

  // Use timingSafeEqual to prevent timing attacks
  try {
    const signatureBuffer = Buffer.from(signature, 'hex');
    const digestBuffer = Buffer.from(digest, 'hex');

    if (signatureBuffer.length !== digestBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(signatureBuffer, digestBuffer);
  } catch (error) {
    return false;
  }
}
