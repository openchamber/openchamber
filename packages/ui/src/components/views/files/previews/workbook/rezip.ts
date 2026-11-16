import { zip, zipSync, type AsyncZippable, type Unzipped } from 'fflate';

/** Packs the entries back in their order. `stored` entries stay uncompressed, which ODF asks of `mimetype`. */
export const packArchive = async (archive: Unzipped, stored: string[] = []): Promise<Uint8Array<ArrayBuffer>> => {
  const entries: AsyncZippable = Object.fromEntries(Object.entries(archive).map(([path, bytes]) => [
    path,
    stored.includes(path) ? [bytes, { level: 0 }] : bytes,
  ]));
  // Bun's browser-style Blob workers do not reliably run fflate's async path.
  const packed = 'Bun' in globalThis
    ? zipSync(entries)
    : await new Promise<Uint8Array>((resolve, reject) => {
      zip(entries, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
    });
  return new Uint8Array(packed);
};

export const escapeXml = (text: string): string => text
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
