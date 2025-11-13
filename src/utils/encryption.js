const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

/**
 * Encryption Utility for Sensitive User Data
 *
 * Provides AES-256-GCM encryption for user configuration data including API keys,
 * passwords, and other sensitive information stored in Redis and filesystem.
 *
 * Security Features:
 * - AES-256-GCM authenticated encryption (confidentiality + integrity)
 * - Random IV (Initialization Vector) for each encryption
 * - Authentication tag to detect tampering
 * - Key derivation from environment variable or auto-generated key
 *
 * @module encryption
 */

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const ENCRYPTION_KEY_FILE = process.env.ENCRYPTION_KEY_FILE || path.join(process.cwd(), '.encryption-key');

let encryptionKey = null;

/**
 * Initialize encryption key from environment or generate new one
 * @returns {Buffer} Encryption key
 */
function getEncryptionKey() {
  if (encryptionKey) {
    return encryptionKey;
  }

  // Try to load from environment variable
  if (process.env.ENCRYPTION_KEY) {
    try {
      const keyHex = process.env.ENCRYPTION_KEY;
      if (keyHex.length !== KEY_LENGTH * 2) {
        throw new Error(`ENCRYPTION_KEY must be ${KEY_LENGTH * 2} hex characters (${KEY_LENGTH} bytes)`);
      }
      encryptionKey = Buffer.from(keyHex, 'hex');
      log.debug(() => '[Encryption] Using encryption key from environment variable');
      return encryptionKey;
    } catch (error) {
      log.error(() => ['[Encryption] Invalid ENCRYPTION_KEY in environment:', error.message]);
      throw error;
    }
  }

  // Try to load from file
  if (fs.existsSync(ENCRYPTION_KEY_FILE)) {
    try {
      const keyHex = fs.readFileSync(ENCRYPTION_KEY_FILE, 'utf8').trim();
      if (keyHex.length !== KEY_LENGTH * 2) {
        throw new Error(`Encryption key file corrupt: expected ${KEY_LENGTH * 2} hex characters`);
      }
      encryptionKey = Buffer.from(keyHex, 'hex');
      log.debug(() => ['[Encryption] Loaded encryption key from file:', ENCRYPTION_KEY_FILE]);
      return encryptionKey;
    } catch (error) {
      log.error(() => ['[Encryption] Failed to load encryption key from file:', error.message]);
      // Continue to generate new key
    }
  }

  // Generate new key and save to file
  encryptionKey = crypto.randomBytes(KEY_LENGTH);
  const keyHex = encryptionKey.toString('hex');

  try {
    fs.writeFileSync(ENCRYPTION_KEY_FILE, keyHex, { mode: 0o600 }); // Read/write for owner only
    log.warn(() => ['[Encryption] ⚠️  Generated NEW encryption key and saved to:', ENCRYPTION_KEY_FILE]);
    log.warn(() => '[Encryption] ⚠️  IMPORTANT: Back up this file! Loss of this key means loss of encrypted data.');
    log.warn(() => '[Encryption] ⚠️  For production, use ENCRYPTION_KEY environment variable instead.');
  } catch (error) {
    log.error(() => ['[Encryption] Failed to save encryption key to file:', error.message]);
    log.warn(() => '[Encryption] Using in-memory key only (will be lost on restart!)');
  }

  return encryptionKey;
}

/**
 * Encrypt sensitive data
 * @param {any} data - Data to encrypt (will be JSON stringified)
 * @returns {string} Encrypted data as base64 string with format: version:iv:authTag:ciphertext
 */
function encrypt(data) {
  try {
    const key = getEncryptionKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    // Stringify data if it's an object
    const plaintext = typeof data === 'string' ? data : JSON.stringify(data);

    // Encrypt
    let ciphertext = cipher.update(plaintext, 'utf8', 'base64');
    ciphertext += cipher.final('base64');

    // Get authentication tag
    const authTag = cipher.getAuthTag();

    // Format: version:iv:authTag:ciphertext (all base64 encoded)
    // Version 1 = AES-256-GCM
    const encrypted = `1:${iv.toString('base64')}:${authTag.toString('base64')}:${ciphertext}`;

    return encrypted;
  } catch (error) {
    log.error(() => ['[Encryption] Encryption failed:', error.message]);
    throw new Error('Failed to encrypt data: ' + error.message);
  }
}

/**
 * Decrypt sensitive data
 * @param {string} encryptedData - Encrypted data string
 * @param {boolean} returnRawOnError - If true, return raw data on decryption error (backward compatibility)
 * @returns {any} Decrypted data (parsed as JSON if possible)
 */
function decrypt(encryptedData, returnRawOnError = true) {
  try {
    // Check if data is actually encrypted (has our format)
    if (!encryptedData || typeof encryptedData !== 'string') {
      if (returnRawOnError) {
        return encryptedData; // Return as-is (backward compatibility)
      }
      throw new Error('Invalid encrypted data format');
    }

    // Check for encryption format: version:iv:authTag:ciphertext
    const parts = encryptedData.split(':');
    if (parts.length !== 4 || parts[0] !== '1') {
      // Not encrypted or unknown version, return as-is for backward compatibility
      if (returnRawOnError) {
        // Try to parse as JSON if it looks like JSON
        if (encryptedData.trim().startsWith('{') || encryptedData.trim().startsWith('[')) {
          try {
            return JSON.parse(encryptedData);
          } catch {
            return encryptedData;
          }
        }
        return encryptedData;
      }
      throw new Error('Invalid encryption format or version');
    }

    const [version, ivBase64, authTagBase64, ciphertext] = parts;

    const key = getEncryptionKey();
    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    // Decrypt
    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    // Try to parse as JSON
    try {
      return JSON.parse(decrypted);
    } catch {
      return decrypted; // Return as string if not JSON
    }
  } catch (error) {
    if (returnRawOnError) {
      log.warn(() => ['[Encryption] Decryption failed, returning raw data (backward compatibility):', error.message]);
      // Try to parse as JSON if it looks like JSON
      if (encryptedData && typeof encryptedData === 'string') {
        if (encryptedData.trim().startsWith('{') || encryptedData.trim().startsWith('[')) {
          try {
            return JSON.parse(encryptedData);
          } catch {
            return encryptedData;
          }
        }
      }
      return encryptedData;
    }
    log.error(() => ['[Encryption] Decryption failed:', error.message]);
    throw new Error('Failed to decrypt data: ' + error.message);
  }
}

/**
 * Check if data appears to be encrypted with our format
 * @param {any} data - Data to check
 * @returns {boolean} True if data appears encrypted
 */
function isEncrypted(data) {
  if (!data || typeof data !== 'string') {
    return false;
  }
  const parts = data.split(':');
  return parts.length === 4 && parts[0] === '1';
}

/**
 * Encrypt specific sensitive fields in a user config object
 * @param {Object} config - User configuration object
 * @returns {Object} Config with sensitive fields encrypted
 */
function encryptUserConfig(config) {
  if (!config || typeof config !== 'object') {
    return config;
  }

  // Clone config to avoid modifying original
  const encrypted = JSON.parse(JSON.stringify(config));

  try {
    // Encrypt Gemini API key
    if (encrypted.geminiApiKey) {
      encrypted.geminiApiKey = encrypt(encrypted.geminiApiKey);
    }

    // Encrypt subtitle provider credentials
    if (encrypted.subtitleProviders) {
      // OpenSubtitles username/password
      if (encrypted.subtitleProviders.opensubtitles) {
        if (encrypted.subtitleProviders.opensubtitles.username) {
          encrypted.subtitleProviders.opensubtitles.username =
            encrypt(encrypted.subtitleProviders.opensubtitles.username);
        }
        if (encrypted.subtitleProviders.opensubtitles.password) {
          encrypted.subtitleProviders.opensubtitles.password =
            encrypt(encrypted.subtitleProviders.opensubtitles.password);
        }
      }

      // SubDL API key
      if (encrypted.subtitleProviders.subdl?.apiKey) {
        encrypted.subtitleProviders.subdl.apiKey =
          encrypt(encrypted.subtitleProviders.subdl.apiKey);
      }

      // SubSource API key
      if (encrypted.subtitleProviders.subsource?.apiKey) {
        encrypted.subtitleProviders.subsource.apiKey =
          encrypt(encrypted.subtitleProviders.subsource.apiKey);
      }
    }

    // Mark as encrypted for future detection
    encrypted._encrypted = true;

    return encrypted;
  } catch (error) {
    log.error(() => ['[Encryption] Failed to encrypt user config:', error.message]);
    throw error;
  }
}

/**
 * Decrypt specific sensitive fields in a user config object
 * @param {Object} config - User configuration object with encrypted fields
 * @returns {Object} Config with sensitive fields decrypted
 */
function decryptUserConfig(config) {
  if (!config || typeof config !== 'object') {
    return config;
  }

  // Clone config to avoid modifying original
  const decrypted = JSON.parse(JSON.stringify(config));

  // Check if config is marked as encrypted
  const isConfigEncrypted = decrypted._encrypted === true;
  log.debug(() => `[Encryption] decryptUserConfig called, isConfigEncrypted: ${isConfigEncrypted}`);

  try {
    // Decrypt Gemini API key
    if (decrypted.geminiApiKey && (isConfigEncrypted || isEncrypted(decrypted.geminiApiKey))) {
      log.debug(() => '[Encryption] Decrypting Gemini API key');
      decrypted.geminiApiKey = decrypt(decrypted.geminiApiKey, true);
    }

    // Decrypt subtitle provider credentials
    if (decrypted.subtitleProviders) {
      // OpenSubtitles username/password
      if (decrypted.subtitleProviders.opensubtitles) {
        if (decrypted.subtitleProviders.opensubtitles.username &&
            (isConfigEncrypted || isEncrypted(decrypted.subtitleProviders.opensubtitles.username))) {
          log.debug(() => '[Encryption] Decrypting OpenSubtitles username');
          decrypted.subtitleProviders.opensubtitles.username =
            decrypt(decrypted.subtitleProviders.opensubtitles.username, true);
        }
        if (decrypted.subtitleProviders.opensubtitles.password &&
            (isConfigEncrypted || isEncrypted(decrypted.subtitleProviders.opensubtitles.password))) {
          log.debug(() => '[Encryption] Decrypting OpenSubtitles password');
          decrypted.subtitleProviders.opensubtitles.password =
            decrypt(decrypted.subtitleProviders.opensubtitles.password, true);
        }
      }

      // SubDL API key
      if (decrypted.subtitleProviders.subdl?.apiKey) {
        const subdlKeyEncrypted = isEncrypted(decrypted.subtitleProviders.subdl.apiKey);
        log.debug(() => `[Encryption] SubDL API key exists, encrypted: ${subdlKeyEncrypted}, will decrypt: ${isConfigEncrypted || subdlKeyEncrypted}`);
        if (isConfigEncrypted || subdlKeyEncrypted) {
          const before = decrypted.subtitleProviders.subdl.apiKey.substring(0, 30);
          decrypted.subtitleProviders.subdl.apiKey =
            decrypt(decrypted.subtitleProviders.subdl.apiKey, true);
          const after = typeof decrypted.subtitleProviders.subdl.apiKey === 'string' ?
            decrypted.subtitleProviders.subdl.apiKey.substring(0, 30) : 'NOT_STRING';
          log.debug(() => `[Encryption] SubDL key decrypted: before="${before}..." after="${after}..."`);
        }
      }

      // SubSource API key
      if (decrypted.subtitleProviders.subsource?.apiKey) {
        const subsourceKeyEncrypted = isEncrypted(decrypted.subtitleProviders.subsource.apiKey);
        log.debug(() => `[Encryption] SubSource API key exists, encrypted: ${subsourceKeyEncrypted}, will decrypt: ${isConfigEncrypted || subsourceKeyEncrypted}`);
        if (isConfigEncrypted || subsourceKeyEncrypted) {
          const before = decrypted.subtitleProviders.subsource.apiKey.substring(0, 30);
          decrypted.subtitleProviders.subsource.apiKey =
            decrypt(decrypted.subtitleProviders.subsource.apiKey, true);
          const after = typeof decrypted.subtitleProviders.subsource.apiKey === 'string' ?
            decrypted.subtitleProviders.subsource.apiKey.substring(0, 30) : 'NOT_STRING';
          log.debug(() => `[Encryption] SubSource key decrypted: before="${before}..." after="${after}..."`);
        }
      }
    }

    // Remove encryption marker
    delete decrypted._encrypted;

    return decrypted;
  } catch (error) {
    log.error(() => ['[Encryption] Failed to decrypt user config:', error.message]);
    // Return original config on error for backward compatibility
    return config;
  }
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  encryptUserConfig,
  decryptUserConfig,
  getEncryptionKey
};
