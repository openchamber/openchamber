import fs from 'node:fs';

const PE_MACHINE = { x64: 0x8664, arm64: 0xaa64 };

const readBytes = (descriptor, length, position) => {
  const buffer = Buffer.alloc(length);
  return fs.readSync(descriptor, buffer, 0, length, position) === length ? buffer : null;
};

/** The CPU architecture a Windows executable is built for, from its PE header. */
export const readPeArchitecture = (filePath) => {
  const descriptor = fs.openSync(filePath, 'r');
  try {
    const dosHeader = readBytes(descriptor, 64, 0);
    if (!dosHeader || dosHeader.toString('latin1', 0, 2) !== 'MZ') {
      throw new Error(`Expected a Windows executable: ${filePath}`);
    }
    const peHeader = readBytes(descriptor, 6, dosHeader.readUInt32LE(0x3c));
    if (!peHeader || peHeader.toString('latin1', 0, 4) !== 'PE\0\0') {
      throw new Error(`Windows executable has no PE header: ${filePath}`);
    }
    const machine = peHeader.readUInt16LE(4);
    const architecture = Object.entries(PE_MACHINE).find(([, value]) => value === machine)?.[0];
    if (!architecture) throw new Error(`Unsupported PE machine 0x${machine.toString(16)}: ${filePath}`);
    return architecture;
  } finally {
    fs.closeSync(descriptor);
  }
};
