/**
 * One side of an office document in a change request. These files are
 * compared in the viewer, so they travel whole, the way images do in a diff.
 */
const MAX_DOCUMENT_BYTES = 30 * 1024 * 1024;

export const documentDataUrl = (bytes) => {
  if (bytes.length > MAX_DOCUMENT_BYTES) {
    throw Object.assign(new Error('This file is too large to compare'), { status: 413, statusCode: 413, code: 'file-too-large' });
  }
  return bytes.length > 0 ? `data:application/octet-stream;base64,${bytes.toString('base64')}` : '';
};
