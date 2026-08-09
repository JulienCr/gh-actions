# gh-actions

Les actions GitHub réutilisables de Julien Cruau. Un dossier par action, versionnées ensemble
par des tags `vX.Y.Z` plus un tag majeur mobile `vX`.

| Action | Ce qu'elle fait |
| --- | --- |
| [`pr-review`](#pr-review) | Relit une pull request avec un modèle Ollama Cloud, en lui donnant la doctrine du dépôt, et poste un commentaire de synthèse. |

## pr-review

À l'ouverture d'une PR, un modèle la relit avec les conventions du dépôt sous les yeux et poste
un commentaire. Ce qu'elle cherche est ce qu'un linter ne peut pas voir : les règles propres au
projet, les régressions fonctionnelles, les fuites de données.

**Elle ne fait jamais échouer le job.** Une review est un avis, pas un gate. Quota épuisé, panne
d'Ollama, clé absente : c'est dit dans un commentaire quand c'est possible, et le job sort en 0.
La seule chose qu'on refuse est le silence, qui laisserait une PR non relue passer pour une PR
jugée irréprochable.

### Installation dans un dépôt

Poser le secret `OLLAMA_API_KEY` (`gh secret set OLLAMA_API_KEY --repo <owner>/<repo>`), puis
créer `.github/workflows/pr-review.yml` :

```yaml
name: Review IA des PR

on:
  pull_request:
    types: [opened, ready_for_review]
  workflow_dispatch:
    inputs:
      pr:
        description: 'Numéro de la PR à relire'
        required: true
        type: string

permissions:
  contents: read
  pull-requests: write

concurrency:
  group: pr-review-${{ github.event.pull_request.number || inputs.pr }}
  cancel-in-progress: true

jobs:
  review:
    # Un brouillon ne consomme pas de quota : il sera relu au passage en « prêt ».
    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.draft == false
    runs-on: ubuntu-latest
    timeout-minutes: 25
    steps:
      # La tête de la PR, pas le commit de merge : le contenu lu doit
      # correspondre au diff, sinon le modèle raisonne sur des numéros de ligne
      # qui ont bougé.
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', inputs.pr) }}

      - uses: JulienCr/gh-actions/pr-review@v1
        with:
          pr: ${{ github.event.pull_request.number || inputs.pr }}
          ollama-api-key: ${{ secrets.OLLAMA_API_KEY }}
          doctrine: |
            .github/copilot-instructions.md
            CLAUDE.md
          skip: |
            src/generated/**
            deploy/**
```

Aucune dépendance à installer : l'action n'importe que des builtins Node et pilote GitHub par le
CLI `gh`, déjà présent sur le runner. Le job reste donc vert même quand le lockfile de la branche
est cassé, c'est-à-dire précisément quand une review sert.

### Inputs

Seul `pr` est obligatoire.

| Input | Défaut | |
| --- | --- | --- |
| `pr` | — | Numéro de la PR à relire. |
| `ollama-api-key` | `''` | Clé Ollama Cloud. Vide : review ignorée sans bruit, job vert. |
| `github-token` | `${{ github.token }}` | Jeton du CLI `gh`. Le jeton du job suffit, avec `pull-requests: write`. |
| `model` | `glm-5.2:cloud` | Modèle Ollama Cloud. |
| `doctrine` | voir ci-dessous | Fichiers de conventions injectés dans le prompt, un chemin par ligne. |
| `skip` | `''` | Motifs de fichiers à ne pas relire, un par ligne. **S'ajoutent** au socle intégré. |
| `project-summary` | `''` | Deux ou trois lignes situant le projet, si la doctrine ne le fait pas. |
| `max-findings` | `12` | Plafond de puces, toutes sections confondues. |
| `budget-chars` | `500000` | Plafond global du contenu intégral envoyé au modèle. |
| `per-file-chars` | `80000` | Plafond par fichier. |
| `timeout-minutes` | `15` | Délai de la requête au modèle. À garder sous le `timeout-minutes` du job. |
| `dry-run` | `false` | `true` : la review part dans les logs, rien n'est posté. |

### La doctrine

Le prompt système ne contient **aucune** règle de projet : il injecte les fichiers que le dépôt
désigne. Une seule source de vérité, partagée avec les autres relecteurs qui lisent déjà ces
fichiers (Copilot lit `.github/copilot-instructions.md`, Claude Code lit `CLAUDE.md`). Une règle
recopiée dans le prompt finirait par diverger de celle du dépôt.

Par défaut l'action cherche `.github/copilot-instructions.md`, `CLAUDE.md` et `AGENTS.md`. Ceux
qui n'existent pas sont ignorés sans bruit. Si aucun n'est trouvé, le modèle est prévenu qu'il
juge sur des critères génériques, pour qu'il ne présente pas une remarque comme une règle maison.

Un bon fichier de doctrine dit ce qui est propre à ce dépôt et coûte cher quand on l'oublie : la
règle métier que le code n'exprime pas, la frontière d'import, la liste de ce qu'il ne faut pas
relire. Il ne redit pas ce que le linter attrape déjà.

### Ce qui est envoyé au modèle

Le diff **et** le contenu intégral des fichiers touchés, lignes numérotées. Un diff seul ne
montre pas le voisinage, et c'est le voisinage qui dit si une chaîne française est de l'éditorial
en dur ou un libellé technique, ou si une requête franchit une frontière de rôle.

Toute troncature est déclarée dans le pied du commentaire. Une review silencieusement partielle
se lit exactement comme une review complète, c'est le pire des deux mondes.

### Exclusions

Un socle non désactivable couvre les lockfiles, `node_modules`, les binaires et les fichiers
minifiés : ce sont des artefacts mécaniques, une review qui les commente perd son temps et celui
du lecteur. L'input `skip` s'y ajoute, en syntaxe `.gitignore` :

- un motif **sans** barre oblique porte sur le nom de fichier, à toute profondeur (`*.snap`) ;
- un motif **avec** barre oblique est ancré à la racine du dépôt (`src/generated/**`) ;
- un motif finissant par `/` vaut pour tout son contenu ;
- `*` ne franchit pas une barre oblique, `**` la franchit.

### La review est en français

Les titres de section du gabarit (`## Verdict`, `## Bloquant`, `## À corriger`, `## Suggestions`)
servent aussi de repères d'analyse : le rendu coupe la réponse du modèle à la dernière occurrence
de `## Verdict`, seul moyen fiable de séparer le raisonnement de la review. Les traduire par un
input casserait l'extraction, c'est pourquoi il n'y en a pas.

### Régler un prompt en local

Sans rien installer dans le dépôt relu, depuis sa racine :

```bash
npx --yes -p github:JulienCr/gh-actions pr-review 154 --dry-run
npx --yes -p github:JulienCr/gh-actions pr-review 154 --model qwen3-coder:480b-cloud --dry-run
```

La clé se prend dans `OLLAMA_API_KEY`, sinon dans 1Password à la référence `OLLAMA_API_KEY_REF`
(défaut `op://Personal/Ollama/add more/api_key`), pour qu'elle ne traîne ni dans un `.env` ni
dans l'historique du shell.

Avant de régler quoi que ce soit : `gh pr checkout <n>`. Le diff vient de GitHub, le contenu
intégral vient du disque ; sur une PR déjà mergée, le modèle reçoit le diff d'hier et les
fichiers d'aujourd'hui, et conclut de travers sur des lignes qui ont bougé. La moitié des
« hallucinations » d'un réglage venaient de là, pas du modèle. L'action prévient quand elle
détecte l'écart.

## Développer

```bash
pnpm install
pnpm test          # vitest
pnpm typecheck
pnpm build         # régénère les bundles dans <action>/dist/
```

`<action>/dist/index.mjs` est **committé** : le runner l'exécute tel quel, sans jamais installer
ni builder. La CI vérifie que le bundle correspond aux sources ; sans cette garde, une
modification de `src/` publiée sans rebuild ferait distribuer l'ancien bundle par le tag `v1`, en
silence et à tous les dépôts.

### Publier une version

```bash
git tag v1.0.1 && git push origin v1.0.1
```

Le workflow `release.yml` rejoue les tests et la garde du bundle, puis déplace le tag majeur
`v1`. Les dépôts épinglés sur `@v1` prennent la correction à leur prochaine PR, sans rien
changer chez eux. `@v1.0.1` pour figer une version précise.

Une rupture de compatibilité (input retiré ou renommé, comportement par défaut inversé) passe en
`v2` : `v1` reste où il est et les dépôts migrent quand ils veulent.
