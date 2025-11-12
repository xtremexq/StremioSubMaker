# User Data Encryption

## Overview

StremioSubMaker now implements **AES-256-GCM encryption** for all sensitive user data stored in both Redis and filesystem storage. This ensures that API keys, passwords, and other credentials are encrypted at rest.

## What is Encrypted

The following sensitive fields are automatically encrypted:
- **Gemini API Key** (`geminiApiKey`)
- **OpenSubtitles Credentials** (`subtitleProviders.opensubtitles.username`, `password`)
- **SubDL API Key** (`subtitleProviders.subdl.apiKey`)
- **SubSource API Key** (`subtitleProviders.subsource.apiKey`)
- **Podnapisi API Key** (`subtitleProviders.podnapisi.apiKey`)

## Encryption Method

- **Algorithm**: AES-256-GCM (Galois/Counter Mode)
- **Key Size**: 256 bits (32 bytes)
- **Features**:
  - Authenticated encryption (confidentiality + integrity)
  - Random IV (Initialization Vector) for each encryption
  - Authentication tag to detect tampering
  - Backward compatible with existing unencrypted data

## Key Management

### Environment Variable (Recommended for Production)

Set the `ENCRYPTION_KEY` environment variable in your `.env` file:

```bash
# Generate a key using Node.js
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Add to .env
ENCRYPTION_KEY=your_64_character_hex_string_here
```

### Auto-Generated Key (Development)

If `ENCRYPTION_KEY` is not set, the system will:
1. Generate a random 256-bit encryption key
2. Save it to `.encryption-key` file in the project root
3. Load it automatically on subsequent startups

**⚠️ IMPORTANT**: Back up this file! Loss of the encryption key means loss of encrypted data.

## Storage Adapters

Encryption is transparently integrated with both storage adapters:

### Redis Storage
- User configs are encrypted before storing in Redis
- Decrypted automatically when retrieved
- Works seamlessly with existing Redis operations

### Filesystem Storage
- User configs are encrypted before saving to disk
- Decrypted automatically when loaded
- Session files contain encrypted credentials

## Backward Compatibility

The encryption implementation is **fully backward compatible**:

1. **Unencrypted Data**: Old unencrypted sessions are automatically detected and still work
2. **Migration**: When old data is loaded, it's automatically encrypted on next save
3. **No Breaking Changes**: Existing installations upgrade seamlessly

## Security Best Practices

### Production Deployment

1. **Use Environment Variable**: Always set `ENCRYPTION_KEY` in production
   ```bash
   ENCRYPTION_KEY=<64-char-hex-string>
   ```

2. **Secure Key Storage**: Store the encryption key securely (e.g., AWS Secrets Manager, HashiCorp Vault)

3. **Key Rotation**: To rotate keys:
   - Generate a new encryption key
   - Decrypt all sessions with old key
   - Re-encrypt with new key
   - Update `ENCRYPTION_KEY` environment variable

4. **Backup**: Always back up your encryption key separately from your data

### Development

1. **Auto-Generated Key**: The `.encryption-key` file is automatically created
2. **Gitignore**: The `.encryption-key` file is excluded from version control
3. **Testing**: Run `node test-encryption.js` to verify encryption works correctly

## Implementation Details

### Encryption Format

Encrypted data format: `version:iv:authTag:ciphertext` (all base64 encoded)

Example:
```
1:dg+wNhcw45wLNefSIX+4Jg==:huqC+8TmJQCVWMB5sb/i4Q==:VPTv7felwus/lyhG+a3W...
```

- **version**: Encryption format version (currently `1` for AES-256-GCM)
- **iv**: Initialization Vector (16 bytes, base64)
- **authTag**: Authentication tag (16 bytes, base64)
- **ciphertext**: Encrypted data (base64)

### Files Modified

- `src/utils/encryption.js` - Core encryption/decryption utilities
- `src/utils/sessionManager.js` - Integrated encryption in session operations
- `.env.example` - Added `ENCRYPTION_KEY` documentation
- `.gitignore` - Added `.encryption-key` exclusion
- `test-encryption.js` - Comprehensive encryption tests

### Testing

Run the encryption test suite:

```bash
node test-encryption.js
```

The test verifies:
- ✅ Basic encryption/decryption
- ✅ Object encryption/decryption
- ✅ User config encryption (all sensitive fields)
- ✅ Backward compatibility with unencrypted data
- ✅ Session manager integration

## Troubleshooting

### Lost Encryption Key

If you lose your encryption key:
- **Encrypted sessions cannot be recovered**
- Users will need to reconfigure their addons
- Prevention: Always back up your `.encryption-key` file or `ENCRYPTION_KEY` value

### Key Mismatch

If you see decryption errors:
1. Check that `ENCRYPTION_KEY` matches the key used to encrypt the data
2. Verify the `.encryption-key` file hasn't been corrupted
3. Check for permission issues reading the key file

### Testing Encryption

```bash
# Test basic encryption
node test-encryption.js

# Check if encryption key exists
ls -la .encryption-key

# Verify encryption key format (should be 64 hex characters)
cat .encryption-key | wc -c  # Should output 65 (64 chars + newline)
```

## FAQ

**Q: Does encryption affect performance?**
A: Minimal impact. Encryption/decryption happens only during session creation/retrieval, not during subtitle operations.

**Q: Can I use Redis with encryption?**
A: Yes! Encryption works seamlessly with both Redis and filesystem storage adapters.

**Q: What happens to old unencrypted sessions?**
A: They continue to work normally. On their next update/save, they'll be automatically encrypted.

**Q: Is this required?**
A: Encryption is automatic and transparent. No configuration needed beyond setting the key in production.

## Support

For issues or questions about encryption:
1. Check the test output: `node test-encryption.js`
2. Review logs for `[Encryption]` messages
3. Verify your encryption key is properly configured
