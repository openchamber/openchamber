// external: https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy Local Network privacy uses the executable UUID; derive an app-specific stable UUID before signing.
const crypto = require('node:crypto');
const fs = require('node:fs');

const MH_MAGIC_64 = 0xfeedfacf;
const LC_UUID = 0x1b;
const MACH_HEADER_64_SIZE = 32;

const deriveExecutableUuid = (appId) => {
  const bytes = crypto.createHash('sha256').update(`openchamber-executable-uuid:${appId}`).digest().subarray(0, 16);
  // external: https://www.rfc-editor.org/rfc/rfc9562.html#section-5.8 Set UUID version 8 and variant bits for the app-derived identifier.
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return bytes;
};

const findUuidOffset = (binary) => {
  if (binary.length < MACH_HEADER_64_SIZE || binary.readUInt32LE(0) !== MH_MAGIC_64) {
    throw new Error('expected a thin 64-bit little-endian Mach-O executable');
  }
  const commandCount = binary.readUInt32LE(16);
  let offset = MACH_HEADER_64_SIZE;
  for (let index = 0; index < commandCount; index += 1) {
    const command = binary.readUInt32LE(offset);
    const size = binary.readUInt32LE(offset + 4);
    if (command === LC_UUID) return offset + 8;
    offset += size;
  }
  throw new Error('no LC_UUID load command');
};

const setExecutableUuid = (executablePath, appId) => {
  const binary = fs.readFileSync(executablePath);
  let offset;
  try {
    offset = findUuidOffset(binary);
  } catch (error) {
    throw new Error(`Cannot set the executable UUID of ${executablePath}: ${error.message}`);
  }
  deriveExecutableUuid(appId).copy(binary, offset);
  fs.writeFileSync(executablePath, binary);
};

module.exports = { deriveExecutableUuid, setExecutableUuid };
