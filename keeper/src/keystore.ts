// Decrypts a Web3 Secret Storage (version 3) keystore, the format written by `cast wallet import`,
// geth and most wallets. Uses node:crypto only.
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { type Hex, bytesToHex, hexToBytes, keccak256 } from "viem";

interface KeystoreV3 {
  version: number;
  crypto?: KeystoreCrypto;
  Crypto?: KeystoreCrypto;
}
interface KeystoreCrypto {
  cipher: string;
  ciphertext: string;
  cipherparams: { iv: string };
  kdf: string;
  kdfparams: Record<string, unknown>;
  mac: string;
}

function deriveKey(crypto: KeystoreCrypto, password: string): Buffer {
  const p = crypto.kdfparams;
  const salt = Buffer.from(String(p.salt), "hex");
  const dklen = Number(p.dklen);
  if (crypto.kdf === "scrypt") {
    const N = Number(p.n);
    const r = Number(p.r);
    return scryptSync(Buffer.from(password, "utf8"), salt, dklen, { N, r, p: Number(p.p), maxmem: 256 * N * r });
  }
  if (crypto.kdf === "pbkdf2") {
    if (p.prf !== "hmac-sha256") throw new Error("keystore: unsupported pbkdf2 prf");
    return pbkdf2Sync(Buffer.from(password, "utf8"), salt, Number(p.c), dklen, "sha256");
  }
  throw new Error(`keystore: unsupported kdf ${crypto.kdf}`);
}

/** Returns the private key. Throws on a wrong password without saying anything about the key. */
export function decryptKeystore(json: string, password: string): Hex {
  const keystore = JSON.parse(json) as KeystoreV3;
  const crypto = keystore.crypto ?? keystore.Crypto;
  if (keystore.version !== 3 || !crypto) throw new Error("keystore: not a version 3 keystore");
  if (crypto.cipher !== "aes-128-ctr") throw new Error(`keystore: unsupported cipher ${crypto.cipher}`);
  const key = deriveKey(crypto, password);
  const ciphertext = Buffer.from(crypto.ciphertext, "hex");
  const mac = hexToBytes(keccak256(Buffer.concat([key.subarray(16, 32), ciphertext])));
  const expected = Buffer.from(crypto.mac, "hex");
  if (expected.length !== mac.length || !timingSafeEqual(mac, expected)) {
    throw new Error("keystore: wrong password or corrupt file");
  }
  const decipher = createDecipheriv("aes-128-ctr", key.subarray(0, 16), Buffer.from(crypto.cipherparams.iv, "hex"));
  const privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (privateKey.length !== 32) throw new Error("keystore: unexpected key length");
  return bytesToHex(privateKey);
}

/** Encrypts a key into a version 3 keystore. Used by the tests; `cast wallet import` does the same. */
export function encryptKeystore(privateKey: Hex, password: string, n = 1 << 13): string {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const kdfparams = { dklen: 32, n, r: 8, p: 1, salt: salt.toString("hex") };
  const key = scryptSync(Buffer.from(password, "utf8"), salt, 32, { N: n, r: 8, p: 1, maxmem: 256 * n * 8 });
  const cipher = createCipheriv("aes-128-ctr", key.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(hexToBytes(privateKey)), cipher.final()]);
  const mac = keccak256(Buffer.concat([key.subarray(16, 32), ciphertext])).slice(2);
  return JSON.stringify({
    version: 3,
    crypto: {
      cipher: "aes-128-ctr",
      ciphertext: ciphertext.toString("hex"),
      cipherparams: { iv: iv.toString("hex") },
      kdf: "scrypt",
      kdfparams,
      mac,
    },
  });
}
