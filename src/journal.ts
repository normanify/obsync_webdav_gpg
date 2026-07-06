export type JournalEntryType = 'file_deleted' | 'dir_deleted' | 'file_updated';

export interface JournalEntry {
  id: string;
  type: JournalEntryType;
  vaultPath: string;
  timestamp: number;
}

export class JournalManager {
  private entries: JournalEntry[] = [];
  private path = '';
  private adapter: any = null;
  private idCounter = 0;

  async load(adapter: any, path: string): Promise<void> {
    this.adapter = adapter;
    this.path = path;
    try {
      const content = await this.adapter.read(path);
      const data = JSON.parse(content);
      this.entries = data.entries || [];
      this.idCounter = this.entries.length;
    } catch {
      this.entries = [];
      this.idCounter = 0;
    }
  }

  async save(): Promise<void> {
    if (!this.path) return;
    try {
      await this.adapter.write(this.path, JSON.stringify({ version: 1, entries: this.entries }, null, 2));
    } catch (e) {
      console.warn('Journal save failed:', e);
    }
  }

  record(type: JournalEntryType, vaultPath: string): void {
    this.entries.push({
      id: `j${++this.idCounter}-${Date.now()}`,
      type,
      vaultPath,
      timestamp: Date.now(),
    });
    this.save();
  }

  getPending(): JournalEntry[] {
    return [...this.entries];
  }

  clearCompleted(completedIds: Set<string>): void {
    const before = this.entries.length;
    this.entries = this.entries.filter(e => !completedIds.has(e.id));
    if (this.entries.length !== before) this.save();
  }

  getDeletedDirs(): Set<string> {
    const dirs = new Set<string>();
    for (const e of this.entries) {
      if (e.type === 'dir_deleted') dirs.add(e.vaultPath);
    }
    return dirs;
  }

  getDeletedFiles(): Set<string> {
    const files = new Set<string>();
    for (const e of this.entries) {
      if (e.type === 'file_deleted') files.add(e.vaultPath);
    }
    return files;
  }
}
