// @vitest-environment node
//
// Une signature fausse rend un 403 côté Bedrock, jamais un test rouge : la
// seule protection est un vecteur à réponse connue, ancré sur un tiers
// indépendant plutôt que sur ce que ce module croit produire.
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
  it("retrouve l'exemple travaillé de la doc AWS SigV4 (us-east-1/iam/20150830)", () => {
    // Ancre externe, publiée par AWS et calculée hors de ce module : sans
    // elle, une chaîne d'HMAC inversée ou mal enchaînée passerait tous les
    // autres tests, qui ne font que comparer à leur propre sortie.
    const key = signingKey('wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830', 'us-east-1', 'iam');
    expect(key.toString('hex')).toBe('c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
  });
});

describe('signRequest', () => {
  it('signe une requête sans jeton de session', () => {
    const headers = sign();
    expect(headers['x-amz-security-token']).toBeUndefined();
    expect(headers.authorization).toBe(
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/eu-north-1/bedrock/aws4_request, ' +
        'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, ' +
        'Signature=099341f22a8d809dac1ef22c2f8bc81c0706bd9f8292fde080e1f8fc870795db',
    );
  });

  it('ajoute x-amz-security-token à signedHeaders quand un jeton est fourni, et change la signature', () => {
    const withToken = sign({ credentials: { ...credentials, sessionToken: 'FQoGZXIvYXdzEXAMPLETOKEN' } });
    const withoutToken = sign();
    expect(withToken['x-amz-security-token']).toBe('FQoGZXIvYXdzEXAMPLETOKEN');
    expect(withToken.authorization).toContain(
      'SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date;x-amz-security-token',
    );
    expect(withoutToken.authorization).not.toContain('x-amz-security-token');
    expect(withToken.authorization).not.toBe(withoutToken.authorization);
  });

  it('un jeton vide compte comme absent', () => {
    const headers = sign({ credentials: { ...credentials, sessionToken: '' } });
    expect(headers['x-amz-security-token']).toBeUndefined();
    expect(headers.authorization).not.toContain('x-amz-security-token');
  });

  it('hache le corps en UTF-8, accents compris', () => {
    const accented = JSON.stringify({ text: '« régression »' });
    const headers = sign({ body: accented });
    expect(headers['x-amz-content-sha256']).toBe(createHash('sha256').update(accented, 'utf8').digest('hex'));
  });

  it('deux appels avec le même now rendent la même signature', () => {
    expect(sign().authorization).toBe(sign().authorization);
  });

  it('un now différent rend une signature différente', () => {
    const later = sign({ now: new Date('2015-08-30T12:37:00Z') });
    expect(later.authorization).not.toBe(sign().authorization);
  });
});
