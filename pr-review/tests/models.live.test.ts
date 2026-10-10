import { describe, expect, it } from 'vitest';

import { PASS_IDS, resolveConfig } from '../src/inputs';

/**
 * Live check: every default model still exists at its provider.
 * Network-bound, so off unless LIVE_MODELS=1 (`pnpm test:models`).
 */
const live = process.env.LIVE_MODELS === '1';
const deepseekKey = process.env.DEEPSEEK_API_KEY?.trim() ?? '';

function defaultModels(provider: string, env: Record<string, string>): string[] {
  const { passConfigs } = resolveConfig({ argv: ['1'], env });
  const models = PASS_IDS.map((id) => passConfigs[id]).filter((c) => c.provider === provider);
  return [...new Set(models.map((c) => c.model))];
}

describe.skipIf(!live)('modèles par défaut · disponibilité', () => {
  it('Ollama Cloud sert chaque modèle du mix sans clé DeepSeek', async () => {
    const res = await fetch('https://ollama.com/api/tags');
    expect(res.ok).toBe(true);
    const { models } = (await res.json()) as { models: { name: string }[] };
    // Le catalogue public nomme les modèles sans le suffixe « :cloud ».
    const served = new Set(models.map((m) => m.name));

    const wanted = defaultModels('ollama', {});
    expect(wanted.length).toBeGreaterThan(0);
    for (const model of wanted) {
      expect(served, `${model} absent du catalogue Ollama`).toContain(model.replace(/:cloud$/, ''));
    }
  });

  it.skipIf(deepseekKey === '')('DeepSeek direct sert chaque modèle du mix avec une clé', async () => {
    const res = await fetch('https://api.deepseek.com/models', {
      headers: { Authorization: `Bearer ${deepseekKey}` },
    });
    expect(res.ok).toBe(true);
    const { data } = (await res.json()) as { data: { id: string }[] };
    const served = new Set(data.map((m) => m.id));

    const wanted = defaultModels('deepseek', { 'INPUT_DEEPSEEK-API-KEY': 'x' });
    expect(wanted.length).toBeGreaterThan(0);
    for (const model of wanted) {
      expect(served, `${model} absent de l'API DeepSeek`).toContain(model);
    }
  });
});
