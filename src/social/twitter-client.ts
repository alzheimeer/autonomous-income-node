/**
 * TwitterClient
 *
 * Thin wrapper around the Twitter API v2 using axios (no heavy SDK).
 * - postTweet: POST /2/tweets con OAuth 1.0a HMAC-SHA1 completo
 * - Mock mode when TWITTER_API_KEY is empty — logs but does not publish.
 *
 * Requirements: 8.1, 8.5
 */

import axios from 'axios';
import { createHmac } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TweetResult {
  tweetId: string;
  mockMode: boolean;
}

// ---------------------------------------------------------------------------
// TwitterClient
// ---------------------------------------------------------------------------

export class TwitterClient {
  private readonly apiKey: string;
  private readonly apiKeySecret: string;
  private readonly accessToken: string;
  private readonly accessTokenSecret: string;
  private readonly bearerToken: string;
  private readonly isMock: boolean;

  constructor() {
    this.apiKey = process.env['TWITTER_API_KEY'] ?? '';
    // Soporta tanto TWITTER_API_SECRET como TWITTER_API_KEY_SECRET
    this.apiKeySecret =
      process.env['TWITTER_API_SECRET'] ??
      process.env['TWITTER_API_KEY_SECRET'] ??
      '';
    this.accessToken = process.env['TWITTER_ACCESS_TOKEN'] ?? '';
    // Soporta tanto TWITTER_ACCESS_SECRET como TWITTER_ACCESS_TOKEN_SECRET
    this.accessTokenSecret =
      process.env['TWITTER_ACCESS_SECRET'] ??
      process.env['TWITTER_ACCESS_TOKEN_SECRET'] ??
      '';
    this.bearerToken = process.env['TWITTER_BEARER_TOKEN'] ?? '';

    // Mock mode when primary credential is missing
    this.isMock = this.apiKey.trim() === '';
  }

  /**
   * Post a tweet.
   * In mock mode (no TWITTER_API_KEY): logs the content and returns a mock ID.
   * Requirement: 8.1
   */
  async postTweet(content: string): Promise<TweetResult> {
    if (this.isMock) {
      const mockId = `mock_${Date.now()}`;
      console.log(`[TwitterClient] MOCK MODE — would post: "${content}" (id=${mockId})`);
      return { tweetId: mockId, mockMode: true };
    }

    const url = 'https://api.twitter.com/2/tweets';
    const body = { text: content };
    const authHeader = this.buildOAuth1Header('POST', url, {});

    const response = await axios.post<{ data: { id: string } }>(
      url,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: authHeader,
        },
        timeout: 15_000,
      }
    );

    const tweetId = response.data?.data?.id;
    if (!tweetId) {
      throw new Error('Twitter API returned no tweet ID');
    }

    return { tweetId, mockMode: false };
  }

  // ---------------------------------------------------------------------------
  // OAuth 1.0a — HMAC-SHA1 completo (RFC 5849)
  // ---------------------------------------------------------------------------

  /**
   * Genera un Authorization header OAuth 1.0a con firma HMAC-SHA1 correcta.
   * Este es el único método válido para postear tweets con user context en v2.
   *
   * @param method  - HTTP method (POST, GET, etc.)
   * @param url     - URL base sin query params
   * @param params  - Query params adicionales a incluir en la firma (vacío para tweets)
   */
  private buildOAuth1Header(
    method: string,
    url: string,
    params: Record<string, string>,
  ): string {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = this.generateNonce();

    // Parámetros OAuth base
    const oauthParams: Record<string, string> = {
      oauth_consumer_key: this.apiKey,
      oauth_nonce: nonce,
      oauth_signature_method: 'HMAC-SHA1',
      oauth_timestamp: timestamp,
      oauth_token: this.accessToken,
      oauth_version: '1.0',
    };

    // Combinar todos los parámetros para la firma
    const allParams: Record<string, string> = { ...params, ...oauthParams };

    // Paso 1: Construir la cadena de parámetros (ordenada, URL-encoded)
    const paramString = Object.keys(allParams)
      .sort()
      .map((key) => `${this.percentEncode(key)}=${this.percentEncode(allParams[key]!)}`)
      .join('&');

    // Paso 2: Construir la base de la firma
    const signatureBase = [
      method.toUpperCase(),
      this.percentEncode(url),
      this.percentEncode(paramString),
    ].join('&');

    // Paso 3: Construir la clave de firma
    const signingKey = `${this.percentEncode(this.apiKeySecret)}&${this.percentEncode(this.accessTokenSecret)}`;

    // Paso 4: Calcular HMAC-SHA1
    const signature = createHmac('sha1', signingKey)
      .update(signatureBase)
      .digest('base64');

    oauthParams['oauth_signature'] = signature;

    // Paso 5: Construir el header Authorization
    const headerValue = 'OAuth ' + Object.keys(oauthParams)
      .sort()
      .map((key) => `${this.percentEncode(key)}="${this.percentEncode(oauthParams[key]!)}"`)
      .join(', ');

    return headerValue;
  }

  /** RFC 3986 percent-encoding */
  private percentEncode(str: string): string {
    return encodeURIComponent(str)
      .replace(/!/g, '%21')
      .replace(/'/g, '%27')
      .replace(/\(/g, '%28')
      .replace(/\)/g, '%29')
      .replace(/\*/g, '%2A');
  }

  /** Genera un nonce aleatorio de 32 caracteres alfanuméricos */
  private generateNonce(): string {
    return Math.random().toString(36).substring(2) +
      Math.random().toString(36).substring(2) +
      Date.now().toString(36);
  }
}
