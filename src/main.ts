import { Plugin, Notice, TFile, TFolder, TAbstractFile } from 'obsidian';
import { CryptoManager } from './crypto';
import { WebDAVSync, PropfindEntry } from './sync';
import { ObsyncSettings, DEFAULT_SETTINGS, ObsyncSettingTab } from './settings';
import { JournalManager, JournalEntryType } from './journal';

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
  private journal = new JournalManager();
  private statusBar: HTMLElement;

  async onload(): Promise<void> {
    await this.detectPluginDir();
    await this.loadSettings();

    this.cryptoManager = new CryptoManager();
    this.syncClient = new WebDAVSync(
      this.settings.webdavUrl,
      this.settings.webdavUsername,
      this.settings.webdavPassword,
      this.settings.allowSelfSignedCerts,
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

    this.settingsTab = new ObsyncSettingTab(this.app, this);
    this.addSettingTab(this.settingsTab);

    this.addCommand({
      id: 'generate-key-pair',
      name: 'Generate GPG Key Pair',
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

    this.addRibbonIcon('upload-cloud', 'Sync encrypted vault to WebDAV', () => {
      this.syncToWebDAV();
    });

    this.statusBar = this.addStatusBarItem();
    this.statusBar.setText('');
  }

  onunload(): void {
    if (this.autoSyncTimer !== null) {
      clearTimeout(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
    this.journal?.save();
  }

  private scheduleAutoSync(file: TFile): void {
    if (!this.settings.autoSyncOnSave) return;
    if (this.isSyncing) return;
    if (this.isExcluded(file.path)) return;
    if (!this.settings.webdavUrl) return;
    if (!this.cryptoManager.isReady()) return;

    if (this.autoSyncTimer !== null) clearTimeout(this.autoSyncTimer);
    this.autoSyncTimer = window.setTimeout(() => {
      this.autoSyncTimer = null;
      this.syncToWebDAV();
    }, 3000);
  }

  private setStatus(text: string): void {
    if (this.statusBar) this.statusBar.setText(text);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private async detectPluginDir(): Promise<void> {
    const idDir = `.obsidian/plugins/${this.manifest.id}`;
    const altDir = `.obsidian/plugins/${this.manifest.id.replace(/-/g, '_')}`;
    if (idDir !== altDir) {
      try {
        const raw = await this.app.vault.adapter.read(`${altDir}/manifest.json`);
        const m = JSON.parse(raw);
        if (m.id === this.manifest.id) { this.pluginDir = altDir; return; }
      } catch {}
    }
    this.pluginDir = idDir;
  }

  private get cacheDir(): string {
    return this.pluginDir || `.obsidian/plugins/${this.manifest.id}`;
  }

  private get syncManifestPath(): string {
    return `${this.cacheDir}/sync-manifest.json`;
  }

  private async loadManifest(): Promise<void> {
    try {
      const content = await this.app.vault.adapter.read(this.syncManifestPath);
      this.syncManifest = JSON.parse(content);
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
    if (cached) return cached;
    const combined = await this.cryptoManager.encryptPathSegment(plain);
    const seg = base64url(combined);
    this.encToPlain.set(seg, plain);
    this.plainToEnc.set(plain, seg);
    return seg;
  }

  private async decryptPathSegment(enc: string): Promise<string> {
    const cached = this.encToPlain.get(enc);
    if (cached) return cached;
    const combined = base64urlDecode(enc);
    const plain = await this.cryptoManager.decryptPathSegment(combined);
    this.encToPlain.set(enc, plain);
    this.plainToEnc.set(plain, enc);
    return plain;
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
    if (!remotePath.endsWith('.enc')) return null;
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
      try { await this.cryptoManager.loadPublicKey(this.settings.publicKey); ok = true; } catch (e) { console.error('Failed to load public key:', e); }
    }
    if (this.settings.privateKey && this.settings.passphrase) {
      try { await this.cryptoManager.loadPrivateKey(this.settings.privateKey, this.settings.passphrase); ok = true; } catch (e) { console.error('Failed to load private key:', e); }
    }
    return ok;
  }

  async generateKeyPair(): Promise<void> {
    if (!this.settings.passphrase) {
      new Notice('Please set a passphrase in settings first');
      return;
    }
    try {
      const { publicKey, privateKey } = await this.cryptoManager.generateKeyPair(this.settings.passphrase);
      this.settings.publicKey = publicKey;
      this.settings.privateKey = privateKey;
      await this.saveSettings();
      await this.loadKeys();
      new Notice('GPG key pair generated successfully');
    } catch (e) {
      console.error('Key generation error:', e);
      new Notice('Failed to generate keys: ' + e.message);
    }
  }

  private getExcludedPrefixes(): string[] {
    return this.settings.excludePaths.split(',').map(s => s.trim()).filter(s => s.length > 0);
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

  async syncToWebDAV(): Promise<void> {
    if (this.isSyncing) return;
    if (!this.cryptoManager.isReady()) {
      new Notice('Please generate or import GPG keys first');
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
      );

      await this.syncClient.testConnection();

      await this.loadManifest();
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

      for (const entry of journalEntries) {
        if (entry.type === 'file_deleted') {
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

        } else if (entry.type === 'dir_deleted') {
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

        } else if (entry.type === 'file_updated') {
          const localFile = this.app.vault.getAbstractFileByPath(entry.vaultPath);
          if (!(localFile instanceof TFile)) { journalCompleted.add(entry.id); continue; }
          try {
            const content = new Uint8Array(await this.app.vault.readBinary(localFile));
            const contentSha = await this.computeContentSha256(content);
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
            const encrypted = await this.cryptoManager.encryptBytes(content);
            let etag = await this.syncClient.uploadFile(remotePath, encrypted, syncEntry?.etag);

            if (etag === null) {
              const { data: remoteEnc } = await this.syncClient.downloadFile(remotePath);
              const remoteDec = await this.cryptoManager.decryptBytes(remoteEnc);
              const remoteSha = await this.computeContentSha256(remoteDec);
              if (remoteSha !== contentSha) {
                const cp = this.conflictFileName(entry.vaultPath);
                await this.writeFileToVault(cp, remoteDec);
                new Notice(`Conflict: remote ${entry.vaultPath} saved as ${cp}`);
                conflicts++;
              }
              etag = await this.syncClient.uploadFile(remotePath, encrypted);
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

      /* ── PULL (Remote → Local) ── */
      for (const [remotePath, remoteEtag] of remoteFiles) {
        let vaultPath = remotePathToVault.get(remotePath);
        let wasNewPath = false;

        if (!vaultPath) {
          vaultPath = await this.remotePathToVault(remotePath);
          if (!vaultPath) continue;
          wasNewPath = true;
        }

        if (this.isExcluded(vaultPath)) continue;

        const syncEntry = this.syncManifest.files[vaultPath];
        if (!wasNewPath && syncEntry && syncEntry.etag === remoteEtag) continue;

        try {
          const { data: encData, etag: newEtag } = await this.syncClient.downloadFile(remotePath);
          const decrypted = await this.cryptoManager.decryptBytes(encData);
          const remoteSha = await this.computeContentSha256(decrypted);
          const localFile = this.app.vault.getAbstractFileByPath(vaultPath);

          if (localFile instanceof TFile && syncEntry) {
            const currentContent = new Uint8Array(await this.app.vault.readBinary(localFile));
            const currentSha = await this.computeContentSha256(currentContent);

            if (currentSha === syncEntry.localSha256) {
              await this.writeFileToVault(vaultPath, decrypted);
              const mtime = (await this.app.vault.adapter.stat(vaultPath))?.mtime || Date.now();
              this.syncManifest.files[vaultPath] = { remotePath, etag: newEtag || '', localMtime: mtime, localSha256: remoteSha };
              pulled++;
            } else {
              const conflictPath = this.conflictFileName(vaultPath);
              await this.writeFileToVault(conflictPath, decrypted);
              new Notice(`Conflict: remote ${vaultPath} saved as ${conflictPath}`);
              conflicts++;
            }
          } else {
            const mtime = (await this.app.vault.adapter.stat(vaultPath))?.mtime || Date.now();
            await this.writeFileToVault(vaultPath, decrypted);
            this.syncManifest.files[vaultPath] = { remotePath, etag: newEtag || '', localMtime: mtime, localSha256: remoteSha };
            pulled++;
          }
        } catch (e) {
          console.error(`Failed to pull ${remotePath}:`, e);
        }
      }

      /* Remote deletion → local */
      for (const [vaultPath, syncEntry] of Object.entries(this.syncManifest.files)) {
        if (!remoteFiles.has(syncEntry.remotePath)) {
          const localFile = this.app.vault.getAbstractFileByPath(vaultPath);
          if (localFile instanceof TFile) {
            const currentContent = new Uint8Array(await this.app.vault.readBinary(localFile));
            const currentSha = await this.computeContentSha256(currentContent);
            if (currentSha === syncEntry.localSha256) {
              try {
                await this.app.vault.delete(localFile);
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
            try { await this.app.vault.delete(localDir); localDel++; }
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

      for (const [vaultPath, file] of localFiles) {
        if (this.syncManifest.files[vaultPath]) continue;
        if (journalDeletedFiles.has(vaultPath)) continue;
        let hasPendingUpdate = false;
        for (const e of journalEntries) {
          if (e.type === 'file_updated' && e.vaultPath === vaultPath) { hasPendingUpdate = true; break; }
        }
        if (hasPendingUpdate) continue;

        const content = new Uint8Array(await this.app.vault.readBinary(file));
        const contentSha = await this.computeContentSha256(content);
        const remotePath = await this.vaultPathToRemote(vaultPath);
        const parentDir = remotePath.contains('/') ? remotePath.substring(0, remotePath.lastIndexOf('/')) : '';
        if (parentDir) await this.syncClient.ensureDirectory(parentDir);

        const encrypted = await this.cryptoManager.encryptBytes(content);
        const etag = await this.syncClient.uploadFile(remotePath, encrypted);
        this.syncManifest.files[vaultPath] = { remotePath, etag: etag || '', localMtime: file.stat.mtime, localSha256: contentSha };
        pushed++;
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

      await this.saveManifest();
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
      new Notice('Sync failed: ' + e.message);
      console.error('Sync failed:', e);
      this.setStatus('Sync failed');
    } finally {
      this.isSyncing = false;
      setTimeout(() => { if (!this.isSyncing) this.setStatus(''); }, 8000);
    }
  }

  async restoreFromWebDAV(): Promise<void> {
    if (this.isSyncing) return;
    if (!this.cryptoManager.canDecrypt()) {
      new Notice('Please load the private key with passphrase first');
      return;
    }
    this.isSyncing = true;
    try {
      this.syncClient.updateConfig(
        this.settings.webdavUrl,
        this.settings.webdavUsername,
        this.settings.webdavPassword,
        this.settings.allowSelfSignedCerts,
      );

      new Notice('Restoring...');
      await this.loadManifest();
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
          const { data: encData, etag } = await this.syncClient.downloadFile(entry.href);
          const decrypted = await this.cryptoManager.decryptBytes(encData);
          const sha256 = await this.computeContentSha256(decrypted);
          await this.writeFileToVault(vaultPath, decrypted);

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
      new Notice('Restore failed: ' + e.message);
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
    const a = document.createElement('a');
    a.href = url;
    a.download = `obsync-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    new Notice('Config exported');
  }

  importConfig(): void {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
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
        this.syncClient.updateConfig(this.settings.webdavUrl, this.settings.webdavUsername, this.settings.webdavPassword, this.settings.allowSelfSignedCerts);
        new Notice('Config imported successfully');
        this.settingsTab?.display();
      } catch (e) {
        new Notice('Import failed: ' + e.message);
      }
    };
    input.click();
  }
}
