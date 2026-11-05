// Typed errors for the AI judgment layer. Messages are written to be safe to show and log:
// they never contain the API key, request headers or full provider error bodies.
//
// codes: NO_API_KEY | UNKNOWN_PROVIDER | AUTH | RATE_LIMIT | HTTP_ERROR | NETWORK | TIMEOUT | BAD_RESPONSE
//        | TRUNCATED (the reply hit the output limit; batch remediation retries with fewer issues per request)

class AiError extends Error {
  constructor(code, message, extra) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    if (extra && extra.status !== undefined) this.status = extra.status;
  }
}

module.exports = { AiError };
