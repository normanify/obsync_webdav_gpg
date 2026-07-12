import { Plugin, Notice, TFile, TFolder, TAbstractFile } from 'obsidian';
import { CryptoManager } from './crypto';
import { WebDAVSync } from './sync';
import { ObsyncSettings, DEFAULT_SETTINGS, ObsyncSettingTab } from './settings';
import { JournalManager } from './journal';

interface FileSyncEntry {
  remotePath: string;
  etag: string;
  localMtime: number;
  localSha256: string;
}

interface DirSyncEntry {
  remotePath: string;
}

interface SyncManifest {
  version: number;
  lastSyncTime: number;
  segmentCache: Record<string, string>;
  files: Record<string, FileSyncEntry>;
  dirs: Record<string, DirSyncEntry>;
}

const EMPTY_MANIFEST: SyncManifest = {
  version: 2, lastSyncTime: 0, segmentCache: {}, files: {}, dirs: {},
};

const MAX_ENCODED_SEGMENT_LENGTH = 200;
const MAX_FILENAME_CHARS = 100;
const REMOTE_MANIFEST_PATH = '__manifest__.json.enc';

function base64url(data: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < data.length; i++) bin += String.fromCharCode(data[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function uint8ArrayToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function normalizePath(p: string): string {
  try { return p.normalize('NFC'); } catch { return p; }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

interface ElectronShell {
  openPath: (path: string) => Promise<string>;
}

async function getElectronModule(): Promise<{ shell: ElectronShell } | undefined> {
  try {
    return import('electron');
  } catch {
    return undefined;
  }
}

async function openFileWithDefaultApp(fullPath: string): Promise<void> {
  const mod = await getElectronModule();
  void mod?.shell.openPath(fullPath);
}

function sanitizeVaultPath(vaultPath: string): string {
  vaultPath = normalizePath(vaultPath);
  return vaultPath.split('/').map(seg => {
    return seg.replace(/[:\\*?"<>|]/g, '_');
  }).join('/');
}

export default class ObsyncPlugin extends Plugin {
  settings: ObsyncSettings;
  cryptoManager: CryptoManager;
  syncClient: WebDAVSync;
  settingsTab: ObsyncSettingTab;

  private autoSyncTimer: number | null = null;
  private isSyncing = false;
  private pluginDir = '';
  private syncManifest: SyncManifest = EMPTY_MANIFEST;
  private encToPlain: Map<string, string> = new Map();
  private plainToEnc: Map<string, string> = new Map();
  private shaCache: Map<string, { sha256: string; mtime: number; size: number }> = new Map();
  private shaCacheDirty = false;
  private journal = new JournalManager();
  private statusBar: HTMLElement;
  private pushCurrent = 0;
  private pushTotal = 0;
  private _hydrationInProgress = new Map<string, Promise<void>>();
  private _origVaultReadBinary: ((file: TFile) => Promise<ArrayBuffer>) | null = null;
  private _origShellOpenPath: ((path: string) => Promise<string>) | null = null;
  private _handlingFileOpen = new Set<string>();

  async onload(): Promise<void> {
    this.detectPluginDir();
    await this.loadSettings();
    await this.loadManifest();

    this.cryptoManager = new CryptoManager();
    this.syncClient = new WebDAVSync(
      this.settings.webdavUrl,
      this.settings.webdavUsername,
      this.settings.webdavPassword,
      this.settings.allowSelfSignedCerts,
      this.settings.chunkSizeMb,
    );

    await this.loadKeys();

    this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
      if (this.isSyncing) return;
      if (this.isExcluded(file.path)) return;
      if (file instanceof TFolder) {
        this.journal.record('dir_deleted', file.path);
      } else if (file instanceof TFile) {
        this.journal.record('file_deleted', file.path);
      }
    }));

    this.registerEvent(this.app.vault.on('modify', (file: TFile) => {
      if (this.isSyncing) return;
      if (this.isExcluded(file.path)) return;
      this.journal.record('file_updated', file.path);
      this.scheduleAutoSync(file);
    }));

    this.registerEvent(this.app.vault.on('create', (file: TAbstractFile) => {
      if (this.isSyncing) return;
      if (this.isExcluded(file.path)) return;
      if (file instanceof TFile) {
        this.journal.record('file_updated', file.path);
      }
    }));

    this.registerEvent(this.app.vault.on('rename', (file: TAbstractFile, oldPath: string) => {
      if (this.isSyncing) return;
      if (this.isExcluded(file.path) && this.isExcluded(oldPath)) return;
      if (file instanceof TFile) {
        this.journal.record('file_deleted', oldPath);
        this.journal.record('file_updated', file.path);
      } else if (file instanceof TFolder) {
        this.journal.record('dir_deleted', oldPath);
      }
    }));

    this.registerEvent(this.app.workspace.on('file-open', (file) => {
      if (!this.settings.onDemand || !file) return;
      if (file.stat.size !== 0) return;
      const fp = normalizePath(file.path);
      if (this._handlingFileOpen.has(fp)) return;
      if (!this.syncManifest.files[fp]) {
        console.debug('[on-demand] manifest miss:', fp, 'keys:', Object.keys(this.syncManifest.files).slice(0, 3));
        new Notice(`Not in sync manifest: ${file.name}`);
        return;
      }
      this._handlingFileOpen.add(fp);
      new Notice(`Downloading ${file.name}...`);
      void this.ensureOnDemandHydrated(fp).then(() => {
        const leaf = this.app.workspace.getLeaf(false);
        if (!leaf || normalizePath((leaf.view as { file?: { path?: string } } | null)?.file?.path ?? '') !== fp) return;
        const ext = file.extension?.toLowerCase() || '';
        // Files that Obsidian can render natively
        if (['md', 'canvas', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'mp3', 'ogg', 'wav', 'm4a', 'flac', 'mp4', 'webm', 'ogv', 'pdf', 'epub'].includes(ext)) {
          leaf.openFile(this.app.vault.getFileByPath(file.path) || file).catch(e => console.error('[on-demand] openFile failed:', e));
        } else {
          // Open with default system app
          leaf.detach();
          try {
            const shellPath = String(this.app.vault.adapter.getFullPath(file.path));
            void openFileWithDefaultApp(shellPath);
          } catch (e) {
            console.error('[on-demand] openWithDefaultApp failed:', e);
            new Notice('Failed to open file externally');
          }
        }
      }).catch(e => {
        console.error('[on-demand] failed:', e);
        new Notice(`Download failed: ${errorMessage(e)}`);
      });
    }));

    // Right-click menu → "Download" for synced files
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!this.settings.onDemand) return;
      if (!(file instanceof TFile)) return;
      const fp = normalizePath(file.path);
      if (!this.syncManifest.files[fp]) return;
      menu.addItem((item) => {
        item.setTitle('Download on-demand')
          .setIcon('download')
          .onClick(() => {
            new Notice(`Downloading ${file.name}...`);
            void this.ensureOnDemandHydrated(fp).then(() => {
              const ext = file.extension?.toLowerCase() || '';
              if (['md', 'canvas', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'mp3', 'ogg', 'wav', 'm4a', 'flac', 'mp4', 'webm', 'ogv', 'pdf', 'epub'].includes(ext)) {
                const leaf = this.app.workspace.getLeaf(false);
                if (leaf) leaf.openFile(file).catch(e => console.error('[on-demand] openFile failed:', e));
              } else {
                try {
                  void openFileWithDefaultApp(String(this.app.vault.adapter.getFullPath(file.path)));
                } catch { /* ignore */ }
              }
              new Notice(`Downloaded: ${file.name}`);
            }).catch(e => {
              new Notice(`Download failed: ${errorMessage(e)}`);
            });
          });
      });
    }));

    // Override Vault.readBinary to hydrate on-demand files before plugins read them
    this._origVaultReadBinary = this.app.vault.readBinary.bind(this.app.vault);
    this.app.vault.readBinary = this._interceptVaultReadBinary.bind(this);

    // Override Electron shell.openPath to hydrate before opening with default system app
    await this._patchShellOpenPath();

    this.settingsTab = new ObsyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.addCommand({
      id: 'generate-key-pair',
      name: 'Generate Post-Quantum Key Pair',
      callback: () => this.generateKeyPair(),
    });

    this.addCommand({
      id: 'sync-to-webdav',
      name: 'Sync Encrypted to WebDAV',
      callback: () => this.syncToWebDAV(),
    });

    this.addCommand({
      id: 'restore-from-webdav',
      name: 'Restore Encrypted from WebDAV',
      callback: () => this.restoreFromWebDAV(),
    });

    this.addCommand({
      id: 'hydrate-current-file',
      name: 'Download Current File (On-Demand)',
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        if (file) void this.hydrateFile(file.path);
        else new Notice('No active file');
      },
    });

    this.addRibbonIcon('upload-cloud', 'Sync encrypted vault to WebDAV', () => {
      void this.syncToWebDAV();
    });

    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText('');
  }

  onunload(): void {
    if (this.autoSyncTimer !== null) {
      window.clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    if (this._origVaultReadBinary) {
      this.app.vault.readBinary = this._origVaultReadBinary;
      this._origVaultReadBinary = null;
    }
    if (this._origShellOpenPath) {
      void (async () => {
        try {
          const mod = await getElectronModule();
          if (mod?.shell) mod.shell.openPath = this._origShellOpenPath!;
        } catch { /* ignore */ }
      })();
      this._origShellOpenPath = null;
    }
    void this.journal?.save();
  }

  private scheduleAutoSync(file: TFile): void {
    if (!this.settings.autoSyncOnSave) return;
    if (this.isSyncing) return;
    if (this.isExcluded(file.path)) return;
    if (!this.settings.webdavUrl) return;
    if (!this.cryptoManager.isReady()) return;

    if (this.autoSyncTimer !== null) window.clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      void this.syncToWebDAV();
    }, 3000);
  }

  private yieldToUI(): Promise<void> {
    return new Promise(resolve => window.requestAnimationFrame(() => window.setTimeout(resolve, 5)));
  }

  private setStatus(text: string): void {
    if (this.statusBar) this.statusBar.setText(text);
  }

  private log(...args: unknown[]): void {
    if (this.settings.verboseLog) console.log(...args);
  }

  private makeUploadProgressCb(_fileName: string) {
    return (p: { fileName: string; chunk: number; totalChunks: number; speed: string; pct: string }) => {
      const speedPart = p.speed ? ` · ${p.speed}` : '';
      const pctPart = p.pct ? ` ${p.pct}%` : '';
      this.setStatus(`Uploading ${p.fileName}${pctPart} (${p.chunk}/${p.totalChunks}${speedPart} · file ${this.pushCurrent}/${this.pushTotal})`);
    };
  }

  async loadSettings(): Promise<void> {
    const loaded = (await this.loadData()) as Partial<ObsyncSettings> | undefined;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded || {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private detectPluginDir(): void {
    this.pluginDir = `.obsidian/plugins/${this.manifest.id}`;
  }

  private get cacheDir(): string {
    return this.pluginDir || `.obsidian/plugins/${this.manifest.id}`;
  }

  private get syncManifestPath(): string {
    return `${this.cacheDir}/sync-manifest.json`;
  }

  private get shaCachePath(): string {
    return `${this.cacheDir}/obsync-sha-cache.json`;
  }

  private async loadShaCache(): Promise<void> {
    try {
      const raw = await this.app.vault.adapter.read(this.shaCachePath);
      const obj = JSON.parse(raw) as Record<string, { sha256: string; mtime: number; size: number }>;
      this.shaCache = new Map(Object.entries(obj));
    } catch {
      this.shaCache = new Map();
    }
    this.shaCacheDirty = false;
  }

  private async saveShaCache(): Promise<void> {
    if (!this.shaCacheDirty) return;
    try {
      const obj: Record<string, { sha256: string; mtime: number; size: number }> = {};
      for (const [k, v] of this.shaCache) obj[k] = v;
      await this.app.vault.adapter.write(this.shaCachePath, JSON.stringify(obj));
    } catch (e) {
      console.warn('Failed to save SHA cache:', e);
    }
    this.shaCacheDirty = false;
  }

  private async getSha256ForFile(vaultPath: string): Promise<string | null> {
    try {
      const stat = await this.app.vault.adapter.stat(vaultPath);
      if (stat) {
        const cached = this.shaCache.get(vaultPath);
        if (cached && cached.mtime === stat.mtime && cached.size === stat.size) {
          return cached.sha256;
        }
      }
      const file = this.app.vault.getAbstractFileByPath(vaultPath);
      if (!(file instanceof TFile)) return null;
      const data = new Uint8Array(await this.app.vault.readBinary(file));
      const sha256 = await this.computeContentSha256(data);
      if (stat) {
        this.shaCache.set(vaultPath, { sha256, mtime: stat.mtime, size: stat.size });
        this.shaCacheDirty = true;
      }
      return sha256;
    } catch {
      return null;
    }
  }

  private async loadManifest(): Promise<void> {
    try {
      const content = await this.app.vault.adapter.read(this.syncManifestPath);
      this.syncManifest = JSON.parse(content) as SyncManifest;
      if (!this.syncManifest.files) this.syncManifest.files = {};
      if (!this.syncManifest.dirs) this.syncManifest.dirs = {};
      if (!this.syncManifest.segmentCache) this.syncManifest.segmentCache = {};
    } catch {
      this.syncManifest = { ...EMPTY_MANIFEST, segmentCache: {}, files: {}, dirs: {} };
    }
  }

  private async saveManifest(): Promise<void> {
    this.syncManifest.lastSyncTime = Date.now();
    this.syncManifest.segmentCache = {};
    for (const [enc, plain] of this.encToPlain) {
      this.syncManifest.segmentCache[enc] = plain;
    }
    try {
      await this.app.vault.adapter.write(this.syncManifestPath, JSON.stringify(this.syncManifest, null, 2));
    } catch (e) {
      console.warn('Failed to save manifest:', e);
    }
  }

  private buildSegmentMaps(): void {
    this.encToPlain = new Map(Object.entries(this.syncManifest.segmentCache));
    this.plainToEnc = new Map();
    for (const [enc, plain] of this.encToPlain) {
      this.plainToEnc.set(plain, enc);
    }
  }

  private async encryptPathSegment(plain: string): Promise<string> {
    const cached = this.plainToEnc.get(plain);
    if (cached) {
      if (cached.length <= MAX_ENCODED_SEGMENT_LENGTH) return cached;
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(cached));
      const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      const seg = hex.substring(0, 40);
      this.encToPlain.delete(cached);
      this.encToPlain.set(seg, plain);
      this.plainToEnc.set(plain, seg);
      return seg;
    }
    const combined = await this.cryptoManager.encryptPathSegment(plain);
    let seg = base64url(combined);
    if (seg.length > MAX_ENCODED_SEGMENT_LENGTH) {
      const hash = await crypto.subtle.digest('SHA-256', combined);
      const hex = Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
      seg = hex.substring(0, 40);
    }
    this.encToPlain.set(seg, plain);
    this.plainToEnc.set(plain, seg);
    return seg;
  }

  private async decryptPathSegment(enc: string): Promise<string> {
    const cached = this.encToPlain.get(enc);
    if (cached) { console.log(`[decrypt] cache hit: "${enc}" → "${cached}"`); return cached; }
    if (/^[0-9a-f]{40}$/.test(enc)) {
      console.log(`[decrypt] 40-char hash not in cache: "${enc}"`);
      throw new Error(`Cannot decrypt short path segment "${enc}" — segment cache not available. Try re-syncing from a device with the full cache.`);
    }
    console.log(`[decrypt] decrypting segment "${enc}"...`);
    const combined = base64urlDecode(enc);
    try {
      const plain = await this.cryptoManager.decryptPathSegment(combined);
      this.encToPlain.set(enc, plain);
      this.plainToEnc.set(plain, enc);
      console.log(`[decrypt] segment "${enc}" → "${plain}"`);
      return plain;
    } catch (e) {
      console.log(`[decrypt] decryptPathSegment FAILED for "${enc}"`, e, `name=${(e as Error).name} msg=${(e as Error).message} toString=${String(e)}`);
      throw e;
    }
  }

  private async vaultPathToRemote(vaultPath: string): Promise<string> {
    const segments = vaultPath.split('/');
    const encSegments: string[] = [];
    for (const seg of segments) {
      encSegments.push(await this.encryptPathSegment(seg));
    }
    return encSegments.join('/') + '.enc';
  }

  private async remotePathToVault(remotePath: string): Promise<string | null> {
    if (!remotePath.endsWith('.enc')) { console.log(`[decrypt] skip: "${remotePath}" does not end with .enc`); return null; }
    const pathNoExt = remotePath.slice(0, -4);
    const segments = pathNoExt.split('/');
    const plainSegments: string[] = [];
    for (const seg of segments) {
      try {
        plainSegments.push(await this.decryptPathSegment(seg));
      } catch {
        return null;
      }
    }
    return plainSegments.join('/');
  }

  private async vaultDirToRemote(vaultDir: string): Promise<string> {
    const segments = vaultDir.split('/').filter(s => s.length > 0);
    const encSegments: string[] = [];
    for (const seg of segments) {
      encSegments.push(await this.encryptPathSegment(seg));
    }
    return encSegments.join('/');
  }

  private async remoteDirToVault(remoteDir: string): Promise<string | null> {
    const segments = remoteDir.split('/').filter(s => s.length > 0);
    const plainSegments: string[] = [];
    for (const seg of segments) {
      try {
        plainSegments.push(await this.decryptPathSegment(seg));
      } catch {
        return null;
      }
    }
    return plainSegments.join('/');
  }

  async loadKeys(): Promise<boolean> {
    let ok = false;
    if (this.settings.publicKey) {
      try {
        await this.cryptoManager.loadPublicKey(this.settings.publicKey);
        ok = true;
      } catch (e) { console.error('Failed to load public key:', e); }
    }
    if (this.settings.secretKey) {
      try {
        await this.cryptoManager.loadSecretKey(this.settings.secretKey);
      } catch (e) { console.error('Failed to load secret key:', e); }
    }
    return ok;
  }

  async generateKeyPair(): Promise<void> {
    try {
      const { publicKey, secretKey } = await this.cryptoManager.generateKeyPair();
      this.settings.publicKey = publicKey;
      this.settings.secretKey = secretKey;
      await this.saveSettings();
      await this.loadKeys();
      new Notice('ML-KEM-768 key pair generated successfully');
    } catch (e) {
      console.error('Key generation error:', e);
      new Notice('Failed to generate keys: ' + errorMessage(e));
    }
  }

  private getExcludedPrefixes(): string[] {
    const configDir = this.app.vault.configDir;
    return this.settings.excludePaths
      .replace(/<configDir>/g, configDir)
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0);
  }

  private isExcluded(path: string): boolean {
    return this.getExcludedPrefixes().some(prefix => path.startsWith(prefix));
  }

  private conflictFileName(vaultPath: string): string {
    const now = new Date();
    const date = now.toISOString().slice(0, 10);
    const dotIdx = vaultPath.lastIndexOf('.');
    if (dotIdx > 0) {
      return `${vaultPath.substring(0, dotIdx)}.conflicted.${date}${vaultPath.substring(dotIdx)}`;
    }
    return `${vaultPath}.conflicted.${date}`;
  }

  private async computeContentSha256(data: Uint8Array): Promise<string> {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = new Uint8Array(hashBuffer);
    return Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  private async writeFileToVault(vaultPath: string, data: Uint8Array): Promise<void> {
    vaultPath = sanitizeVaultPath(vaultPath);
    const folder = vaultPath.contains('/') ? vaultPath.substring(0, vaultPath.lastIndexOf('/')) : '';
    if (folder) {
      const exists = await this.app.vault.adapter.exists(folder);
      if (!exists) await this.app.vault.createFolder(folder);
    }
    const existing = this.app.vault.getAbstractFileByPath(vaultPath);
    if (existing instanceof TFile) {
      await this.app.vault.modifyBinary(existing, uint8ArrayToArrayBuffer(data));
    } else {
      await this.app.vault.createBinary(vaultPath, uint8ArrayToArrayBuffer(data));
    }
  }

  private async cacheShaForFile(vaultPath: string, sha256: string): Promise<void> {
    try {
      const stat = await this.app.vault.adapter.stat(vaultPath);
      if (stat) {
        this.shaCache.set(vaultPath, { sha256, mtime: stat.mtime, size: stat.size });
        this.shaCacheDirty = true;
      }
    } catch { /* stat failed, skip sha cache */ }
  }

  private async ensureOnDemandHydrated(path: string): Promise<void> {
    const existing = this._hydrationInProgress.get(path);
    if (existing) { await existing; return; }
    const promise = this.hydrateFile(path);
    this._hydrationInProgress.set(path, promise);
    try {
      await promise;
    } finally {
      this._hydrationInProgress.delete(path);
    }
  }

  private async _patchShellOpenPath(): Promise<void> {
    try {
      const mod = await getElectronModule();
      if (!mod?.shell?.openPath) return;
      this._origShellOpenPath = mod.shell.openPath.bind(mod.shell);
      mod.shell.openPath = async (filePath: string): Promise<string> => {
        if (this.settings.onDemand) {
          const vaultBase = String(this.app.vault.adapter.getFullPath('/'));
          const relPath = filePath.startsWith(vaultBase)
            ? filePath.slice(vaultBase.length).replace(/^\//, '')
            : null;
            if (relPath) {
              const file = this.app.vault.getFileByPath(relPath);
              if (file && file.stat.size === 0 && this.syncManifest.files[normalizePath(file.path)]) {
                await this.ensureOnDemandHydrated(normalizePath(file.path));
            }
          }
        }
        return (this._origShellOpenPath as (path: string) => Promise<string>)(filePath);
      };
    } catch { /* shell.openPath not available */ }
  }

  private async _interceptVaultReadBinary(file: TFile): Promise<ArrayBuffer> {
    if (this.settings.onDemand && !this.isSyncing && file.stat.size === 0) {
      const fp = normalizePath(file.path);
      const entry = this.syncManifest.files[fp];
      if (entry) {
        try {
          await this.ensureOnDemandHydrated(fp);
        } catch (e) {
          console.error('[on-demand] hydrate failed during readBinary, falling back to original:', e);
        }
      }
    }
    return (this._origVaultReadBinary as (file: TFile) => Promise<ArrayBuffer>)(file);
  }

  async hydrateFile(vaultPath: string): Promise<void> {
    const syncEntry = this.syncManifest.files[normalizePath(vaultPath)];
    if (!syncEntry) { new Notice('File not found in sync manifest'); return; }
    try {
      this.setStatus(`Downloading ${vaultPath.split('/').pop()}...`);
      const { data: encData, etag } = await this.syncClient.downloadFile(syncEntry.remotePath);
      const decrypted = await this.cryptoManager.decryptBytes(encData);
      await this.writeFileToVault(vaultPath, decrypted);
      const sha256 = await this.computeContentSha256(decrypted);
      await this.cacheShaForFile(vaultPath, sha256);
      const mtime = (await this.app.vault.adapter.stat(vaultPath))?.mtime || Date.now();
      syncEntry.localSha256 = sha256;
      syncEntry.localMtime = mtime;
      if (etag) syncEntry.etag = etag;
      await this.saveManifest();
    } catch (e) {
      console.error('[on-demand] hydrateFile error:', e);
      new Notice(`Failed to download ${vaultPath}: ${errorMessage(e)}`);
    }
  }

  private async ensureLocalFilenames(): Promise<void> {
    const allFiles = this.app.vault.getFiles();
    const usedNames = new Set(allFiles.map(f => f.path));
    for (const file of allFiles) {
      if (this.isExcluded(file.path)) continue;
      if (file.name.length <= MAX_FILENAME_CHARS) continue;
      const extIdx = file.name.lastIndexOf('.');
      const ext = extIdx >= 0 ? file.name.substring(extIdx) : '';
      const base = extIdx >= 0 ? file.name.substring(0, extIdx) : file.name;
      const maxBase = MAX_FILENAME_CHARS - ext.length;
      let truncated = base.substring(0, Math.max(maxBase, 10));
      let newName = truncated + ext;
      if (newName === file.name) continue;
      let suffix = 1;
      let newPath = file.parent ? `${file.parent.path}/${newName}` : newName;
      while (usedNames.has(newPath)) {
        const tag = `_${suffix}`;
        truncated = base.substring(0, Math.max(maxBase - tag.length, 10));
        newName = truncated + tag + ext;
        newPath = file.parent ? `${file.parent.path}/${newName}` : newName;
        suffix++;
      }
      usedNames.add(newPath);
      try {
        await this.app.vault.rename(file, newPath);
        new Notice(`Renamed "${file.name}" → "${newName}"`);
      } catch (e) {
        console.error(`Failed to rename ${file.path}:`, e);
      }
    }
  }

  private async uploadManifestToRemote(): Promise<void> {
    try {
      this.syncManifest.lastSyncTime = Date.now();
      this.syncManifest.segmentCache = {};
      for (const [enc, plain] of this.encToPlain) {
        this.syncManifest.segmentCache[enc] = plain;
      }
      const json = JSON.stringify(this.syncManifest);
      const enc = await this.cryptoManager.encryptBytes(new TextEncoder().encode(json));
      await this.syncClient.uploadFile(REMOTE_MANIFEST_PATH, enc);
    } catch (e) {
      console.warn('Failed to upload manifest to remote:', e);
    }
  }

  private async downloadManifestFromRemote(): Promise<SyncManifest | null> {
    try {
      const { data: enc } = await this.syncClient.downloadFile(REMOTE_MANIFEST_PATH);
      const dec = await this.cryptoManager.decryptBytes(enc);
      const json = new TextDecoder().decode(dec);
      const m = JSON.parse(json) as SyncManifest;
      if (!m.segmentCache) m.segmentCache = {};
      return m;
    } catch (e) {
      console.warn('Failed to download manifest from remote:', e);
      return null;
    }
  }

  async syncToWebDAV(): Promise<void> {
    if (this.isSyncing) return;
    if (!this.cryptoManager.isReady()) {
      new Notice('Please generate or import post-quantum keys first');
      return;
    }
    this.isSyncing = true;
    this.setStatus('Syncing...');
    try {
      this.syncClient.updateConfig(
        this.settings.webdavUrl,
        this.settings.webdavUsername,
        this.settings.webdavPassword,
        this.settings.allowSelfSignedCerts,
        this.settings.chunkSizeMb,
      );

      await this.syncClient.testConnection();

      this.setStatus('Checking filenames...');
      await this.ensureLocalFilenames();

      await this.loadManifest();
      await this.loadShaCache();
      this.buildSegmentMaps();
      await this.journal.save();
      await this.journal.load(this.app.vault.adapter, `${this.cacheDir}/obsync-journal.json`);
      await this.syncClient.ensureDirectory('');

      this.setStatus('Scanning remote...');
      const remoteFiles = new Map<string, string>();
      const remoteDirs = new Set<string>();
      try {
        const tree = await this.syncClient.listTree('');
        for (const entry of tree) {
          if (entry.isCollection) {
            remoteDirs.add(entry.href);
          } else {
            remoteFiles.set(entry.href, entry.etag);
          }
        }
      } catch (e) {
        console.warn('Failed to list remote tree:', e);
      }

      const remotePathToVault = new Map<string, string>();
      for (const [vp, entry] of Object.entries(this.syncManifest.files)) {
        remotePathToVault.set(entry.remotePath, vp);
      }

      let pulled = 0, localDel = 0, pushed = 0, remoteDel = 0, conflicts = 0;

      /* ── PROCESS JOURNAL (Local changes → Remote) ── */
      this.setStatus('Processing journal...');
      const journalEntries = this.journal.getPending();
      const journalCompleted = new Set<string>();
      const journalDeletedDirs = this.journal.getDeletedDirs();
      const journalDeletedFiles = this.journal.getDeletedFiles();

      const uploadEntries = journalEntries.filter(e => e.type === 'file_updated' && this.app.vault.getAbstractFileByPath(e.vaultPath) instanceof TFile);
      this.pushTotal += uploadEntries.length;
      this.pushCurrent = 0;

      for (const entry of journalEntries) {
        this.setStatus(`Processing journal: ${entry.vaultPath.split('/').pop()}`);
        if (entry.type === 'file_deleted') {
          this.log(`[journal] file_deleted ${entry.vaultPath}`);
          const syncEntry = this.syncManifest.files[entry.vaultPath];
          if (syncEntry) {
            try {
              const deleted = await this.syncClient.deleteFile(syncEntry.remotePath, syncEntry.etag);
              if (!deleted) {
                const { data: remoteEnc } = await this.syncClient.downloadFile(syncEntry.remotePath);
                const remoteDec = await this.cryptoManager.decryptBytes(remoteEnc);
                const cp = this.conflictFileName(entry.vaultPath);
                await this.writeFileToVault(cp, remoteDec);
                new Notice(`Conflict: remote ${entry.vaultPath} saved as ${cp}`);
                conflicts++;
                await this.syncClient.deleteFile(syncEntry.remotePath);
              }
              remoteDel++;
              delete this.syncManifest.files[entry.vaultPath];
            } catch (e) {
              console.error(`Failed to delete remote ${entry.vaultPath}:`, e);
              continue;
            }
          }
          journalCompleted.add(entry.id);
          await this.yieldToUI();

        } else if (entry.type === 'dir_deleted') {
          this.log(`[journal] dir_deleted ${entry.vaultPath}`);
          try {
            const remotePath = await this.vaultDirToRemote(entry.vaultPath);
            await this.syncClient.deleteFile(remotePath);
            remoteDel++;
          } catch (e) {
            console.error(`Failed to delete remote dir ${entry.vaultPath}:`, e);
            continue;
          }
          delete this.syncManifest.dirs[entry.vaultPath];
          for (const vp of Object.keys(this.syncManifest.files)) {
            if (vp.startsWith(entry.vaultPath + '/')) delete this.syncManifest.files[vp];
          }
          for (const vd of Object.keys(this.syncManifest.dirs)) {
            if (vd.startsWith(entry.vaultPath + '/')) delete this.syncManifest.dirs[vd];
          }
          journalCompleted.add(entry.id);
          await this.yieldToUI();

        } else if (entry.type === 'file_updated') {
          this.log(`[journal] file_updated ${entry.vaultPath}`);
          const localFile = this.app.vault.getAbstractFileByPath(entry.vaultPath);
          if (!(localFile instanceof TFile)) { journalCompleted.add(entry.id); continue; }
          try {
            const content = new Uint8Array(await this.app.vault.readBinary(localFile));
            await this.yieldToUI();
            const contentSha = await this.computeContentSha256(content);
            await this.cacheShaForFile(entry.vaultPath, contentSha);
            const syncEntry = this.syncManifest.files[entry.vaultPath];

            let remotePath: string;
            if (syncEntry) {
              if (contentSha === syncEntry.localSha256) { journalCompleted.add(entry.id); continue; }
              remotePath = syncEntry.remotePath;
            } else {
              remotePath = await this.vaultPathToRemote(entry.vaultPath);
            }

            const parentDir = remotePath.contains('/') ? remotePath.substring(0, remotePath.lastIndexOf('/')) : '';
            if (parentDir) await this.syncClient.ensureDirectory(parentDir);
            await this.yieldToUI();
            const encrypted = await this.cryptoManager.encryptBytes(content);
            await this.yieldToUI();
            const shortName = entry.vaultPath.split('/').pop() || entry.vaultPath;
            this.pushCurrent++;
            let etag = await this.syncClient.uploadFile(remotePath, encrypted, syncEntry?.etag, this.makeUploadProgressCb(shortName), shortName);

            if (etag === null) {
              const { data: remoteEnc } = await this.syncClient.downloadFile(remotePath);
              await this.yieldToUI();
              const remoteDec = await this.cryptoManager.decryptBytes(remoteEnc);
              await this.yieldToUI();
              const remoteSha = await this.computeContentSha256(remoteDec);
              if (remoteSha !== contentSha) {
                const cp = this.conflictFileName(entry.vaultPath);
                await this.writeFileToVault(cp, remoteDec);
                await this.yieldToUI();
                new Notice(`Conflict: remote ${entry.vaultPath} saved as ${cp}`);
                conflicts++;
              }
              etag = await this.syncClient.uploadFile(remotePath, encrypted, undefined, this.makeUploadProgressCb(shortName), shortName);
            }

            this.syncManifest.files[entry.vaultPath] = {
              remotePath, etag: etag || syncEntry?.etag || '',
              localMtime: localFile.stat.mtime, localSha256: contentSha,
            };
            if (etag !== null) pushed++;
          } catch (e) {
            console.error(`Failed to push ${entry.vaultPath}:`, e);
            continue;
          }
          journalCompleted.add(entry.id);
          await this.yieldToUI();
        }
      }

      /* Re-PROPFIND after journal modified remote state */
      this.setStatus('Pulling changes...');
      remoteFiles.clear();
      remoteDirs.clear();
      try {
        const tree = await this.syncClient.listTree('');
        for (const entry of tree) {
          if (entry.isCollection) {
            remoteDirs.add(entry.href);
          } else {
            remoteFiles.set(entry.href, entry.etag);
          }
        }
      } catch (e) {
        console.warn('Failed to re-list remote tree:', e);
      }

      remotePathToVault.clear();
      for (const [vp, entry] of Object.entries(this.syncManifest.files)) {
        remotePathToVault.set(entry.remotePath, vp);
      }

      console.log(`[sync] fingerprint=${this.cryptoManager.getFingerprint()}`);

      // Crypto self-test: verify path segment encrypt/decrypt round-trips
      try {
        const testPath = '__crypto_test__';
        const encTest = await this.encryptPathSegment(testPath);
        const decTest = await this.decryptPathSegment(encTest);
        if (decTest === testPath) {
          console.log(`[sync] crypto self-test OK: "${encTest}" → "${decTest}"`);
        } else {
          console.warn(`[sync] crypto self-test MISMATCH: "${testPath}" → "${encTest}" → "${decTest}"`);
        }
      } catch (e) {
        console.error(`[sync] crypto self-test FAILED:`, e);
      }

      // Delete corrupted remote manifest (encrypted with wrong public key from previous buggy state)
      try {
        await this.syncClient.deleteFile(REMOTE_MANIFEST_PATH);
        console.log('[sync] Deleted corrupted remote manifest');
      } catch { /* file may not exist */ }

      /* Download remote manifest for SHA-based download skip and segment cache */
      const remoteShaByVaultPath = new Map<string, string>();
      try {
        const rm = await this.downloadManifestFromRemote();
        if (rm) {
          for (const [vp, e] of Object.entries(rm.files || {})) {
            if (e.localSha256) remoteShaByVaultPath.set(vp, e.localSha256);
          }
          if (rm.segmentCache) {
            for (const [enc, plain] of Object.entries(rm.segmentCache)) {
              if (!this.syncManifest.segmentCache[enc]) {
                this.syncManifest.segmentCache[enc] = plain;
              }
            }
            this.buildSegmentMaps();
          }
        }
      } catch (e) {
        console.warn('Failed to load remote manifest for SHA comparison:', e);
      }

      /* ── PULL (Remote → Local) ── */
      console.log(`[sync] PULL phase: ${remoteFiles.size} remote files, ${remoteDirs.size} remote dirs`);
      for (const [remotePath, remoteEtag] of remoteFiles) {
        console.log(`[sync] PULL candidate: "${remotePath}" (ends with .enc: ${remotePath.endsWith('.enc')})`);
        let vaultPath = remotePathToVault.get(remotePath);
        let wasNewPath = false;

        if (!vaultPath) {
          vaultPath = await this.remotePathToVault(remotePath);
          if (!vaultPath) { console.log(`[sync] PULL skip: remotePathToVault returned null for "${remotePath}"`); continue; }
          wasNewPath = true;
        }
        console.log(`[sync] PULL decrypt OK: "${remotePath}" → "${vaultPath}"`);
        this.log(`[pull] ${vaultPath}`);

        if (this.isExcluded(vaultPath)) continue;

        const syncEntry = this.syncManifest.files[vaultPath];
        if (!wasNewPath && syncEntry && syncEntry.etag === remoteEtag) {
          // When on-demand is off, still download if local file is a 0‑byte placeholder
          if (this.settings.onDemand) continue;
          const localFile = this.app.vault.getAbstractFileByPath(vaultPath);
          if (!(localFile instanceof TFile) || localFile.stat.size !== 0) continue;
        }

        const shortName = vaultPath.split('/').pop();
        this.setStatus(`Pulling: ${shortName}`);
        await this.yieldToUI();

        /* Check if local file matches remote manifest SHA — skip download entirely */
        if (wasNewPath) {
          const localFile = this.app.vault.getAbstractFileByPath(vaultPath);
          const expectedSha = remoteShaByVaultPath.get(vaultPath);
          if (expectedSha && localFile instanceof TFile && (localFile.stat.size || 0) < 50 * 1024 * 1024) {
            const localSha = await this.getSha256ForFile(vaultPath);
            if (localSha === expectedSha) {
              this.log(`[pull] skip download ${vaultPath} — SHA matches remote manifest`);
              const mtime = (await this.app.vault.adapter.stat(vaultPath))?.mtime || Date.now();
              this.syncManifest.files[vaultPath] = { remotePath, etag: remoteEtag, localMtime: mtime, localSha256: localSha };
              continue;
            }
          }
        }

        this.log(`[pull] downloading ${vaultPath} — wasNewPath=${wasNewPath} hasEntry=${!!syncEntry}${syncEntry ? ` etagMatch=${syncEntry.etag === remoteEtag} (local=${syncEntry.etag}, remote=${remoteEtag})` : ''}`);

        if (this.settings.onDemand) {
          const safePath = sanitizeVaultPath(vaultPath);
          await this.writeFileToVault(vaultPath, new Uint8Array(0));
          this.syncManifest.files[safePath] = { remotePath, etag: remoteEtag, localMtime: Date.now(), localSha256: '' };
          this.log(`[pull] on-demand placeholder ${safePath}`);
          continue;
        }

        try {
          const { data: encData, etag: newEtagSrc } = await this.syncClient.downloadFile(
            remotePath,
            (p) => this.setStatus(`Pulling: ${shortName} (${p.pct}% · ${p.speed} · chunk ${p.chunk}/${p.totalChunks})`)
          );
          const newEtag = newEtagSrc;
          await this.yieldToUI();
          const decrypted = await this.cryptoManager.decryptBytes(encData);
          await this.yieldToUI();
          const remoteSha = await this.computeContentSha256(decrypted);
          const localFile = this.app.vault.getAbstractFileByPath(vaultPath);

          if (localFile instanceof TFile && syncEntry) {
            const currentContent = new Uint8Array(await this.app.vault.readBinary(localFile));
            const currentSha = await this.computeContentSha256(currentContent);
            await this.cacheShaForFile(vaultPath, currentSha);

            if (currentSha === remoteSha) {
              // Content identical, skip write, just update manifest etag
              this.log(`[pull] skip write ${vaultPath} — content unchanged`);
              const mtime = (await this.app.vault.adapter.stat(vaultPath))?.mtime || Date.now();
              this.syncManifest.files[vaultPath] = { remotePath, etag: newEtag || '', localMtime: mtime, localSha256: remoteSha };
            } else if (currentSha === syncEntry.localSha256) {
              await this.writeFileToVault(vaultPath, decrypted);
              await this.yieldToUI();
              const mtime = (await this.app.vault.adapter.stat(vaultPath))?.mtime || Date.now();
              this.syncManifest.files[vaultPath] = { remotePath, etag: newEtag || '', localMtime: mtime, localSha256: remoteSha };
              pulled++;
            } else if (!syncEntry.localSha256 && localFile.stat.size === 0) {
              // 0‑byte placeholder from on‑demand mode → overwrite directly
              await this.writeFileToVault(vaultPath, decrypted);
              await this.yieldToUI();
              const mtime = (await this.app.vault.adapter.stat(vaultPath))?.mtime || Date.now();
              this.syncManifest.files[vaultPath] = { remotePath, etag: newEtag || '', localMtime: mtime, localSha256: remoteSha };
              pulled++;
            } else {
              const conflictPath = this.conflictFileName(vaultPath);
              await this.writeFileToVault(conflictPath, decrypted);
              await this.yieldToUI();
              new Notice(`Conflict: remote ${vaultPath} saved as ${conflictPath}`);
              conflicts++;
            }
          } else if (localFile instanceof TFile) {
            const currentContent = new Uint8Array(await this.app.vault.readBinary(localFile));
            const currentSha = await this.computeContentSha256(currentContent);
            await this.cacheShaForFile(vaultPath, currentSha);
            if (currentSha !== remoteSha) {
              await this.writeFileToVault(vaultPath, decrypted);
              await this.yieldToUI();
              pulled++;
            } else {
              this.log(`[pull] skip write ${vaultPath} — content unchanged`);
            }
            const mtime = (await this.app.vault.adapter.stat(vaultPath))?.mtime || Date.now();
            this.syncManifest.files[vaultPath] = { remotePath, etag: newEtag || '', localMtime: mtime, localSha256: remoteSha };
          } else {
            // New file, doesn't exist locally
            await this.writeFileToVault(vaultPath, decrypted);
            await this.yieldToUI();
            const mtime = (await this.app.vault.adapter.stat(vaultPath))?.mtime || Date.now();
            this.syncManifest.files[vaultPath] = { remotePath, etag: newEtag || '', localMtime: mtime, localSha256: remoteSha };
            pulled++;
          }
        } catch (e) {
          console.error(`Failed to pull ${remotePath}:`, e);
        }
        await this.yieldToUI();
      }

      /* Remote deletion → local */
      for (const [vaultPath, syncEntry] of Object.entries(this.syncManifest.files)) {
        if (!remoteFiles.has(syncEntry.remotePath)) {
          const localFile = this.app.vault.getAbstractFileByPath(vaultPath);
          if (localFile instanceof TFile) {
            const currentContent = new Uint8Array(await this.app.vault.readBinary(localFile));
            const currentSha = await this.computeContentSha256(currentContent);
            await this.cacheShaForFile(vaultPath, currentSha);
            if (currentSha === syncEntry.localSha256) {
              try {
                await this.app.fileManager.trashFile(localFile);
                localDel++;
              } catch (e) {
                console.error(`Failed to delete local ${vaultPath}:`, e);
              }
            }
          }
          delete this.syncManifest.files[vaultPath];
        }
      }

      /* Remote directory deletion → local */
      for (const [vaultDir, syncEntry] of Object.entries(this.syncManifest.dirs)) {
        if (!remoteDirs.has(syncEntry.remotePath)) {
          const localDir = this.app.vault.getAbstractFileByPath(vaultDir);
          if (localDir instanceof TFolder) {
            try { await this.app.fileManager.trashFile(localDir); localDel++; }
            catch (e) { console.error(`Failed to delete local dir ${vaultDir}:`, e); }
          }
          delete this.syncManifest.dirs[vaultDir];
        }
      }

      /* PULL directories from remote (skip journal-tracked deletions) */
      for (const remoteDir of remoteDirs) {
        if (remoteDir === '') continue;
        const vaultDir = await this.remoteDirToVault(remoteDir);
        if (!vaultDir || this.isExcluded(vaultDir)) continue;
        if (this.syncManifest.dirs[vaultDir]) continue;
        let hasDeletedAncestor = false;
        let ancestor = vaultDir;
        while (ancestor) {
          if (journalDeletedDirs.has(ancestor)) { hasDeletedAncestor = true; break; }
          const next = ancestor.lastIndexOf('/');
          ancestor = next > 0 ? ancestor.substring(0, next) : '';
        }
        if (hasDeletedAncestor) continue;
        const localDir = this.app.vault.getAbstractFileByPath(vaultDir);
        if (!(localDir instanceof TFolder)) {
          try {
            await this.app.vault.createFolder(vaultDir);
            this.syncManifest.dirs[vaultDir] = { remotePath: remoteDir };
          } catch (e) {
            console.error(`Failed to create local dir ${vaultDir}:`, e);
          }
        }
      }

      /* ── PUSH new files (not tracked, not in journal) ── */
      this.setStatus('Pushing changes...');
      const vaultFiles = this.app.vault.getFiles();
      const localFiles = new Map<string, TFile>();
      for (const f of vaultFiles) {
        if (!this.isExcluded(f.path)) localFiles.set(f.path, f);
      }

      const newFiles: TFile[] = [];
      for (const [vaultPath, file] of localFiles) {
        if (this.syncManifest.files[vaultPath]) continue;
        if (journalDeletedFiles.has(vaultPath)) continue;
        let hasPendingUpdate = false;
        for (const e of journalEntries) {
          if (e.type === 'file_updated' && e.vaultPath === vaultPath) { hasPendingUpdate = true; break; }
        }
        if (hasPendingUpdate) continue;
        newFiles.push(file);
      }
      this.pushTotal += newFiles.length;

      for (const file of newFiles) {
        const vaultPath = file.path;
        this.log(`[push] ${vaultPath}`);
        this.setStatus(`Pushing: ${vaultPath.split('/').pop()}`);
        const content = new Uint8Array(await this.app.vault.readBinary(file));
        await this.yieldToUI();
        const contentSha = await this.computeContentSha256(content);
        await this.cacheShaForFile(vaultPath, contentSha);
        const remotePath = await this.vaultPathToRemote(vaultPath);
        const parentDir = remotePath.contains('/') ? remotePath.substring(0, remotePath.lastIndexOf('/')) : '';
        if (parentDir) await this.syncClient.ensureDirectory(parentDir);
        await this.yieldToUI();

        const encrypted = await this.cryptoManager.encryptBytes(content);
        await this.yieldToUI();
        this.pushCurrent++;
        const shortName = vaultPath.split('/').pop() || vaultPath;
        const etag = await this.syncClient.uploadFile(remotePath, encrypted, undefined, this.makeUploadProgressCb(shortName), shortName);
        this.syncManifest.files[vaultPath] = { remotePath, etag: etag || '', localMtime: file.stat.mtime, localSha256: contentSha };
        pushed++;
        await this.yieldToUI();
      }

      /* ── PUSH directories ── */
      const allItems = this.app.vault.getAllLoadedFiles();
      for (const item of allItems) {
        if (item instanceof TFolder && !item.isRoot() && !this.isExcluded(item.path)) {
          const remotePath = await this.vaultDirToRemote(item.path);
          await this.syncClient.ensureDirectory(remotePath);
          this.syncManifest.dirs[item.path] = { remotePath };
        }
      }

      /* Cleanup: remote dirs never tracked → DELETE */
      const trackedRemotePaths = new Set(Object.values(this.syncManifest.dirs).map(e => e.remotePath));
      for (const remoteDir of remoteDirs) {
        if (remoteDir === '' || trackedRemotePaths.has(remoteDir)) continue;
        try {
          await this.syncClient.deleteFile(remoteDir);
          remoteDel++;
        } catch (e) {
          console.warn(`Failed to delete remote dir ${remoteDir}:`, e);
        }
      }

      this.journal.clearCompleted(journalCompleted);

      /* Post-sync: when on‑demand is off, fill any 0‑byte placeholders left behind */
      if (!this.settings.onDemand) {
        for (const [vp, entry] of Object.entries(this.syncManifest.files)) {
          const f = this.app.vault.getAbstractFileByPath(vp);
          if (!(f instanceof TFile) || f.stat.size !== 0) continue;
          this.log(`[placeholder] filling ${vp}`);
          this.setStatus(`Filling placeholder: ${vp.split('/').pop()}`);
          try {
            const { data: encData } = await this.syncClient.downloadFile(entry.remotePath);
            const decrypted = await this.cryptoManager.decryptBytes(encData);
            await this.writeFileToVault(vp, decrypted);
            const sha256 = await this.computeContentSha256(decrypted);
            await this.cacheShaForFile(vp, sha256);
            const mtime = (await this.app.vault.adapter.stat(vp))?.mtime || Date.now();
            entry.localSha256 = sha256;
            entry.localMtime = mtime;
            pulled++;
          } catch (e) {
            console.error(`Failed to fill placeholder ${vp}:`, e);
          }
          await this.yieldToUI();
        }
      }

      await this.saveManifest();
      await this.saveShaCache();
      await this.uploadManifestToRemote();
      await this.saveSettings();

      const parts: string[] = [];
      if (pulled > 0) parts.push(`${pulled}↓`);
      if (localDel > 0) parts.push(`${localDel} local del`);
      if (pushed > 0) parts.push(`${pushed}↑`);
      if (remoteDel > 0) parts.push(`${remoteDel} remote del`);
      if (conflicts > 0) parts.push(`${conflicts} conflicts`);
      new Notice(parts.length > 0 ? `Sync done: ${parts.join(', ')}` : 'No changes');
      this.setStatus(parts.length > 0 ? `Sync: ${parts.join(' ')}` : 'Sync: up-to-date');
    } catch (e) {
      new Notice('Sync failed: ' + errorMessage(e));
      console.error('Sync failed:', e);
      this.setStatus('Sync failed');
    } finally {
      this.isSyncing = false;
      this.pushTotal = 0;
      this.pushCurrent = 0;
      window.setTimeout(() => { if (!this.isSyncing) this.setStatus(''); }, 8000);
    }
  }

  async restoreFromWebDAV(): Promise<void> {
    if (this.isSyncing) return;
    if (!this.cryptoManager.canDecrypt()) {
      new Notice('Please load the secret key first');
      return;
    }
    this.isSyncing = true;
    try {
      this.syncClient.updateConfig(
        this.settings.webdavUrl,
        this.settings.webdavUsername,
        this.settings.webdavPassword,
        this.settings.allowSelfSignedCerts,
        this.settings.chunkSizeMb,
      );

      new Notice('Restoring...');
      await this.loadManifest();
      const remoteManifest = await this.downloadManifestFromRemote();
      if (remoteManifest && remoteManifest.segmentCache) {
        for (const [enc, plain] of Object.entries(remoteManifest.segmentCache)) {
          if (!this.syncManifest.segmentCache[enc]) {
            this.syncManifest.segmentCache[enc] = plain;
          }
        }
      }
      this.buildSegmentMaps();

      const tree = await this.syncClient.listTree('');
      let restored = 0, failed = 0, skipped = 0, dirsCreated = 0;

      /* First pass: create directories */
      for (const entry of tree) {
        if (!entry.isCollection || entry.href === '') continue;
        const vaultDir = await this.remoteDirToVault(entry.href);
        if (!vaultDir || this.isExcluded(vaultDir)) { skipped++; continue; }
        const existing = this.app.vault.getAbstractFileByPath(vaultDir);
        if (!(existing instanceof TFolder)) {
          try { await this.app.vault.createFolder(vaultDir); dirsCreated++; } catch (e) { console.warn(`Failed to create dir ${vaultDir}:`, e); }
        }
      }

      for (const entry of tree) {
        if (entry.isCollection) continue;

        const vaultPath = await this.remotePathToVault(entry.href);
        if (!vaultPath || this.isExcluded(vaultPath)) { skipped++; continue; }

        try {
          if (this.settings.onDemand) {
            const safePath = sanitizeVaultPath(vaultPath);
            await this.writeFileToVault(vaultPath, new Uint8Array(0));
            this.syncManifest.files[safePath] = { remotePath: entry.href, etag: entry.etag || '', localMtime: Date.now(), localSha256: '' };
            restored++;
            continue;
          }
          const shortName = vaultPath.split('/').pop();
          const { data: encData, etag } = await this.syncClient.downloadFile(
            entry.href,
            (p) => this.setStatus(`Syncing: ${shortName} (${p.pct}% · ${p.speed} · chunk ${p.chunk}/${p.totalChunks})`)
          );
          const decrypted = await this.cryptoManager.decryptBytes(encData);
          const sha256 = await this.computeContentSha256(decrypted);
          await this.writeFileToVault(vaultPath, decrypted);
          await this.cacheShaForFile(vaultPath, sha256);

          const mtime = (await this.app.vault.adapter.stat(vaultPath))?.mtime || Date.now();
          this.syncManifest.files[vaultPath] = { remotePath: entry.href, etag: etag || '', localMtime: mtime, localSha256: sha256 };
          restored++;
        } catch (e) {
          failed++;
          console.error(`Failed to restore ${entry.href}:`, e);
        }
      }

      await this.saveManifest();

      const parts = [`restored ${restored}`, dirsCreated > 0 ? `dirs ${dirsCreated}` : '', skipped > 0 ? `skipped ${skipped}` : '', failed > 0 ? `failed ${failed}` : ''].filter(Boolean);
      new Notice(`Restore done (${parts.join(', ')})`);
    } catch (e) {
      new Notice('Restore failed: ' + errorMessage(e));
      console.error('Restore failed:', e);
    } finally {
      this.isSyncing = false;
    }
  }

  exportConfig(): void {
    const config = { version: 2, exportedAt: new Date().toISOString(), settings: { ...this.settings } };
    const json = JSON.stringify(config, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = activeDocument.createElement('a');
    a.href = url;
    a.download = `obsync-config-${new Date().toISOString().slice(0, 10)}.json`;
    activeDocument.body.appendChild(a);
    a.click();
    activeDocument.body.removeChild(a);
    URL.revokeObjectURL(url);
    new Notice('Config exported');
  }

  importConfig(): void {
    const input = activeDocument.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text) as Record<string, unknown>;
        if (!data.settings || typeof data.settings !== 'object') {
          new Notice('Invalid config file: missing settings object');
          return;
        }
        const merged = { ...DEFAULT_SETTINGS, ...data.settings };
        Object.assign(this.settings, merged);
        await this.saveSettings();
        this.cryptoManager = new CryptoManager();
    await this.loadKeys();

    this.registerEvent(this.app.vault.on('delete', (file: TAbstractFile) => {
      if (this.isSyncing) return;
      if (this.isExcluded(file.path)) return;
      if (file instanceof TFolder) {
        this.journal.record('dir_deleted', file.path);
      } else if (file instanceof TFile) {
        this.journal.record('file_deleted', file.path);
      }
    }));

    this.registerEvent(this.app.vault.on('modify', (file: TFile) => {
      if (this.isSyncing) return;
      if (this.isExcluded(file.path)) return;
      this.journal.record('file_updated', file.path);
      this.scheduleAutoSync(file);
    }));
        this.syncClient.updateConfig(this.settings.webdavUrl, this.settings.webdavUsername, this.settings.webdavPassword, this.settings.allowSelfSignedCerts, this.settings.chunkSizeMb);
        new Notice('Config imported successfully');
        this.settingsTab?.display();
      } catch (e) {
        new Notice('Import failed: ' + errorMessage(e));
      }
    };
    input.click();
  }
}
