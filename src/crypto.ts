import * as openpgp from 'openpgp';

const HYBRID_MAGIC = new Uint8Array([79, 66, 83, 89, 78, 67, 45, 72]); // "OBSYNC-H"
const MAGIC_LEN = 8;
const KEY_LEN_BYTES = 4;
const IV_LEN = 12;

function u32ToBytes(v: number): Uint8Array {
  return new Uint8Array([v >>> 24, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function bytesToU32(buf: Uint8Array, offset: number): number {
  return (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
}

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
 
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

    // Generate random AES-256 key
    const aesKeyRaw = crypto.getRandomValues(new Uint8Array(32));
    const aesKey = await crypto.subtle.importKey('raw', aesKeyRaw, 'AES-GCM', false, ['encrypt']);

    // Encrypt bulk data with AES-GCM via Web Crypto (non-blocking)
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, data));

    // Encrypt the AES key with OpenPGP (small data, fast)
    const keyMsg = await openpgp.createMessage({ binary: aesKeyRaw });
    const encryptedKey = new Uint8Array(await openpgp.encrypt({
      message: keyMsg,
      encryptionKeys: this.publicKey,
      format: 'binary',
    }));

    // Build hybrid format: magic + keyLen + RSA-encrypted key + IV + AES ciphertext
    const result = new Uint8Array(MAGIC_LEN + KEY_LEN_BYTES + encryptedKey.length + IV_LEN + ciphertext.length);
    result.set(HYBRID_MAGIC, 0);
    result.set(u32ToBytes(encryptedKey.length), MAGIC_LEN);
    result.set(encryptedKey, MAGIC_LEN + KEY_LEN_BYTES);
    result.set(iv, MAGIC_LEN + KEY_LEN_BYTES + encryptedKey.length);
    result.set(ciphertext, MAGIC_LEN + KEY_LEN_BYTES + encryptedKey.length + IV_LEN);
    return result;
  }

  isHybridFormat(data: Uint8Array): boolean {
    return data.length >= MAGIC_LEN && arraysEqual(data.subarray(0, MAGIC_LEN), HYBRID_MAGIC);
  }

  async decryptBytes(data: Uint8Array): Promise<Uint8Array> {
    if (!this.privateKey) throw new Error('Private key not loaded');

    if (this.isHybridFormat(data)) {
      const keyLen = bytesToU32(data, MAGIC_LEN);
      const keyStart = MAGIC_LEN + KEY_LEN_BYTES;
      const ivStart = keyStart + keyLen;
      const ctStart = ivStart + IV_LEN;

      // Decrypt the AES key with OpenPGP (small data, fast)
      const encKeyData = data.subarray(keyStart, ivStart);
      const keyMsg = await openpgp.readMessage({ binaryMessage: encKeyData });
      const { data: aesKeyRaw } = await openpgp.decrypt({
        message: keyMsg,
        decryptionKeys: this.privateKey,
        format: 'binary',
      });

      // Decrypt bulk data with AES-GCM via Web Crypto (non-blocking)
      const aesKey = await crypto.subtle.importKey('raw', aesKeyRaw as Uint8Array, 'AES-GCM', false, ['decrypt']);
      const iv = data.subarray(ivStart, ctStart);
      const ciphertext = data.subarray(ctStart);
      const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
      return new Uint8Array(decrypted);
    }

    // Legacy OpenPGP format
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
