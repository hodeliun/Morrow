import type { VaultScan } from '../core/vault/load';
import type { VaultOp, VaultOpResult } from '../core/vault/plan';

export interface VaultChange {
  // a page file, or a folder when dir is set
  path: string;
  // null when the path no longer exists
  text: string | null;
  mtime: number;
  birthtime: number;
  dir?: boolean;
  // set for files other than pages, such as images
  other?: boolean;
  // file size from stat; a missing size means metadata was unavailable or the path was removed
  size?: number;
  // an externally created directory that is physically empty, matching the existing empty-folder page rule
  emptyFolder?: boolean;
}

export interface VaultFileInfo {
  path: string;
  size: number;
  mtime: number;
}

// everything the vault storage needs from the file system, the desktop shell provides it
export interface VaultBridge {
  readonly root: string;
  scan(): Promise<VaultScan>;
  // runs operations in order and stops at the first one that fails, the result has one entry per attempt
  apply(ops: VaultOp[]): Promise<VaultOpResult[]>;
  readText(path: string): Promise<string | null>;
  readBytes(path: string): Promise<ArrayBuffer | null>;
  // creates a new file, never replaces one
  createFile(path: string, data: ArrayBuffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  listFiles(dir: string): Promise<VaultFileInfo[]>;
  onChange(listener: (changes: VaultChange[]) => void): () => void;
  fileUrl(path: string): string | null;
}
