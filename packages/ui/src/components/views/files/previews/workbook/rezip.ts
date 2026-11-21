import { zip, zipSync, type AsyncZippable, type Unzipped } from 'fflate';

// external: https://docs.oasis-open.org/office/v1.2/os/OpenDocument-v1.2-os-part3.html ODF requires the mimetype entry to stay uncompressed.
export const packArchive = async (archive: Unzipped, stored: string[] = []): Promise<Uint8Array<ArrayBuffer>> => {
  const entries: AsyncZippable = Object.fromEntries(Object.entries(archive).map(([path, bytes]) => [
    path,
    stored.includes(path) ? [bytes, { level: 0 }] : bytes,
  ]));
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
