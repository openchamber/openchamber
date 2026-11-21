import { SpaceError } from '../errors.js';
import type { InspectLabels } from '../labels.js';

export type DockerLabels = InspectLabels<string> & Record<string, string>;

export interface DockerContainerConfig {
  Labels?: DockerLabels | null;
  Env?: string[] | null;
  User?: string;
}

export interface DockerLogConfig {
  Type?: string;
  Config?: Record<string, string> | null;
}

export interface DockerHostConfig {
  ExtraHosts?: string[] | null;
  ReadonlyRootfs?: boolean;
  Privileged?: boolean;
  CapDrop?: string[] | null;
  CapAdd?: string[] | null;
  SecurityOpt?: string[] | null;
  Init?: boolean | null;
  PidsLimit?: number | null;
  Memory?: number;
  MemorySwap?: number;
  ShmSize?: number;
  LogConfig?: DockerLogConfig | null;
  Tmpfs?: Record<string, string> | null;
  Binds?: string[] | null;
  VolumesFrom?: string[] | null;
  PidMode?: string;
  IpcMode?: string;
  UTSMode?: string;
  UsernsMode?: string;
  CgroupnsMode?: string;
  NetworkMode?: string;
  Sysctls?: Record<string, string> | null;
  Runtime?: string;
  Devices?: unknown[] | null;
  PortBindings?: Record<string, unknown[] | null> | null;
}

export interface DockerMount {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
}

export interface DockerEndpoint {
  IPAddress?: string;
  Aliases?: string[] | null;
  DNSNames?: string[] | null;
}

export interface DockerNetworkSettings {
  Networks?: Record<string, DockerEndpoint> | null;
}

export interface DockerContainerState {
  Running?: boolean;
  ExitCode?: number;
}

export interface DockerContainerSettings {
  Config?: DockerContainerConfig | null;
  HostConfig?: DockerHostConfig | null;
  Mounts?: DockerMount[] | null;
  NetworkSettings?: DockerNetworkSettings | null;
}

export interface DockerContainer extends DockerContainerSettings {
  Id: string;
  Name: string;
  State?: DockerContainerState | null;
}

export interface DockerIpamConfig {
  Gateway?: string;
}

export interface DockerNetwork {
  Name: string;
  Labels?: DockerLabels | null;
  Internal?: boolean;
  EnableIPv6?: boolean;
  IPAM?: { Config?: DockerIpamConfig[] | null } | null;
  Options?: Record<string, string> | null;
}

export interface DockerVolume {
  Name: string;
  Labels?: DockerLabels | null;
}

export interface DockerImage {
  Id: string;
  RepoTags?: string[] | null;
}

export interface DockerLabelledEntry {
  Name?: string;
  Labels?: DockerLabels | null;
  Config?: { Labels?: DockerLabels | null } | null;
}

export interface DockerListedEntry extends DockerLabelledEntry {
  State?: DockerContainerState | null;
}

export interface DockerInspectEntries {
  container: DockerContainer;
  network: DockerNetwork;
  volume: DockerVolume;
  image: DockerImage;
}

export type DockerResourceKind = keyof DockerInspectEntries;

export interface DockerServerVersion {
  Version: string;
  Os: string;
  Arch: string;
}

export interface DockerVolumeUsage {
  Name: string;
  Size?: string;
  Links?: string;
}

export interface DockerImageUsage {
  ID: string;
  UniqueSize?: string;
}

export interface DockerDiskUsage {
  Volumes?: DockerVolumeUsage[] | null;
  Images?: DockerImageUsage[] | null;
}

interface DockerJsonDocuments {
  version: { Server?: DockerServerVersion | null };
  'info security options': string[] | null;
  'info name': string;
  'system df': DockerDiskUsage | null;
}

function parseJson(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    throw new SpaceError('docker_output_unreadable', 'Docker printed something that is not JSON');
  }
}

export const parseInspectOutput = <Kind extends DockerResourceKind>(text: string): DockerInspectEntries[Kind][] => parseJson(text);

export const parseDockerJson = <Document extends keyof DockerJsonDocuments>(text: string): DockerJsonDocuments[Document] => parseJson(text);
