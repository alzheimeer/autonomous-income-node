/**
 * Log filter / secret masker for Autonomous Income Node.
 *
 * Prevents plaintext secrets from reaching log output by replacing them with
 * a redacted placeholder. The filter is applied at the string level so it
 * works regardless of the logging library in use.
 *
 * Patterns masked:
 *  1. Ethereum private keys  — 0x followed by exactly 64 hex characters
 *  2. High-entropy strings   — ASCII-printable tokens longer than 20 chars
 *     that look like API keys / passwords (heuristic: Shannon entropy > 3.5)
 *  3. BIP-39 mnemonics       — sequences of 12 or 24 known English words
 *     separated by single spaces
 *
 * Requirements: 14.1
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Redaction placeholder
// ---------------------------------------------------------------------------

export const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// Pattern 1: Ethereum private key  (0x + 64 hex digits)
// ---------------------------------------------------------------------------

const ETHEREUM_PRIVATE_KEY_RE = /\b0x[0-9a-fA-F]{64}\b/g;

// ---------------------------------------------------------------------------
// Pattern 3: BIP-39 mnemonic (12 or 24 space-separated known words)
// BIP-39 English word list contains 2048 words; we use a partial heuristic:
// a sequence of 12 or 24 lowercase alpha tokens of 3–8 chars each.
// ---------------------------------------------------------------------------

/**
 * Matches sequences of exactly 12 or 24 lowercase English word-like tokens
 * separated by single spaces.  The word boundary ensures we don't match
 * arbitrary prose inside longer words.
 *
 * The regex deliberately avoids loading the full 2048-word wordlist to keep
 * startup cost low.  False negatives are acceptable; false positives in log
 * output are not a security risk (masking too much is better than too little).
 */
const BIP39_WORD_TOKEN = '[a-z]{3,8}';
// 12-word mnemonic
const MNEMONIC_12_RE = new RegExp(
  `(?<![\\w])${BIP39_WORD_TOKEN}(?:\\s+${BIP39_WORD_TOKEN}){11}(?![\\w])`,
  'g',
);
// 24-word mnemonic
const MNEMONIC_24_RE = new RegExp(
  `(?<![\\w])${BIP39_WORD_TOKEN}(?:\\s+${BIP39_WORD_TOKEN}){23}(?![\\w])`,
  'g',
);

// ---------------------------------------------------------------------------
// Pattern 2: High-entropy strings (API keys / passwords)
// ---------------------------------------------------------------------------

/**
 * Minimum length for a token to be considered a potential API key / password.
 * Shorter tokens are unlikely to be secrets even at high entropy.
 */
const MIN_SECRET_LENGTH = 20;

/**
 * Shannon entropy threshold above which a token is considered a secret.
 * Most natural-language words sit around 2.5–3.0 bits/char; random
 * alphanumeric strings with mixed case and special characters are usually
 * above 4.0 bits/char.
 */
const ENTROPY_THRESHOLD = 3.5;

/**
 * Regex that finds candidate tokens: runs of non-whitespace, non-comma,
 * non-bracket characters that are at least MIN_SECRET_LENGTH chars long.
 *
 * We explicitly exclude tokens that look like URLs (contain ://) to avoid
 * masking legitimate RPC / HTTP URLs in log messages.
 */
const CANDIDATE_TOKEN_RE = /[^\s,\[\]{}"'`|<>\\]{20,}/g;

/**
 * Regex to detect URL-like tokens that should not be treated as secrets
 * even if they are long / high-entropy.
 */
const URL_LIKE_RE = /^https?:\/\//i;

/**
 * Calculates the Shannon entropy (bits per character) of a string.
 *
 * @param s  Input string.
 * @returns  Shannon entropy in bits/char.
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;

  const freq = new Map<string, number>();
  for (const ch of s) {
    freq.set(ch, (freq.get(ch) ?? 0) + 1);
  }

  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Returns true if `token` looks like an API key or password based on its
 * length and Shannon entropy.
 *
 * Tokens that look like URLs are explicitly excluded since they often contain
 * high-entropy substrings (path segments, UUIDs) that are not secrets.
 *
 * @param token  Candidate token string.
 */
function isHighEntropySecret(token: string): boolean {
  // Don't mask URL-like strings
  if (URL_LIKE_RE.test(token)) return false;
  return token.length >= MIN_SECRET_LENGTH && shannonEntropy(token) > ENTROPY_THRESHOLD;
}

// ---------------------------------------------------------------------------
// Keyword-based masking for named secret fields
// ---------------------------------------------------------------------------

/**
 * Matches common key=value or key:value patterns where the key name suggests
 * the value is a secret (password, private_key, secret, token, mnemonic, etc.).
 *
 * Uses a broad pattern that handles both plain key=value and JSON "key": "value"
 * formats, including keys with underscores like WALLET_PASSWORD.
 *
 * Groups: [full-match, key-part, value-part]
 */
const NAMED_SECRET_RE =
  /([A-Za-z_]*(?:password|passwd|private_?key|api_?key|secret|token|mnemonic|seed_?phrase|auth_?token|bearer)[A-Za-z_]*)\s*["']?\s*[:=]\s*["']?([^\s"',\]}\)]{8,})["']?/gi;

// ---------------------------------------------------------------------------
// Main masking function
// ---------------------------------------------------------------------------

/**
 * Masks all detectable secrets in `input` and returns the sanitised string.
 *
 * The function is intentionally conservative: it may mask some non-secret
 * strings that happen to look like secrets (false positives are acceptable).
 *
 * @param input  Raw log string that may contain secrets.
 * @returns      Sanitised string with secrets replaced by {@link REDACTED}.
 */
export function maskSecrets(input: string): string {
  if (typeof input !== 'string' || input.length === 0) return input;

  let output = input;

  // 1. Named key=value patterns first (most specific, highest confidence)
  output = output.replace(
    NAMED_SECRET_RE,
    (_match, key: string, _value: string) => `${key}=${REDACTED}`,
  );

  // 2. Ethereum private keys (deterministic pattern)
  output = output.replace(ETHEREUM_PRIVATE_KEY_RE, REDACTED);

  // 3. BIP-39 mnemonics — 24-word first (more specific), then 12-word
  output = output.replace(MNEMONIC_24_RE, REDACTED);
  output = output.replace(MNEMONIC_12_RE, REDACTED);

  // 4. High-entropy candidate tokens
  output = output.replace(CANDIDATE_TOKEN_RE, (match) => {
    return isHighEntropySecret(match) ? REDACTED : match;
  });

  return output;
}

// ---------------------------------------------------------------------------
// Safe log-line builder
// ---------------------------------------------------------------------------

/**
 * Serialises an arbitrary value to a string safe for logging.
 * Objects are JSON-serialised; the result is then passed through
 * {@link maskSecrets}.
 *
 * @param value  Any value to safely stringify.
 * @returns      Redacted string representation.
 */
export function safeStringify(value: unknown): string {
  let raw: string;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    raw = String(value);
  }
  return maskSecrets(raw);
}

// ---------------------------------------------------------------------------
// Fingerprint helper (for non-secret identifying output)
// ---------------------------------------------------------------------------

/**
 * Returns a short SHA-256 hex fingerprint of `secret` (first 8 chars).
 * Useful for distinguishing keys in log output without revealing the value.
 *
 * @param secret  The secret string to fingerprint.
 * @returns       An 8-character hex digest prefix.
 */
export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 8);
}
