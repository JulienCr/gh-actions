# gh-actions — doctrine de review

> Ce fichier sert deux relecteurs : Copilot, qui le lit de lui-même, et l'action `pr-review` de ce
> dépôt, qui l'injecte dans son prompt système. Toute règle ajoutée ici vaut pour les deux.

Dépôt d'actions GitHub réutilisables, consommées par d'autres dépôts via `uses: …@v1`. Ce qui est
mergé ici part chez tous les consommateurs au prochain tag. C'est ce qui rend chaque erreur chère.

## Toujours vérifier

### Le bundle est le livrable

- Une modification de `<action>/src/**` sans `pnpm build` ni `dist/` committé livre l'ancien code
  aux dépôts consommateurs, **en silence**. La CI l'attrape ; signale-le quand même en review,
  c'est le mode de panne le plus coûteux du dépôt.
- **Aucune dépendance runtime.** Le bundle ne doit importer que des builtins Node. Une dépendance
  npm casserait la promesse d'un job qui tourne sans installer quoi que ce soit, donc vert même
  quand le lockfile de la branche relue est cassé.

### Compatibilité des inputs

- Retirer ou renommer un input d'`action.yml`, ou inverser un défaut, **casse** les dépôts épinglés
  sur `@v1`. Ça se fait en `v2`, pas dans une release mineure. Flag toute PR qui le fait sans le
  dire.
- Un input neuf doit avoir un défaut qui reproduit le comportement d'avant.

### Le job ne rougit jamais

- `pr-review` sort en 0 quoi qu'il arrive, sauf erreur d'invocation. Une clé absente, un quota
  épuisé, une panne Ollama : commentaire d'échec si possible, et exit 0. Toute nouvelle branche
  d'erreur qui laisse une exception remonter est un bug.
- Un échec silencieux est pire qu'un échec visible : une PR sans review doit être discernable
  d'une PR jugée irréprochable.

### Secrets

- Jamais de clé, de jeton ni d'en-tête d'authentification dans un message d'erreur ou un log :
  les journaux de CI sont lisibles par tout collaborateur du dépôt consommateur.

### Tests

- Les modules purs (`context`, `imports`, `prompt`, `passes`, `render`, `globs`, `inputs`) se
  testent sans E/S : les lecteurs de fichiers, le test d'existence et l'environnement sont
  injectés. Une PR qui ajoute une E/S dans l'un d'eux pour se simplifier la vie mérite d'être
  discutée.
- Un test qui passe avec ET sans le correctif n'épingle rien.

## Skip

- `*/dist/**` — sortie d'esbuild, aucune édition à la main.
- `pnpm-lock.yaml`.

## Style de review

- En français, concis, `fichier:ligne`. Le **pourquoi** plutôt que le **quoi**.
- Pas de remarque sur du formatage que Prettier règle déjà.
