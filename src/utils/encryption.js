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
  log.debug(() => ['[Encryption] Checking for encryption key file:', ENCRYPTION_KEY_FILE]);
  if (fs.existsSync(ENCRYPTION_KEY_FILE)) {
    try {
      log.debug(() => '[Encryption] Encryption key file exists, attempting to load...');
      const keyHex = fs.readFileSync(ENCRYPTION_KEY_FILE, 'utf8').trim();
      if (keyHex.length !== KEY_LENGTH * 2) {
        throw new Error(`Encryption key file corrupt: expected ${KEY_LENGTH * 2} hex characters, got ${keyHex.length}`);
      }
      encryptionKey = Buffer.from(keyHex, 'hex');
      log.info(() => ['[Encryption] ✓ Successfully loaded encryption key from file:', ENCRYPTION_KEY_FILE]);
      return encryptionKey;
    } catch (error) {
      log.error(() => ['[Encryption] Failed to load encryption key from file:', error.message]);
      log.error(() => ['[Encryption] CRITICAL: File exists but cannot be read. Manual intervention required.']);
      log.error(() => ['[Encryption] To fix: Delete the corrupt key file or fix permissions, then restart.']);
      log.error(() => ['[Encryption] WARNING: Deleting the key file will make existing encrypted data inaccessible!']);
      // IMPORTANT: Do NOT fall through to key generation - this would overwrite the existing key file
      // and make all previously encrypted data permanently inaccessible
      throw new Error(`Cannot load existing encryption key from ${ENCRYPTION_KEY_FILE}: ${error.message}`);
    }
  } else {
    log.debug(() => ['[Encryption] Encryption key file does not exist, will generate new one']);
  }

  // Generate new key and save to file
  encryptionKey = crypto.randomBytes(KEY_LENGTH);
  const keyHex = encryptionKey.toString('hex');

  try {
    // Ensure the directory exists before writing
    const keyDir = path.dirname(ENCRYPTION_KEY_FILE);
    if (!fs.existsSync(keyDir)) {
      log.debug(() => ['[Encryption] Creating encryption key directory:', keyDir]);
      fs.mkdirSync(keyDir, { recursive: true, mode: 0o755 }); // Changed from 0o700 to allow node user access
      log.debug(() => ['[Encryption] Created encryption key directory:', keyDir]);
    }

    // Verify directory is writable before attempting to write key
    try {
      fs.accessSync(keyDir, fs.constants.W_OK);
    } catch (accessError) {
      throw new Error(`Directory ${keyDir} is not writable: ${accessError.message}`);
    }

    fs.writeFileSync(ENCRYPTION_KEY_FILE, keyHex, { mode: 0o600 }); // Read/write for owner only
    log.warn(() => ['[Encryption] ⚠️  Generated NEW encryption key and saved to:', ENCRYPTION_KEY_FILE]);
    log.warn(() => '[Encryption] ⚠️  IMPORTANT: Back up this file! Loss of this key means loss of encrypted data.');
    log.warn(() => '[Encryption] ⚠️  For production, use ENCRYPTION_KEY environment variable instead.');
  } catch (error) {
    log.error(() => ['[Encryption] Failed to save encryption key to file:', error.message]);
    log.error(() => ['[Encryption] Key file path:', ENCRYPTION_KEY_FILE]);
    log.error(() => ['[Encryption] Directory exists:', fs.existsSync(path.dirname(ENCRYPTION_KEY_FILE))]);
    // Running with an in-memory key makes all encrypted data unrecoverable after
    // a restart. Fail fast so operators fix the persistence/permissions issue
    // instead of silently generating a new key on every boot and "losing" all
    // stored sessions/configs.
    throw new Error(`Failed to persist encryption key to ${ENCRYPTION_KEY_FILE}; aborting to avoid key loss`);
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
    // SECURITY: If the data matched our encrypted format (1:iv:authTag:ciphertext) but
    // decryption failed (e.g. key mismatch), NEVER return the raw ciphertext. Returning
    // it would leak ciphertext into API Authorization headers sent to third-party services.
    // Instead, return null so callers can detect the failure and handle it gracefully.
    const looksEncrypted = encryptedData && typeof encryptedData === 'string' && isEncrypted(encryptedData);

    if (looksEncrypted) {
      log.error(() => ['[Encryption] Decryption failed for encrypted data (key mismatch?). Returning null to prevent ciphertext leak:', error.message]);
      return null;
    }

    if (returnRawOnError) {
      log.warn(() => ['[Encryption] Decryption failed for non-encrypted data, returning as-is (backward compatibility):', error.message]);
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

    // Encrypt Gemini API keys array (for key rotation feature)
    if (Array.isArray(encrypted.geminiApiKeys) && encrypted.geminiApiKeys.length > 0) {
      encrypted.geminiApiKeys = encrypted.geminiApiKeys.map(key => {
        if (typeof key === 'string' && key.trim()) {
          return encrypt(key);
        }
        return key;
      });
    }

    // Encrypt AssemblyAI API key
    if (encrypted.assemblyAiApiKey) {
      encrypted.assemblyAiApiKey = encrypt(encrypted.assemblyAiApiKey);
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

      // Subs.ro API key
      if (encrypted.subtitleProviders.subsro?.apiKey) {
        encrypted.subtitleProviders.subsro.apiKey =
          encrypt(encrypted.subtitleProviders.subsro.apiKey);
      }
    }

    // Encrypt alternative AI provider API keys
    if (encrypted.providers && typeof encrypted.providers === 'object') {
      for (const [key, provider] of Object.entries(encrypted.providers)) {
        if (provider && provider.apiKey) {
          encrypted.providers[key].apiKey = encrypt(provider.apiKey);
        }
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
// Track if any decryption operations fail during this call - helps detect encryption key mismatches
let decryptionWarnings = [];

function decryptUserConfig(config) {
  if (!config || typeof config !== 'object') {
    return config;
  }

  // Reset warnings for this call
  decryptionWarnings = [];

  // Clone config to avoid modifying original
  const decrypted = JSON.parse(JSON.stringify(config));

  // Check if config is marked as encrypted
  // Note: Individual fields are encrypted (e.g., geminiApiKey), NOT the entire config object
  // This is NOT double encryption - stored.config is the decrypted config object with encrypted fields inside it
  const isConfigEncrypted = decrypted._encrypted === true;
  log.debug(() => `[Encryption] decryptUserConfig called, isConfigEncrypted: ${isConfigEncrypted} (individual fields may be encrypted)`);

  // Helper to decrypt with warning tracking
  const safeDecrypt = (value, fieldName) => {
    if (!value) return value;
    const wasEncrypted = isEncrypted(value);
    const result = decrypt(value, true);
    // decrypt() returns null when encrypted data can't be decrypted (key mismatch)
    // In that case, clear the field to prevent ciphertext from leaking into API calls
    if (result === null && wasEncrypted) {
      decryptionWarnings.push(fieldName);
      log.warn(() => `[Encryption] Failed to decrypt ${fieldName} - encryption key mismatch. Field cleared to prevent ciphertext leak.`);
      return '';
    }
    // Check if decryption actually happened (value changed) or if it returned raw encrypted data
    if (wasEncrypted && result === value) {
      decryptionWarnings.push(fieldName);
      log.warn(() => `[Encryption] Failed to decrypt ${fieldName} - encryption key mismatch? Returning raw encrypted data.`);
    }
    return result;
  };

  try {
    // Decrypt Gemini API key
    if (decrypted.geminiApiKey && (isConfigEncrypted || isEncrypted(decrypted.geminiApiKey))) {
      log.debug(() => '[Encryption] Decrypting Gemini API key');
      decrypted.geminiApiKey = safeDecrypt(decrypted.geminiApiKey, 'geminiApiKey');
    }

    // Decrypt Gemini API keys array (for key rotation feature)
    if (Array.isArray(decrypted.geminiApiKeys) && decrypted.geminiApiKeys.length > 0) {
      decrypted.geminiApiKeys = decrypted.geminiApiKeys.map((key, idx) => {
        if (key && (isConfigEncrypted || isEncrypted(key))) {
          return safeDecrypt(key, `geminiApiKeys[${idx}]`);
        }
        return key;
      });
      log.debug(() => `[Encryption] Decrypted ${decrypted.geminiApiKeys.length} Gemini API keys`);
    }

    // Decrypt AssemblyAI API key
    if (decrypted.assemblyAiApiKey && (isConfigEncrypted || isEncrypted(decrypted.assemblyAiApiKey))) {
      log.debug(() => '[Encryption] Decrypting AssemblyAI API key');
      decrypted.assemblyAiApiKey = safeDecrypt(decrypted.assemblyAiApiKey, 'assemblyAiApiKey');
    }

    // Decrypt subtitle provider credentials
    if (decrypted.subtitleProviders) {
      // OpenSubtitles username/password - use safeDecrypt to track failures
      if (decrypted.subtitleProviders.opensubtitles) {
        if (decrypted.subtitleProviders.opensubtitles.username &&
          (isConfigEncrypted || isEncrypted(decrypted.subtitleProviders.opensubtitles.username))) {
          log.debug(() => '[Encryption] Decrypting OpenSubtitles username');
          decrypted.subtitleProviders.opensubtitles.username =
            safeDecrypt(decrypted.subtitleProviders.opensubtitles.username, 'opensubtitles.username');
        }
        if (decrypted.subtitleProviders.opensubtitles.password &&
          (isConfigEncrypted || isEncrypted(decrypted.subtitleProviders.opensubtitles.password))) {
          log.debug(() => '[Encryption] Decrypting OpenSubtitles password');
          decrypted.subtitleProviders.opensubtitles.password =
            safeDecrypt(decrypted.subtitleProviders.opensubtitles.password, 'opensubtitles.password');
        }
      }

      // SubDL API key
      if (decrypted.subtitleProviders.subdl?.apiKey) {
        const subdlKeyEncrypted = isEncrypted(decrypted.subtitleProviders.subdl.apiKey);
        log.debug(() => `[Encryption] SubDL API key exists, encrypted: ${subdlKeyEncrypted}, will decrypt: ${isConfigEncrypted || subdlKeyEncrypted}`);
        if (isConfigEncrypted || subdlKeyEncrypted) {
          decrypted.subtitleProviders.subdl.apiKey =
            safeDecrypt(decrypted.subtitleProviders.subdl.apiKey, 'subdl.apiKey');
          const isString = typeof decrypted.subtitleProviders.subdl.apiKey === 'string';
          log.debug(() => `[Encryption] SubDL key decrypted successfully, type: ${isString ? 'string' : 'NOT_STRING'}`);
        }
      }

      // SubSource API key
      if (decrypted.subtitleProviders.subsource?.apiKey) {
        const subsourceKeyEncrypted = isEncrypted(decrypted.subtitleProviders.subsource.apiKey);
        log.debug(() => `[Encryption] SubSource API key exists, encrypted: ${subsourceKeyEncrypted}, will decrypt: ${isConfigEncrypted || subsourceKeyEncrypted}`);
        if (isConfigEncrypted || subsourceKeyEncrypted) {
          decrypted.subtitleProviders.subsource.apiKey =
            safeDecrypt(decrypted.subtitleProviders.subsource.apiKey, 'subsource.apiKey');
          const isString = typeof decrypted.subtitleProviders.subsource.apiKey === 'string';
          log.debug(() => `[Encryption] SubSource key decrypted successfully, type: ${isString ? 'string' : 'NOT_STRING'}`);
        }
      }

      // Subs.ro API key
      if (decrypted.subtitleProviders.subsro?.apiKey) {
        const subsroKeyEncrypted = isEncrypted(decrypted.subtitleProviders.subsro.apiKey);
        log.debug(() => `[Encryption] Subs.ro API key exists, encrypted: ${subsroKeyEncrypted}, will decrypt: ${isConfigEncrypted || subsroKeyEncrypted}`);
        if (isConfigEncrypted || subsroKeyEncrypted) {
          decrypted.subtitleProviders.subsro.apiKey =
            safeDecrypt(decrypted.subtitleProviders.subsro.apiKey, 'subsro.apiKey');
          const isString = typeof decrypted.subtitleProviders.subsro.apiKey === 'string';
          log.debug(() => `[Encryption] Subs.ro key decrypted successfully, type: ${isString ? 'string' : 'NOT_STRING'}`);
        }
      }
    }

    // Decrypt alternative AI provider API keys
    if (decrypted.providers && typeof decrypted.providers === 'object') {
      for (const [key, provider] of Object.entries(decrypted.providers)) {
        if (provider && provider.apiKey) {
          const isEnc = isEncrypted(provider.apiKey);
          if (isConfigEncrypted || isEnc) {
            decrypted.providers[key].apiKey = safeDecrypt(provider.apiKey, `providers.${key}.apiKey`);
          }
        }
      }
    }

    // Remove encryption marker
    delete decrypted._encrypted;

    // Add warning flag if any decryption failed (helps diagnose encryption key mismatches)
    if (decryptionWarnings.length > 0) {
      decrypted.__decryptionWarning = true;
      decrypted.__decryptionWarningFields = [...decryptionWarnings];
      log.warn(() => `[Encryption] Decryption warnings detected for fields: ${decryptionWarnings.join(', ')}. This may indicate encryption key mismatch between server instances.`);
    }

    return decrypted;
  } catch (error) {
    log.error(() => ['[Encryption] Failed to decrypt user config:', error.message]);
    // Return original config on error for backward compatibility
    return config;
  }
}

// Get current decryption warnings (useful for debugging)
function getDecryptionWarnings() {
  return [...decryptionWarnings];
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted,
  encryptUserConfig,
  decryptUserConfig,
  getEncryptionKey,
  getDecryptionWarnings
};
