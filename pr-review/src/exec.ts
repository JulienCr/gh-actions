/**
 * Lancement de sous-processus.
 *
 * Toute l'action tient sur des builtins Node plus deux CLI externes : `gh`,
 * préinstallé et déjà authentifié sur les runners `ubuntu-latest`, et `op`,
 * seulement en local. Aucune dépendance npm au runtime, donc rien à installer
 * avant de relire une branche : le job reste vert même quand le lockfile de la
 * branche est cassé, c'est-à-dire précisément quand une review sert.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Un diff de PR peut peser quelques Mo ; le défaut de 1 Mo d'execFile ne suffit pas. */
const MAX_BUFFER = 32 * 1024 * 1024;

export async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer: MAX_BUFFER });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`« ${command} ${args.slice(0, 3).join(' ')} … » a échoué : ${message}`);
  }
}

/**
 * Variante qui pousse un corps par stdin.
 *
 * Un commentaire de review fait plusieurs kilo-octets et contient des backticks,
 * des accents et des retours à la ligne. Le passer en argv l'expose aux limites
 * de taille et à toute réinterprétation ; `--body-file -` le laisse intact.
 */
export function runWithStdin(command: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));
    child.stderr.on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => reject(new Error(`impossible de lancer « ${command} » : ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(new Error(`« ${command} ${args.slice(0, 3).join(' ')} … » a quitté avec ${code}\n${stderr.slice(-2000)}`));
    });
    child.stdin.end(input);
  });
}
