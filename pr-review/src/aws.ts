/**
 * Résolution des identifiants AWS, quatre barreaux du plus explicite au plus
 * ambiant : env statique, web identity (runners Kubernetes), CLI `aws`
 * (profils locaux, SSO compris). Aucun SDK AWS : builtins Node et `fetch`
 * global seulement.
 */

import { readFileSync } from 'node:fs';
import type { AwsCredentials } from './llm/sigv4';
import { run } from './exec';

const STS_TIMEOUT_MS = 10_000;

/**
 * Résout des credentials AWS, ou `null` quand l'environnement n'en offre aucune.
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
    'aucune credential AWS trouvée (ni AWS_ACCESS_KEY_ID, ni web identity, ni `aws configure export-credentials`)',
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
    warn("AWS_WEB_IDENTITY_TOKEN_FILE présent mais région vide : STS a besoin d'un endpoint régional, barreau sauté");
    return null;
  }

  let token: string;
  try {
    token = readFileSync(tokenFile, 'utf-8').trim();
  } catch (error) {
    warn(`lecture de AWS_WEB_IDENTITY_TOKEN_FILE impossible (${errorMessage(error)})`);
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
    // Le seul appel STS non signé : c'est justement celui qui fournit la
    // credential dont tous les autres appels ont besoin.
    const response = await fetch(`https://sts.${region}.amazonaws.com/`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(STS_TIMEOUT_MS),
    });
    const text = await response.text();
    if (!response.ok) {
      warn(`AssumeRoleWithWebIdentity a échoué (HTTP ${response.status})`);
      return null;
    }
    const accessKeyId = extractTag(text, 'AccessKeyId');
    const secretAccessKey = extractTag(text, 'SecretAccessKey');
    const sessionToken = extractTag(text, 'SessionToken');
    if (!accessKeyId || !secretAccessKey || !sessionToken) {
      warn('AssumeRoleWithWebIdentity a répondu sans un des trois champs attendus');
      return null;
    }
    return { accessKeyId, secretAccessKey, sessionToken };
  } catch (error) {
    warn(`appel à AssumeRoleWithWebIdentity impossible (${errorMessage(error)})`);
    return null;
  }
}

/** 64 caractères max, alphanumérique et `[\w+=,.@-]` seulement (contrainte AWS sur `RoleSessionName`). */
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
      warn('`aws configure export-credentials` a répondu sans AccessKeyId/SecretAccessKey');
      return null;
    }
    return parsed.SessionToken
      ? { accessKeyId: parsed.AccessKeyId, secretAccessKey: parsed.SecretAccessKey, sessionToken: parsed.SessionToken }
      : { accessKeyId: parsed.AccessKeyId, secretAccessKey: parsed.SecretAccessKey };
  } catch (error) {
    warn(`\`aws configure export-credentials\` indisponible (${errorMessage(error)})`);
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
