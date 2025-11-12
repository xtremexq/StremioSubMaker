#!/usr/bin/env node
/**
 * Test script for encryption functionality
 *
 * This script tests:
 * 1. Basic encryption/decryption
 * 2. User config encryption
 * 3. Session manager integration
 * 4. Backward compatibility with unencrypted data
 */

const {
  encrypt,
  decrypt,
  isEncrypted,
  encryptUserConfig,
  decryptUserConfig
} = require('./src/utils/encryption');

console.log('='.repeat(60));
console.log('Testing Encryption Functionality');
console.log('='.repeat(60));
console.log();

// Test 1: Basic encryption/decryption
console.log('Test 1: Basic Encryption/Decryption');
console.log('-'.repeat(60));
try {
  const originalText = 'This is a secret API key: sk-1234567890abcdef';
  console.log('Original:', originalText);

  const encrypted = encrypt(originalText);
  console.log('Encrypted:', encrypted);
  console.log('Is encrypted?', isEncrypted(encrypted));

  const decrypted = decrypt(encrypted, false);
  console.log('Decrypted:', decrypted);

  if (originalText === decrypted) {
    console.log('✅ PASS: Encryption/decryption works correctly');
  } else {
    console.error('❌ FAIL: Decrypted text does not match original');
    process.exit(1);
  }
} catch (error) {
  console.error('❌ FAIL:', error.message);
  process.exit(1);
}
console.log();

// Test 2: Object encryption/decryption
console.log('Test 2: Object Encryption/Decryption');
console.log('-'.repeat(60));
try {
  const originalObject = {
    apiKey: 'test-key-123',
    username: 'testuser',
    password: 'testpass'
  };
  console.log('Original:', JSON.stringify(originalObject, null, 2));

  const encrypted = encrypt(originalObject);
  console.log('Encrypted:', encrypted);

  const decrypted = decrypt(encrypted, false);
  console.log('Decrypted:', JSON.stringify(decrypted, null, 2));

  if (JSON.stringify(originalObject) === JSON.stringify(decrypted)) {
    console.log('✅ PASS: Object encryption/decryption works correctly');
  } else {
    console.error('❌ FAIL: Decrypted object does not match original');
    process.exit(1);
  }
} catch (error) {
  console.error('❌ FAIL:', error.message);
  process.exit(1);
}
console.log();

// Test 3: User config encryption
console.log('Test 3: User Config Encryption');
console.log('-'.repeat(60));
try {
  const originalConfig = {
    geminiApiKey: 'AIzaSyTest1234567890',
    geminiModel: 'gemini-flash-lite-latest',
    sourceLanguages: ['eng'],
    targetLanguages: ['spa', 'fre'],
    subtitleProviders: {
      opensubtitles: {
        enabled: true,
        username: 'myuser',
        password: 'mypassword'
      },
      subdl: {
        enabled: true,
        apiKey: 'subdl-key-123'
      },
      subsource: {
        enabled: true,
        apiKey: 'subsource-key-456'
      }
    }
  };

  console.log('Original config (sensitive fields):');
  console.log('  - geminiApiKey:', originalConfig.geminiApiKey);
  console.log('  - opensubtitles.username:', originalConfig.subtitleProviders.opensubtitles.username);
  console.log('  - opensubtitles.password:', originalConfig.subtitleProviders.opensubtitles.password);
  console.log('  - subdl.apiKey:', originalConfig.subtitleProviders.subdl.apiKey);

  const encryptedConfig = encryptUserConfig(originalConfig);
  console.log('\nEncrypted config (sensitive fields):');
  console.log('  - geminiApiKey:', encryptedConfig.geminiApiKey.substring(0, 50) + '...');
  console.log('  - opensubtitles.username:', encryptedConfig.subtitleProviders.opensubtitles.username.substring(0, 50) + '...');
  console.log('  - opensubtitles.password:', encryptedConfig.subtitleProviders.opensubtitles.password.substring(0, 50) + '...');
  console.log('  - subdl.apiKey:', encryptedConfig.subtitleProviders.subdl.apiKey.substring(0, 50) + '...');
  console.log('  - _encrypted marker:', encryptedConfig._encrypted);

  // Verify fields are encrypted
  if (!isEncrypted(encryptedConfig.geminiApiKey) ||
      !isEncrypted(encryptedConfig.subtitleProviders.opensubtitles.username) ||
      !isEncrypted(encryptedConfig.subtitleProviders.opensubtitles.password) ||
      !isEncrypted(encryptedConfig.subtitleProviders.subdl.apiKey)) {
    console.error('❌ FAIL: Some fields were not encrypted');
    process.exit(1);
  }

  const decryptedConfig = decryptUserConfig(encryptedConfig);
  console.log('\nDecrypted config (sensitive fields):');
  console.log('  - geminiApiKey:', decryptedConfig.geminiApiKey);
  console.log('  - opensubtitles.username:', decryptedConfig.subtitleProviders.opensubtitles.username);
  console.log('  - opensubtitles.password:', decryptedConfig.subtitleProviders.opensubtitles.password);
  console.log('  - subdl.apiKey:', decryptedConfig.subtitleProviders.subdl.apiKey);

  // Verify decrypted matches original (except _encrypted marker)
  if (decryptedConfig.geminiApiKey === originalConfig.geminiApiKey &&
      decryptedConfig.subtitleProviders.opensubtitles.username === originalConfig.subtitleProviders.opensubtitles.username &&
      decryptedConfig.subtitleProviders.opensubtitles.password === originalConfig.subtitleProviders.opensubtitles.password &&
      decryptedConfig.subtitleProviders.subdl.apiKey === originalConfig.subtitleProviders.subdl.apiKey &&
      !decryptedConfig._encrypted) {
    console.log('✅ PASS: User config encryption/decryption works correctly');
  } else {
    console.error('❌ FAIL: Decrypted config does not match original');
    process.exit(1);
  }
} catch (error) {
  console.error('❌ FAIL:', error.message);
  console.error(error.stack);
  process.exit(1);
}
console.log();

// Test 4: Backward compatibility with unencrypted data
console.log('Test 4: Backward Compatibility');
console.log('-'.repeat(60));
try {
  const unencryptedConfig = {
    geminiApiKey: 'AIzaSyTest1234567890',
    subtitleProviders: {
      opensubtitles: {
        enabled: true,
        username: 'olduser',
        password: 'oldpass'
      }
    }
  };

  console.log('Unencrypted config (simulating old data)');
  console.log('  - geminiApiKey:', unencryptedConfig.geminiApiKey);

  // Try to decrypt unencrypted data (should return as-is)
  const result = decryptUserConfig(unencryptedConfig);
  console.log('After decryptUserConfig (should be unchanged):');
  console.log('  - geminiApiKey:', result.geminiApiKey);

  if (result.geminiApiKey === unencryptedConfig.geminiApiKey &&
      result.subtitleProviders.opensubtitles.username === unencryptedConfig.subtitleProviders.opensubtitles.username) {
    console.log('✅ PASS: Backward compatibility works correctly');
  } else {
    console.error('❌ FAIL: Unencrypted data was corrupted');
    process.exit(1);
  }
} catch (error) {
  console.error('❌ FAIL:', error.message);
  process.exit(1);
}
console.log();

// Test 5: Session Manager Integration (optional - requires dependencies)
console.log('Test 5: Session Manager Integration');
console.log('-'.repeat(60));
try {
  const { SessionManager } = require('./src/utils/sessionManager');

  // Create temporary session manager
  const tempDir = require('path').join(process.cwd(), '.cache', 'test-sessions');
  require('fs').mkdirSync(tempDir, { recursive: true });

  const sessionManager = new SessionManager({
    persistencePath: require('path').join(tempDir, 'test-sessions.json')
  });

  const testConfig = {
    geminiApiKey: 'AIzaSyTestSessionManager',
    geminiModel: 'gemini-flash-lite-latest',
    sourceLanguages: ['eng'],
    targetLanguages: ['spa'],
    subtitleProviders: {
      opensubtitles: {
        enabled: true,
        username: 'sessionuser',
        password: 'sessionpass'
      },
      subdl: {
        enabled: true,
        apiKey: 'session-subdl-key'
      }
    }
  };

  // Create session
  console.log('Creating session with test config...');
  const token = sessionManager.createSession(testConfig);
  console.log('Session token:', token);

  // Retrieve session
  console.log('Retrieving session...');
  const retrievedConfig = sessionManager.getSession(token);

  console.log('\nOriginal config:');
  console.log('  - geminiApiKey:', testConfig.geminiApiKey);
  console.log('  - opensubtitles.password:', testConfig.subtitleProviders.opensubtitles.password);
  console.log('  - subdl.apiKey:', testConfig.subtitleProviders.subdl.apiKey);

  console.log('\nRetrieved config:');
  console.log('  - geminiApiKey:', retrievedConfig.geminiApiKey);
  console.log('  - opensubtitles.password:', retrievedConfig.subtitleProviders.opensubtitles.password);
  console.log('  - subdl.apiKey:', retrievedConfig.subtitleProviders.subdl.apiKey);

  // Verify retrieved config matches original
  if (retrievedConfig.geminiApiKey === testConfig.geminiApiKey &&
      retrievedConfig.subtitleProviders.opensubtitles.password === testConfig.subtitleProviders.opensubtitles.password &&
      retrievedConfig.subtitleProviders.subdl.apiKey === testConfig.subtitleProviders.subdl.apiKey) {
    console.log('✅ PASS: Session manager encryption/decryption works correctly');
  } else {
    console.error('❌ FAIL: Retrieved config does not match original');
    process.exit(1);
  }

  // Clean up
  require('fs').rmSync(tempDir, { recursive: true, force: true });
} catch (error) {
  if (error.code === 'MODULE_NOT_FOUND') {
    console.log('⚠️  SKIP: Session manager test skipped (dependencies not installed)');
    console.log('   Run "npm install" and then test with the actual server');
  } else {
    console.error('❌ FAIL:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}
console.log();

console.log('='.repeat(60));
console.log('✅ All tests passed!');
console.log('='.repeat(60));
console.log();
console.log('Encryption is working correctly. User data will be encrypted at rest.');
