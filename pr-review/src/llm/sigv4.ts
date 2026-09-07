/**
 * Signature AWS Signature Version 4, calculée à la main : le SDK AWS est une
 * dépendance npm au runtime, interdite par la doctrine du dépôt (voir
 * `.github/copilot-instructions.md`). Module pur — l'appelant fournit `now`
 * et les identifiants, rien n'est lu ni horodaté ici.
 */

import { createHash, createHmac } from 'node:crypto';

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SignArgs {
  method: 'POST';
  /** URL complète, ex. https://bedrock-runtime.eu-north-1.amazonaws.com/openai/v1/chat/completions */
  url: string;
  /** Le corps EXACT qui sera envoyé, octet pour octet. */
  body: string;
  region: string;
  /** Nom de service pour la signature. 'bedrock' pour bedrock-runtime. */
  service: string;
  credentials: AwsCredentials;
  /** Injecté, jamais lu : un test qui dépend de l'heure qu'il est n'est pas un test. */
  now: Date;
}

const sha256Hex = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

const hmac = (key: Buffer | string, data: string): Buffer =>
  createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * Clé de signature dérivée, en quatre HMAC imbriqués (AWS4+secret → date →
 * région → service → aws4_request). Exportée pour l'ancrer sur le vecteur
 * connu de la doc AWS, indépendamment de la signature complète qui en découle.
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

/** Rend les en-têtes HTTP complets, `authorization` incluse. */
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

  // Triés une fois : l'ordre décide à la fois de `signedHeaders` et du bloc
  // canonique, les deux doivent partager exactement le même tri.
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
