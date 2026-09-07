/**
 * AWS credential resolution, four rungs from most explicit to most ambient:
 * static env, web identity (Kubernetes runners), the `aws` CLI (local
 * profiles, SSO included). No AWS SDK: Node builtins and global `fetch`
 * only.
 */

import { readFileSync } from 'node:fs';
import type { AwsCredentials } from './llm/sigv4';
import { run } from './exec';

const STS_TIMEOUT_MS = 10_000;

/**
 * Resolves AWS credentials, or `null` when the environment offers none.
 */
export async function resolveAwsCredentials(
  env: NodeJS.ProcessEnv,
  region: string,
  warn: (message: string) => void,
): Promise<AwsCredentials | null> {
  const fromEnv = fromStaticEnv(env);
  if (fromEnv) return fromEnv;

  const fromWebIdentity = await fromWebIdentityToken(env, region, warn);
  if (fromWebIdentity) return fromWebIdentity;

  const fromCli = await fromAwsCli(warn);
  if (fromCli) return fromCli;

  warn(
    'no AWS credentials found (neither AWS_ACCESS_KEY_ID, nor web identity, nor `aws configure export-credentials`)',
  );
  return null;
}

function fromStaticEnv(env: NodeJS.ProcessEnv): AwsCredentials | null {
  const accessKeyId = env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY;
  if (!accessKeyId || !secretAccessKey) return null;
  const sessionToken = env.AWS_SESSION_TOKEN;
  return sessionToken ? { accessKeyId, secretAccessKey, sessionToken } : { accessKeyId, secretAccessKey };
}

async function fromWebIdentityToken(
  env: NodeJS.ProcessEnv,
  region: string,
  warn: (message: string) => void,
): Promise<AwsCredentials | null> {
  const tokenFile = env.AWS_WEB_IDENTITY_TOKEN_FILE;
  const roleArn = env.AWS_ROLE_ARN;
  if (!tokenFile || !roleArn) return null;
  if (!region) {
    warn('AWS_WEB_IDENTITY_TOKEN_FILE present but region empty: STS needs a regional endpoint, rung skipped');
    return null;
  }

  let token: string;
  try {
    token = readFileSync(tokenFile, 'utf-8').trim();
  } catch (error) {
    warn(`cannot read AWS_WEB_IDENTITY_TOKEN_FILE (${errorMessage(error)})`);
    return null;
  }

  const body = [
    'Action=AssumeRoleWithWebIdentity',
    'Version=2011-06-15',
    `RoleArn=${encodeURIComponent(roleArn)}`,
    `RoleSessionName=${encodeURIComponent(roleSessionName(env))}`,
    `WebIdentityToken=${encodeURIComponent(token)}`,
  ].join('&');

  try {
    // The only unsigned STS call: it's precisely the one that supplies the
    // credential every other call needs.
    const response = await fetch(`https://sts.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(STS_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      warn(`AssumeRoleWithWebIdentity failed (HTTP ${response.status})`);
      return null;
    }
    const accessKeyId = extractTag(text, 'AccessKeyId');
    const secretAccessKey = extractTag(text, 'SecretAccessKey');
    const sessionToken = extractTag(text, 'SessionToken');
    if (!accessKeyId || !secretAccessKey || !sessionToken) {
      warn('AssumeRoleWithWebIdentity responded without one of the three expected fields');
      return null;
    }
    return { accessKeyId, secretAccessKey, sessionToken };
  } catch (error) {
    warn(`AssumeRoleWithWebIdentity call failed (${errorMessage(error)})`);
    return null;
  }
}

/** 64 chars max, alphanumeric and `[\w+=,.@-]` only (AWS constraint on `RoleSessionName`). */
function roleSessionName(env: NodeJS.ProcessEnv): string {
  const raw = `pr-review-${env.GITHUB_RUN_ID ?? Date.now()}`;
  return raw.replace(/[^\w+=,.@-]/g, '').slice(0, 64);
}

function extractTag(xml: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml);
  return match?.[1] ?? null;
}

async function fromAwsCli(warn: (message: string) => void): Promise<AwsCredentials | null> {
  try {
    const output = await run('aws', ['configure', 'export-credentials', '--format', 'process']);
    const parsed = JSON.parse(output) as {
      AccessKeyId?: string;
      SecretAccessKey?: string;
      SessionToken?: string;
    };
    if (!parsed.AccessKeyId || !parsed.SecretAccessKey) {
      warn('`aws configure export-credentials` responded without AccessKeyId/SecretAccessKey');
      return null;
    }
    return parsed.SessionToken
      ? { accessKeyId: parsed.AccessKeyId, secretAccessKey: parsed.SecretAccessKey, sessionToken: parsed.SessionToken }
      : { accessKeyId: parsed.AccessKeyId, secretAccessKey: parsed.SecretAccessKey };
  } catch (error) {
    warn(`\`aws configure export-credentials\` unavailable (${errorMessage(error)})`);
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
