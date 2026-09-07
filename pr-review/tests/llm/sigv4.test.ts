// @vitest-environment node
//
// A wrong signature returns a 403 from Bedrock, never a red test: the only
// protection is a known-answer vector, anchored on an independent third
// party rather than on what this module believes it produces.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { signingKey, signRequest } from '../../src/llm/sigv4';

const url = 'https://bedrock-runtime.eu-north-1.amazonaws.com/openai/v1/chat/completions';
const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};
const now = new Date('2015-08-30T12:36:00Z');
const body = JSON.stringify({ model: 'x', messages: [] });

const sign = (over: Partial<Parameters<typeof signRequest>[0]> = {}) =>
  signRequest({ method: 'POST', url, body, region: 'eu-north-1', service: 'bedrock', credentials, now, ...over });

describe('signingKey', () => {
  it('reproduces the worked example from the AWS SigV4 docs (us-east-1/iam/20150830)', () => {
    // External anchor, published by AWS and computed outside this module:
    // without it, a reversed or misordered HMAC chain would pass every
    // other test, which only compare against their own output.
    const key = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
    expect(key.toString('hex')).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  });
});

describe('signRequest', () => {
  it('signs a request without a session token', () => {
    const headers = sign();
    expect(headers['x-amz-security-token']).toBeUndefined();
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/eu-north-1/bedrock/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=099341f22a8d809dac1ef22c2f8bc81c0706bd9f8292fde080e1f8fc870795db',
    );
  });

  it('adds x-amz-security-token to signedHeaders when a token is given, and changes the signature', () => {
    const withToken = sign({ credentials: { ...credentials, sessionToken: 'FQoGZXIvYXdzEXAMPLETOKEN' } });
    const withoutToken = sign();
    expect(withToken['x-amz-security-token']).toBe('FQoGZXIvYXdzEXAMPLETOKEN');
    expect(withToken.authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
    );
    expect(withoutToken.authorization).not.toContain('x-amz-security-token');
    expect(withToken.authorization).not.toBe(withoutToken.authorization);
  });

  it('an empty token counts as absent', () => {
    const headers = sign({ credentials: { ...credentials, sessionToken: '' } });
    expect(headers['x-amz-security-token']).toBeUndefined();
    expect(headers.authorization).not.toContain('x-amz-security-token');
  });

  it('hashes the body as UTF-8, accents included', () => {
    const accented = JSON.stringify({ text: '« régression »' });
    const headers = sign({ body: accented });
    expect(headers['x-amz-content-sha256']).toBe(createHash('sha256').update(accented, 'utf8').digest('hex'));
  });

  it('two calls with the same now produce the same signature', () => {
    expect(sign().authorization).toBe(sign().authorization);
  });

  it('a different now produces a different signature', () => {
    const later = sign({ now: new Date('2015-08-30T12:37:00Z') });
    expect(later.authorization).not.toBe(sign().authorization);
  });
});
