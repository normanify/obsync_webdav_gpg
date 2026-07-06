import * as openpgp from 'openpgp';

export class CryptoManager {
  private publicKey: openpgp.PublicKey | null = null;
  private privateKey: openpgp.PrivateKey | null = null;

  isReady(): boolean {
    return this.publicKey !== null;
  }

  canDecrypt(): boolean {
    return this.privateKey !== null;
  }

  async generateKeyPair(passphrase: string): Promise<{ publicKey: string; privateKey: string }> {
    const result = await openpgp.generateKey({
      type: 'rsa',
      rsaBits: 4096,
      userIDs: [{ name: 'Obsync User' }],
      passphrase,
      format: 'armored',
    });
    return { publicKey: result.publicKey, privateKey: result.privateKey };
  }

  async loadPublicKey(armored: string): Promise<void> {
    this.publicKey = await openpgp.readKey({ armoredKey: armored });
  }

  async loadPrivateKey(armored: string, passphrase: string): Promise<void> {
    const key = await openpgp.readPrivateKey({ armoredKey: armored });
    this.privateKey = await openpgp.decryptKey({ privateKey: key, passphrase });
  }

  async encryptText(text: string): Promise<string> {
    if (!this.publicKey) throw new Error('Public key not loaded');
    const message = await openpgp.createMessage({ text });
    return await openpgp.encrypt({ message, encryptionKeys: this.publicKey });
  }

  async decryptText(armored: string): Promise<string> {
    if (!this.privateKey) throw new Error('Private key not loaded');
    const message = await openpgp.readMessage({ armoredMessage: armored });
    const { data } = await openpgp.decrypt({ message, decryptionKeys: this.privateKey });
    return data as string;
  }

  async encryptBytes(data: Uint8Array): Promise<Uint8Array> {
    if (!this.publicKey) throw new Error('Public key not loaded');
    const message = await openpgp.createMessage({ binary: data });
    const encrypted = await openpgp.encrypt({
      message,
      encryptionKeys: this.publicKey,
      format: 'binary',
    });
    return encrypted as Uint8Array;
  }

  async decryptBytes(data: Uint8Array): Promise<Uint8Array> {
    if (!this.privateKey) throw new Error('Private key not loaded');
    const message = await openpgp.readMessage({ binaryMessage: data });
    const { data: decrypted } = await openpgp.decrypt({
      message,
      decryptionKeys: this.privateKey,
      format: 'binary',
    });
    return decrypted as Uint8Array;
  }

  /* Path segment encryption (AES-256-GCM) — short output suitable for filenames */

  private aesKey: CryptoKey | null = null;
  private aesKeyPromise: Promise<CryptoKey> | null = null;

  private async getAESKey(): Promise<CryptoKey> {
    if (this.aesKey) return this.aesKey;
    if (this.aesKeyPromise) return this.aesKeyPromise;
    this.aesKeyPromise = this.deriveAESKey();
    this.aesKey = await this.aesKeyPromise;
    this.aesKeyPromise = null;
    return this.aesKey;
  }

  private async deriveAESKey(): Promise<CryptoKey> {
    if (!this.publicKey) throw new Error('Public key not loaded');
    const fingerprint = this.publicKey.getFingerprint();
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(fingerprint), 'PBKDF2', false, ['deriveBits', 'deriveKey'],
    );
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: new TextEncoder().encode('obsync-path-v2'), iterations: 100000, hash: 'SHA-256' },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  }

  async encryptPathSegment(plain: string): Promise<Uint8Array> {
    const key = await this.getAESKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plain);
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoded);
    const combined = new Uint8Array(iv.length + ciphertext.byteLength);
    combined.set(iv, 0);
    combined.set(new Uint8Array(ciphertext), iv.length);
    return combined;
  }

  async decryptPathSegment(data: Uint8Array): Promise<string> {
    const key = await this.getAESKey();
    const iv = data.subarray(0, 12);
    const ciphertext = data.subarray(12);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return new TextDecoder().decode(decrypted);
  }
}
