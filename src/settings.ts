import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import ObsyncPlugin from './main';

export interface ObsyncSettings {
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  publicKey: string;
  privateKey: string;
  passphrase: string;
  storePassphrase: boolean;
  excludePaths: string;
  allowSelfSignedCerts: boolean;
  autoSyncOnSave: boolean;
  chunkSizeMb: number;
  verboseLog: boolean;
  onDemand: boolean;
}

export const DEFAULT_SETTINGS: ObsyncSettings = {
  webdavUrl: '',
  webdavUsername: '',
  webdavPassword: '',
  publicKey: '',
  privateKey: '',
  passphrase: '',
  storePassphrase: false,
  excludePaths: '<configDir>/plugins/,.trash/',
  allowSelfSignedCerts: false,
  autoSyncOnSave: false,
  chunkSizeMb: 90,
  verboseLog: false,
  onDemand: false,
};

export class ObsyncSettingTab extends PluginSettingTab {
  plugin: ObsyncPlugin;

  constructor(app: App, plugin: ObsyncPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl).setName('Connection').setHeading();

    new Setting(containerEl)
      .setName('WebDAV URL')
      .setDesc('Full URL to the WebDAV directory (e.g. https://example.com/remote.php/dav/files/user/obsync/)')
      .addText(text => text
        .setPlaceholder('https://...')
        .setValue(this.plugin.settings.webdavUrl)
        .onChange(async value => {
          this.plugin.settings.webdavUrl = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Username')
      .addText(text => text
        .setPlaceholder('username')
        .setValue(this.plugin.settings.webdavUsername)
        .onChange(async value => {
          this.plugin.settings.webdavUsername = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Password')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setPlaceholder('password');
        text.setValue(this.plugin.settings.webdavPassword);
        text.onChange(async value => {
          this.plugin.settings.webdavPassword = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName('Test Connection')
      .setDesc('Verify the WebDAV connection')
      .addButton(btn => btn
        .setButtonText('Test')
        .onClick(async () => {
          try {
            this.plugin.syncClient.updateConfig(
              this.plugin.settings.webdavUrl,
              this.plugin.settings.webdavUsername,
              this.plugin.settings.webdavPassword,
              this.plugin.settings.allowSelfSignedCerts,
            );
            await this.plugin.syncClient.testConnection();
            new Notice('WebDAV connection successful');
          } catch (e) {
            new Notice('WebDAV connection failed: ' + e.message);
          }
        }));

    new Setting(containerEl)
      .setName('Allow Self-Signed Certificates')
      .setDesc('Disable TLS certificate verification (for WebDAV servers with self-signed certificates). Warning: reduces connection security.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.allowSelfSignedCerts)
        .onChange(async value => {
          this.plugin.settings.allowSelfSignedCerts = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('GPG Keys').setHeading();

    const pubLoaded = !!this.plugin.cryptoManager['publicKey'];
    const privLoaded = !!this.plugin.cryptoManager['privateKey'];

    containerEl.createEl('p', {
      text: `Public key: ${pubLoaded ? '✓ loaded' : '—'}  |  Private key: ${privLoaded ? '✓ loaded' : '—'}`,
      cls: 'obsync-status',
    });

    new Setting(containerEl)
      .setName('Passphrase')
      .setDesc('Passphrase for your private GPG key')
      .addText(text => {
        text.inputEl.type = 'password';
        text.setValue(this.plugin.settings.passphrase);
        text.onChange(async value => {
          this.plugin.settings.passphrase = value;
          await this.plugin.saveSettings();
          await this.plugin.loadKeys();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName('Store Passphrase')
      .setDesc('Save passphrase to disk (required for automated sync). Warning: stored in plaintext.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.storePassphrase)
        .onChange(async value => {
          this.plugin.settings.storePassphrase = value;
          if (!value) this.plugin.settings.passphrase = '';
          await this.plugin.saveSettings();
          this.display();
        }));

    new Setting(containerEl)
      .setName('Generate Key Pair')
      .setDesc('Generate a new RSA 4096-bit GPG key pair for first-time setup')
      .addButton(btn => btn
        .setButtonText('Generate')
        .onClick(async () => {
          if (!this.plugin.settings.passphrase) {
            new Notice('Please set a passphrase first');
            return;
          }
          try {
            await this.plugin.generateKeyPair();
            this.display();
          } catch (e) {
            new Notice('Key generation failed: ' + e.message);
          }
        }));

    new Setting(containerEl)
      .setName('Public Key (armored)')
      .setDesc('Paste an existing public key, or copy the one generated above for sharing')
      .addTextArea(text => {
        text.setPlaceholder('-----BEGIN PGP PUBLIC KEY BLOCK-----');
        text.setValue(this.plugin.settings.publicKey);
        text.onChange(async value => {
          this.plugin.settings.publicKey = value;
          await this.plugin.saveSettings();
          await this.plugin.loadKeys();
          this.display();
        });
        text.inputEl.rows = 4;
        text.inputEl.addClass('obsync-mono');
      });

    new Setting(containerEl)
      .setName('Private Key (armored)')
      .setDesc('Paste your existing private key here to restore on a new device')
      .addTextArea(text => {
        text.setPlaceholder('-----BEGIN PGP PRIVATE KEY BLOCK-----');
        text.setValue(this.plugin.settings.privateKey);
        text.onChange(async value => {
          this.plugin.settings.privateKey = value;
          await this.plugin.saveSettings();
          if (this.plugin.settings.passphrase) {
            await this.plugin.loadKeys();
            this.display();
          }
        });
        text.inputEl.rows = 4;
        text.inputEl.addClass('obsync-mono');
      });

    if (privLoaded) {
      new Setting(containerEl)
        .setName('Decryption Test')
        .setDesc('Private key is loaded and ready for restore')
        .addButton(btn => btn
          .setButtonText('Test Decrypt')
          .setCta()
          .onClick(async () => {
            try {
              const test = await this.plugin.cryptoManager.encryptText('test');
              const dec = await this.plugin.cryptoManager.decryptText(test);
              new Notice(dec === 'test' ? 'Encrypt/decrypt round-trip OK' : 'Decryption mismatch');
            } catch (e) {
              new Notice('Decryption test failed: ' + e.message);
            }
          }));
    }

    new Setting(containerEl).setName('Auto Sync').setHeading();

    new Setting(containerEl)
      .setName('Auto Sync on Save')
      .setDesc('Automatically sync to WebDAV when a file is saved (debounced 3s)')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoSyncOnSave)
        .onChange(async value => {
          this.plugin.settings.autoSyncOnSave = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl).setName('Advanced').setHeading();

    new Setting(containerEl)
      .setName('Chunk Size (MB)')
      .setDesc('Files larger than this will be split into chunks for upload. Required for Nextcloud to handle files >100MB. Default: 90MB.')
      .addText(text => text
        .setValue(String(this.plugin.settings.chunkSizeMb))
        .onChange(async value => {
          const num = parseInt(value, 10);
          if (!isNaN(num) && num > 0) {
            this.plugin.settings.chunkSizeMb = num;
            await this.plugin.saveSettings();
          }
        }));

    new Setting(containerEl)
      .setName('Verbose Log')
      .setDesc('Show detailed file-by-file progress in the console (DevTools → Console) during sync')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.verboseLog)
        .onChange(async value => {
          this.plugin.settings.verboseLog = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Download on Demand')
      .setDesc('Only download file names during sync; actual file content is downloaded when you open a file. Useful for large vaults or slow connections.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.onDemand)
        .onChange(async value => {
          this.plugin.settings.onDemand = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Excluded Paths')
      .setDesc('Comma-separated list of path prefixes to exclude from sync')
      .addText(text => text
        .setValue(this.plugin.settings.excludePaths)
        .onChange(async value => {
          this.plugin.settings.excludePaths = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Export Config')
      .setDesc('Download all plugin settings (keys, passphrase, WebDAV credentials) as JSON')
      .addButton(btn => btn
        .setButtonText('Export')
        .onClick(() => this.plugin.exportConfig()));

    new Setting(containerEl)
      .setName('Import Config')
      .setDesc('Load settings from a previously exported JSON file')
      .addButton(btn => btn
        .setButtonText('Import')
        .onClick(() => this.plugin.importConfig()));

    new Setting(containerEl).setName('Sync Actions').setHeading();

    new Setting(containerEl)
      .setName('Sync to WebDAV')
      .setDesc('Bidirectional sync: push local changes, pull remote changes (ETag-based)')
      .addButton(btn => btn
        .setButtonText('Sync Now')
        .setCta()
        .onClick(() => this.plugin.syncToWebDAV()));

    new Setting(containerEl)
      .setName('Restore from WebDAV')
      .setDesc('Download and decrypt all files from WebDAV, rebuilding vault state')
      .addButton(btn => btn
        .setButtonText('Restore Now')
        .setWarning()
        .onClick(() => this.plugin.restoreFromWebDAV()));
  }
}
