/**
 * AWS Signature Version 4, computed by hand: the AWS SDK is an npm runtime
 * dependency, forbidden by the repo doctrine (see
 * `.github/copilot-instructions.md`). Pure module — the caller supplies
 * `now` and the credentials, nothing is read or timestamped here.
 */

import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignArgs {
  method: 'POST';
  /** Full URL, e.g. https://bedrock-runtime.eu-north-1.amazonaws.com/openai/v1/chat/completions */
  url: string;
  /** The EXACT body that will be sent, byte for byte. */
  body: string;
  region: string;
  /** Service name for the signature. 'bedrock' for bedrock-runtime. */
  service: string;
  credentials: AwsCredentials;
  /** Injected, never read: a test that depends on the current time isn't a test. */
  now: Date;
}

const sha256Hex = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * Derived signing key, four nested HMACs (AWS4+secret → date → region →
 * service → aws4_request). Exported to anchor it on the known vector from
 * the AWS docs, independently of the full signature that follows from it.
 */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** Returns the complete HTTP headers, `authorization` included. */
export function signRequest(args: SignArgs): Record<string, string> {
  const { method, url, body, region, service, credentials, now } = args;
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const { hostname, pathname } = new URL(url);
  const payloadHash = sha256Hex(body);

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    host: hostname,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken;

  // Sorted once: the order decides both `signedHeaders` and the canonical
  // block, and the two must share the exact same sort.
  const entries = Object.entries(headers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = entries.map(([name]) => name).join(';');
  const canonicalHeaders = entries.map(([name, value]) => `${name}:${value.trim()}\n`).join('');

  const canonicalRequest = [method, pathname, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256Hex(canonicalRequest)].join('\n');

  const signature = createHmac('sha256', signingKey(credentials.secretAccessKey, dateStamp, region, service))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
