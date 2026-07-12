import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';

const PQ_MAGIC = new Uint8Array([79, 66, 83, 89, 78, 67, 45, 75]); // "OBSYNC-K"
const MAGIC_LEN = 8;
const CT_LEN = 1088; // ML-KEM-768 ciphertext size
const IV_LEN = 12;

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class CryptoManager {
  private publicKey: Uint8Array | null = null;
  private secretKey: Uint8Array | null = null;
  private fingerprint = '';

  isReady(): boolean {
    return this.publicKey !== null;
  }

  canDecrypt(): boolean {
    return this.secretKey !== null;
  }

  async generateKeyPair(): Promise<{ publicKey: string; secretKey: string }> {
    const keys = ml_kem768.keygen();
    return {
      publicKey: bytesToBase64(keys.publicKey),
      secretKey: bytesToBase64(keys.secretKey),
    };
  }

  async loadPublicKey(b64: string): Promise<void> {
    this.publicKey = base64ToBytes(b64);
    const hash = await crypto.subtle.digest('SHA-256', this.publicKey);
    this.fingerprint = Array.from(new Uint8Array(hash))
      .map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async loadSecretKey(b64: string): Promise<void> {
    this.secretKey = base64ToBytes(b64);
  }

  getFingerprint(): string {
    return this.fingerprint || '(no key loaded)';
  }

  async encryptText(text: string): Promise<string> {
    const enc = await this.encryptBytes(new TextEncoder().encode(text));
    return bytesToBase64(enc);
  }

  async decryptText(b64: string): Promise<string> {
    const dec = await this.decryptBytes(base64ToBytes(b64));
    return new TextDecoder().decode(dec);
  }

  async encryptBytes(data: Uint8Array): Promise<Uint8Array> {
    if (!this.publicKey) throw new Error('Public key not loaded');

    const { cipherText, sharedSecret } = ml_kem768.encapsulate(this.publicKey);

    const aesKey = await crypto.subtle.importKey('raw', sharedSecret, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, data));

    const result = new Uint8Array(MAGIC_LEN + CT_LEN + IV_LEN + ciphertext.length);
    result.set(PQ_MAGIC, 0);
    result.set(cipherText, MAGIC_LEN);
    result.set(iv, MAGIC_LEN + CT_LEN);
    result.set(ciphertext, MAGIC_LEN + CT_LEN + IV_LEN);
    return result;
  }

  isPqFormat(data: Uint8Array): boolean {
    return data.length >= MAGIC_LEN && arraysEqual(data.subarray(0, MAGIC_LEN), PQ_MAGIC);
  }

  async decryptBytes(data: Uint8Array): Promise<Uint8Array> {
    if (!this.secretKey) throw new Error('Secret key not loaded');

    if (!this.isPqFormat(data)) {
      throw new Error('Unrecognized encryption format — not a valid OBSYNC-K payload');
    }

    const cipherText = data.subarray(MAGIC_LEN, MAGIC_LEN + CT_LEN);
    const iv = data.subarray(MAGIC_LEN + CT_LEN, MAGIC_LEN + CT_LEN + IV_LEN);
    const ciphertext = data.subarray(MAGIC_LEN + CT_LEN + IV_LEN);

    const sharedSecret = ml_kem768.decapsulate(cipherText, this.secretKey);

    const aesKey = await crypto.subtle.importKey('raw', sharedSecret, 'AES-GCM', false, ['decrypt']);
    const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext);
    return new Uint8Array(decrypted);
  }

  /* Path segment encryption (AES-256-GCM) */

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
    if (!this.fingerprint) throw new Error('No key loaded — load a public key first');
    const keyMaterial = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(this.fingerprint), 'PBKDF2', false, ['deriveBits', 'deriveKey'],
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
