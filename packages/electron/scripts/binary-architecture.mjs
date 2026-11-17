import fs from 'node:fs';
import { readPeArchitecture } from './windows-executable.mjs';

const ELF_MACHINE = { x64: 62, arm64: 183 };
const MACH_O_CPU = { x64: 0x01000007, arm64: 0x0100000c };
const MACH_O_64_MAGIC = 0xfeedfacf;

const readHeader = (filePath, length) => {
  const header = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, 'r');
  try {
    if (fs.readSync(descriptor, header, 0, length, 0) !== length) {
      throw new Error(`Binary header is truncated: ${filePath}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return header;
};

export const readElfArchitecture = (filePath) => {
  const header = readHeader(filePath, 20);
  if (!header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`Expected an ELF binary: ${filePath}`);
  }
  const byteOrder = header[5];
  if (byteOrder !== 1 && byteOrder !== 2) throw new Error(`Unsupported ELF byte order: ${filePath}`);
  const machine = byteOrder === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
  const architecture = Object.entries(ELF_MACHINE).find(([, value]) => value === machine)?.[0];
  if (!architecture) throw new Error(`Unsupported ELF machine ${machine}: ${filePath}`);
  return architecture;
};

export const readMachOArchitecture = (filePath) => {
  const header = readHeader(filePath, 8);
  if (header.readUInt32LE(0) !== MACH_O_64_MAGIC) throw new Error(`Expected a 64-bit Mach-O binary: ${filePath}`);
  const cpu = header.readUInt32LE(4);
  const architecture = Object.entries(MACH_O_CPU).find(([, value]) => value === cpu)?.[0];
  if (!architecture) throw new Error(`Unsupported Mach-O CPU type 0x${cpu.toString(16)}: ${filePath}`);
  return architecture;
};

export const readBinaryArchitecture = (filePath, platform) => {
  if (platform === 'win32') return readPeArchitecture(filePath);
  if (platform === 'darwin') return readMachOArchitecture(filePath);
  return readElfArchitecture(filePath);
};
