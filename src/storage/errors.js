class StorageUnavailableError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'StorageUnavailableError';
    this.isStorageUnavailable = true;
    this.operation = options.operation;
    this.cause = options.cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, StorageUnavailableError);
    }
  }
}

module.exports = { StorageUnavailableError };
