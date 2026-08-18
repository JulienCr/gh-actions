# gh-actions

Les actions GitHub réutilisables. Un dossier par action, versionnées ensemble
par des tags `vX.Y.Z` plus un tag majeur mobile `vX`.

| Action | Ce qu'elle fait |
| --- | --- |
| [`pr-review`](#pr-review) | **Aristarque** relit une pull request avec un modèle Ollama Cloud, en trois passes, et poste un commentaire de synthèse. |

## pr-review

À l'ouverture d'une PR, un modèle la relit avec les conventions du dépôt sous les yeux et poste
un commentaire signé **Aristarque**. Ce qu'elle cherche est ce qu'un linter ne peut pas voir : les
règles propres au projet, les régressions fonctionnelles, les fuites de données.

Le nom vient d'Aristarque de Samothrace, qui relisait Homère au deuxième siècle avant notre ère en
portant dans la marge des signes de sévérité : l'obèle pour le vers qu'il tenait pour faux,
l'astérisque pour le doublon. C'est déjà « Bloquant », « À corriger » et la déduplication que fait
ici la passe de fusion. Le mot a fini par désigner en français un critique sévère.

La lecture est découpée en **trois passes indépendantes**, puis fusionnée : voir
[Trois passes plutôt qu'une](#trois-passes-plutôt-quune).

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
  # Une mention rattrape ce que les deux autres ne couvrent pas : ni « opened »
  # ni « ready_for_review » ne se rejouent sur une PR déjà relue, et un rebase
  # ne redéclenche rien.
  issue_comment:
    types: [created]
  workflow_dispatch:
    inputs:
      pr:
        description: 'Numéro de la PR à relire'
        required: true
        type: string

permissions:
  contents: read
  pull-requests: write
  # Pour réagir 👀 au commentaire déclencheur. Un commentaire de conversation de
  # PR est un commentaire d'issue au sens de l'API : « pull-requests » ne suffit pas.
  issues: write

jobs:
  review:
    # Un brouillon ne consomme pas de quota : il sera relu au passage en « prêt ».
    # La mention passe outre le brouillon : demander explicitement une review
    # sur un brouillon est une demande, pas un accident.
    #
    # ⚠️ La garde sur l'auteur n'est pas du confort. `issue_comment` s'exécute avec
    # les secrets du dépôt et un jeton en écriture, sur commentaire de n'importe
    # qui. Sur un dépôt public, sans allowlist, un inconnu vide la clé Ollama en
    # boucle. Mettre son propre login. `issue.pull_request` écarte au passage les
    # commentaires d'issue, que le même événement porte aussi.
    if: >-
      github.event_name == 'workflow_dispatch'
      || (github.event_name == 'pull_request' && github.event.pull_request.draft == false)
      || (github.event_name == 'issue_comment'
          && github.event.issue.pull_request
          && github.event.comment.user.login == 'JulienCr'
          && contains(github.event.comment.body, '@aristarque review'))
    runs-on: ubuntu-latest
    # Au niveau du job, pas du workflow. Un run dont le job est écarté par la
    # garde ci-dessus n'entre jamais dans le groupe ; au niveau du workflow il y
    # entrait avant que la garde soit évaluée, donc n'importe quel commentaire
    # d'un inconnu annulait la review en cours via `cancel-in-progress`. La
    # garde sur l'auteur empêchait de lancer une review, pas d'en tuer une.
    concurrency:
      group: pr-review-${{ github.event.pull_request.number || github.event.issue.number || inputs.pr }}
      cancel-in-progress: true
    # Trois passes en parallèle puis leur fusion : le mur vaut jusqu'à deux fois
    # le « timeout-minutes » de l'action, plus la marge du commentaire d'échec.
    timeout-minutes: 40
    steps:
      # Un run déclenché par commentaire n'apparaît pas comme check sur la PR :
      # sans cet accusé de réception, la mention se fait à l'aveugle.
      - name: Accuser réception de la mention
        if: github.event_name == 'issue_comment'
        # Cosmétique, donc non bloquant : sans ceci un `gh api` qui échoue (rate
        # limit, commentaire supprimé) sort en non-zéro, et checkout comme review
        # sont skippés. La réaction manquerait ET la review avec.
        continue-on-error: true
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh api -X POST \
            "repos/${{ github.repository }}/issues/comments/${{ github.event.comment.id }}/reactions" \
            -f content=eyes

      # La tête de la PR, pas le commit de merge : le contenu lu doit
      # correspondre au diff, sinon le modèle raisonne sur des numéros de ligne
      # qui ont bougé.
      - uses: actions/checkout@v7
        with:
          ref: ${{ github.event.pull_request.head.sha || format('refs/pull/{0}/head', github.event.issue.number || inputs.pr) }}

      - uses: JulienCr/gh-actions/pr-review@v2
        with:
          pr: ${{ github.event.pull_request.number || github.event.issue.number || inputs.pr }}
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

⚠️ **Une PR en conflit ne déclenche aucun workflow `pull_request`.** GitHub ne sait pas calculer
son commit de merge, donc il n'émet pas l'événement. Copilot, lui, passe par un autre mécanisme et
tourne quand même, ce qui rend l'asymétrie déroutante. Si la review ne part pas sur une PR neuve,
vérifier `gh pr view <n> --json mergeable` avant de suspecter le YAML : rebaser suffit. Corollaire,
`synchronize` n'étant pas dans les types écoutés, relancer la review après un rebase demande une
mention : voir [Déclencher une review à la demande](#déclencher-une-review-à-la-demande).

### Déclencher une review à la demande

Commenter `@aristarque review` sur une pull request relance la lecture. C'est le chemin qui manquait
pour une deuxième passe : `synchronize` n'est pas écouté, donc pousser des corrections ne rejoue
rien, et l'aller-retour brouillon (`gh pr ready --undo <n> && gh pr ready <n>`) marche mais laisse
deux événements parasites dans l'historique de la PR.

La mention passe outre le brouillon, contrairement aux deux autres déclencheurs. La règle du
brouillon existe pour ne pas dépenser de quota sans qu'on l'ait demandé, pas pour empêcher de le
demander.

**La garde sur l'auteur n'est pas optionnelle.** `issue_comment` s'exécute avec les secrets du dépôt
et un jeton en écriture, sur commentaire de n'importe qui. Sur un dépôt public, sans allowlist, un
inconnu déclenche la review en boucle et vide la clé Ollama. L'exemple ci-dessus filtre sur un login
unique ; `github.event.comment.author_association` comparé à `OWNER`, `MEMBER` ou `COLLABORATOR`
convient mieux à un dépôt qui a plusieurs mainteneurs.

**La concurrence descend au niveau du job**, et c'est la même histoire. Un run entre dans son
groupe de concurrence à sa création, avant que la garde `if` du job soit évaluée. Laissée au niveau
du workflow, elle faisait entrer dans le groupe le run né du commentaire de n'importe qui, qui
annulait la review en cours via `cancel-in-progress` puis se faisait écarter. La garde sur l'auteur
empêchait de lancer une review, pas d'en tuer une, ce qui rendait le déni de service trivial. Un job
écarté, lui, n'entre jamais dans le groupe.

Deux choses surprennent la première fois. GitHub n'exécute que la version du workflow présente sur
la branche par défaut, donc le déclencheur ne marche qu'une fois mergé, jamais depuis la PR qui
l'introduit. Et un run lancé par commentaire n'apparaît pas comme check sur la PR, seulement dans
l'onglet Actions : d'où la réaction `eyes` posée sur le commentaire déclencheur, qui coûte la permission
`issues: write`, un commentaire de conversation de PR étant un commentaire d'issue au sens de l'API.
Cette étape est en `continue-on-error` : un accusé de réception qui ferait échouer le job emporterait
la review avec lui, et il ne resterait alors ni réaction ni commentaire, donc aucun retour.

### Ne pas lancer une review qu'on va remplacer

Les trois passes partent en parallèle, chacune avec le contexte entier. L'entrée est donc dépensée
dans les secondes qui suivent le lancement, pas au fil du raisonnement : entre 150 000 et 270 000
tokens selon la PR, engagés d'un coup. Annuler un run devenu obsolète ne récupère que le
raisonnement et la sortie, jamais l'entrée. **La seule décision qui coûte est le lancement.**

Mesuré sur un dépôt piloté par plusieurs agents en parallèle : sur 43 runs réellement partis, 23 ont
été annulés par un lancement plus récent sur la même PR. Environ quatre millions de tokens d'entrée
pour des reviews que personne n'a lues.

D'où la répartition des rôles. Copilot relit chaque push tout seul, en trois minutes et sans rien
coûter : c'est lui qui porte le cycle corriger, pousser, relire, autant de fois qu'il le faut.
Aristarque se lance **une fois**, quand ce cycle a convergé, c'est-à-dire quand la relecture
automatique ne rend plus rien de neuf et qu'aucun correctif n'est en attente. Il est le seul à lire
la doctrine du dépôt, donc il doit voir l'état final et non les états intermédiaires qu'il n'aura
pas le temps de relire.

Corollaire, si un correctif manque alors que la review est déjà partie : le pousser, mais ne pas
redemander de review tout de suite. Attendre que le premier rapport tombe ou soit annulé, sinon la
même lecture est payée deux fois.

Le `cancel-in-progress: true` de l'exemple reste utile pour ce cas : il évite qu'un run condamné
finisse de brûler son raisonnement. Il ne rattrape pas le lancement de trop.

### Inputs

Seul `pr` est obligatoire.

| Input | Défaut | |
| --- | --- | --- |
| `pr` | — | Numéro de la PR à relire. |
| `enable` | `true` | `false` : l'action sort sans rien lire ni appeler. Coupe la review sans démonter le workflow. |
| `ollama-api-key` | `''` | Clé Ollama Cloud. Vide : review ignorée sans bruit, job vert. |
| `github-token` | `${{ github.token }}` | Jeton du CLI `gh`. Le jeton du job suffit, avec `pull-requests: write`. |
| `model` | `glm-5.2:cloud` | Modèle Ollama Cloud. |
| `effort` | `balanced` | Ampleur des coupes dans ce qui est envoyé : `full`, `balanced`, `lean`. Voir ci-dessous. |
| `passes` | `''` | Passes à lancer (`regression`, `doctrine`, `data`), une par ligne. Vide : `effort` décide. |
| `thinking` | `max` | Effort de raisonnement des trois passes : `low`, `medium`, `high`, `max`, `off`. Un modèle qui refuse est relancé sans. |
| `merge-thinking` | `high` | Idem pour la fusion, qui trie sans avoir le code sous les yeux. |
| `temperature` | `1` | **Ne pas mettre 0** : voir ci-dessous. |
| `seed` | `1` | Graine, pour que deux lectures du même diff se ressemblent. `off` rend sa variance au modèle. |
| `doctrine` | voir ci-dessous | Fichiers de conventions injectés dans le prompt, un chemin par ligne. |
| `skip` | `''` | Motifs de fichiers à ne pas relire, un par ligne. **S'ajoutent** au socle intégré. |
| `project-summary` | `''` | Deux ou trois lignes situant le projet, si la doctrine ne le fait pas. |
| `max-findings` | `20` | Plafond de puces pour Bloquant, À corriger et Suggestions. « À vérifier » a son propre plafond de cinq. |
| `budget-chars` | `500000` | Plafond du contenu intégral des fichiers **touchés**. |
| `per-file-chars` | `80000` | Plafond par fichier. |
| `window-min-lines` | selon le cran | Taille à partir de laquelle un fichier part par extraits. `0` : jamais. |
| `imports-budget-chars` | `300000` | Plafond des fichiers **importés**, joints en contexte. `0` : aucun. `120000` au cran `lean`. |
| `timeout-minutes` | `15` | Délai d'**une** requête. La review en fait quatre ; voir le `timeout-minutes` du job. |
| `dry-run` | `false` | `true` : la review part dans les logs, rien n'est posté. |

### Le cran d'effort

L'entrée d'une review se dépense d'un coup, dans les secondes qui suivent le lancement. L'input
`effort` règle son ampleur, et rien n'est économisé en douce : tout ce qu'un cran retire est
déclaré dans le pied de page du commentaire.

| | `full` | `balanced` (défaut) | `lean` |
| --- | --- | --- | --- |
| Fichiers touchés | entiers | par extraits au-delà de 250 lignes | par extraits au-delà de 120 lignes |
| Fichiers importés | aux trois passes | pas à « doctrine » | à « régression » seule, budget 120 000 |
| Passes | les trois | une passe qu'une PR ne peut pas déclencher n'est pas lancée | idem |
| `thinking` | inchangé | inchangé | un cran plus bas sur « doctrine » et « données » |

Deux garde-fous que le cran ne lève jamais. **La passe « données et accès » tourne toujours** : un
README fuit une clé aussi bien qu'un `.ts`, et une doc d'API publie un endpoint interne. Une
fuite coûte incomparablement plus cher qu'une passe. Et **aucun cran ne supprime un axe** :
`lean` rétrécit le contexte, il ne repasse pas à deux passes, parce qu'un modèle qui porte
plusieurs axes à la fois expédie les derniers.

La passe « doctrine » ne tourne pas sur un dépôt qui ne fournit aucun fichier de doctrine, à
tous les crans y compris `full` : son prompt lui dicte alors sa sortie mot pour mot, et la lancer
reviendrait à payer un contexte entier pour une réponse écrite d'avance.

Mesuré sur ce dépôt, à contenu de disque identique, entrée par review :

| PR | avant | `full` | `balanced` | `lean` |
| --- | --- | --- | --- | --- |
| 18 fichiers, 5 importés | 841 060 car. | -11,0 % | -13,5 % | -16,0 % |
| README seul | 108 115 car. | -0,3 % | **-33,7 %** | -33,7 % |
| 2 fichiers, aucun import | 229 780 car. | -0,1 % | -0,1 % | -0,1 % |

Le `-33,7 %` d'une PR de documentation est la passe « régression fonctionnelle » qu'on ne lance
pas : elle ne pouvait rendre que « rien ». Le `-0,1 %` de la dernière ligne est honnête aussi : une
PR sans fichier neuf, sans renommage et sans import n'a rien à rendre. Le cran ne l'invente pas.

Ce que ces chiffres ne montrent pas, c'est le fenêtrage, qui vaut **zéro sur ce dépôt**. Ses
fenêtres y couvrent 100 % de chaque fichier assez gros pour être candidat, donc il renonce et
envoie le fichier entier. Avec soixante lignes de marge de part et d'autre, un seul hunk en couvre
déjà cent vingt : sous quatre cents lignes, il n'y a rien à gagner. Le gain est à attendre d'un
dépôt applicatif, dont les fichiers de mille lignes reçoivent des retouches localisées. Le garde-fou
est là pour ça : mieux vaut un fichier entier qu'un fichier haché pour trois pour cent.

### Ce qu'une review coûterait, avant de la lancer

`--count-only` assemble le contexte, construit les prompts, imprime la ventilation et **n'appelle
rien**. Ni clé ni quota : l'entrée est déterministe, donc elle se compte.

```
pr-review 154 --count-only
```

```
  appel                             système        user       total    ≈ tokens
  passe régression fonctionnelle      8 207     139 316     147 523     ~42 149
  passe doctrine du dépôt             7 916     139 316     147 232     ~42 066
  passe données et accès              8 091     139 316     147 407     ~42 116
  ──────────────────────────────────────────────────────────────────────────
  total entrée                                              442 162    ~126 332
  dont : diff 23 % · fichiers touchés 69 % · imports 0 % · système 6 % · reste 2 %
```

La ventilation est ce qui dit où couper, et elle ne se devine pas : sur ce dépôt le diff pèse
entre 10 et 33 % de l'entrée selon la PR, et les fichiers importés entre 0 et 11 %. Les tokens
sont estimés à partir des caractères ; les caractères, eux, sont exacts.

Chaque exécution imprime aussi une ligne `::stats::{…}` en JSON, greppable dans un journal de CI,
qui porte les compteurs **et les trouvailles brutes de chaque passe**. Comparer deux réglages sur
leurs tokens dit lequel est le moins cher, jamais lequel a perdu une trouvaille.

### Pourquoi pas une review agentique

Le runner sort bien le dépôt, et `glm-5.2:cloud` accepte les outils : rien n'empêche techniquement
de donner au modèle un `read_file` et de le laisser chercher au lieu de tout lui envoyer.

L'arithmétique, si. Un aller-retour agentique ne renvoie pas la question, il renvoie tout ce qui
précède. Sans cache de prompt, `n` tours coûtent `n` fois le socle : avec un socle de 50 000 tokens
et huit tours de lecture, l'addition passe 400 000 tokens là où l'envoi glouton en coûte 65 000.
Plus le relecteur travaille bien, plus il coûte.

Or Ollama Cloud ne sert pas de cache de prompt ([#15600](https://github.com/ollama/ollama/issues/15600),
[#16714](https://github.com/ollama/ollama/issues/16714)). C'est la même raison qui tue le raccourci
symétrique : faire partager aux trois passes un préfixe identique ne leur ferait rien repasser. Et
un LSP n'y changerait rien non plus, puisqu'il rétrécit les réponses des outils, pas le socle
renvoyé à chaque tour.

À rouvrir le jour où ce cache existe. La mesure tient en deux requêtes identiques dont on compare
le `prompt_eval_duration`.

### Pourquoi la température n'est pas à zéro

Le réflexe, sur une tâche qui doit être reproductible, est `temperature: 0`. Sur un modèle de
raisonnement c'est un mauvais calcul : le décodage glouton raccourcit la chaîne de pensée et la
fait tourner en rond, et on paie en profondeur d'analyse une reproductibilité que le cloud ne
garantit de toute façon pas. La stabilité d'un jour à l'autre est confiée à `seed`, qui la sert
sans rien coûter.

Corollaire pour relire une PR sous un autre angle : `seed: off` plutôt que de toucher à la
température. Deux passages donneront deux lectures différentes, ce qui est le but.

### Trois passes plutôt qu'une

La review tenait en un seul appel : la doctrine du dépôt, six axes de recherche, les règles de
rédaction et le gabarit de sortie, le tout pendant que le modèle lit quatre-vingt-dix kilo-octets
de code. Les axes cités en dernier étaient ceux qu'il honorait le moins.

Trois lectures indépendantes tournent donc en parallèle, sur le même contexte, avec un seul
objectif chacune :

1. **Régression fonctionnelle** : côté appelant, chemins d'erreur, entrées limites, état et
   ordonnancement, ce que le changement a oublié.
2. **Doctrine du dépôt** : ce que disent `CLAUDE.md` et consorts, et rien d'autre.
3. **Données et accès** : frontières de rôle, secrets, données personnelles.

Une quatrième requête les fusionne : elle déduplique, arbitre les sévérités, applique
`max-findings` et rédige les cinq rubriques. **Elle ne reçoit pas le code**, et son prompt le lui
dit : son travail est de trier, pas de relire, et un modèle qui complète de mémoire une trouvaille
trop courte l'invente.

Ce que ça coûte : le contexte part trois fois. Ce que ça évite : un axe expédié parce que deux
autres tenaient la tête du modèle. Les passes étant parallèles, le mur du job vaut « la plus lente
plus la fusion », pas leur somme, d'où le `timeout-minutes: 40` de l'exemple.

Une passe qui échoue n'annule pas les autres : deux lectures sur trois valent mieux que rien, et le
pied de page du commentaire dit laquelle manque. Si c'est la fusion qui échoue, les trouvailles
brutes sont postées telles quelles, sans tri, plutôt que jetées.

### Ce que le modèle est censé rendre

Cinq rubriques : Verdict, Bloquant, À corriger, Suggestions, **À vérifier**.

La dernière est là pour un motif précis. Un prompt qui réclame de la certitude obtient des
sections vides : le modèle cherche, trouve quelque chose qu'il ne peut pas prouver avec les
fichiers qu'on lui a donnés, et le jette. « À vérifier » lui donne où le mettre, ce qui coûte
bien moins cher qu'un bug passé en silence. Le prompt lui interdit en revanche d'y ranger ce
qu'il aurait pu démontrer, fichiers importés compris, et lui demande, quand il écrit « Rien à
signaler », de dire dans la même ligne ce qu'il a vérifié pour l'affirmer.

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

S'y ajoutent, dans une section à part, **les fichiers que ceux-là importent**. Sans eux, un doute
légitime sur un appelant ne pouvait que finir sous « À vérifier » : « l'enum `OrderStatus`
couvre-t-il bien ces six valeurs ? », « `truncate` compte-t-il des caractères ou des octets ? ».
Avec le fichier sous les yeux, c'est une trouvaille ou ce n'est rien. La place était là : une PR
réelle envoyait 92 000 tokens pour une fenêtre de 976 000.

Un seul niveau d'import, les chemins relatifs et le préfixe `@/` (tenté sur `src/`, la racine, puis
`app/`). Ce n'est pas un résolveur de modules : un `tsconfig.json` n'est pas lu, et **une
résolution ratée est ignorée en silence**, parce qu'elle doit dégrader la review, jamais l'annuler.
Le prompt étiquette ces fichiers comme non modifiés par la PR et interdit d'y relever des défauts :
ils servent à juger le changement, pas à être jugés.

Toute troncature est déclarée dans le pied du commentaire, et le nombre de fichiers importés aussi.
Une review silencieusement partielle se lit exactement comme une review complète, c'est le pire des
deux mondes ; et une review qui a vu plus que la PR doit le dire.

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
npx --yes -p 'github:JulienCr/gh-actions#v2' pr-review 154 --dry-run
npx --yes -p 'github:JulienCr/gh-actions#v2' pr-review 154 --model qwen3-coder:480b-cloud --dry-run
```

Le `#v2` n'est pas décoratif : sans lui, npx prend la branche par défaut, et un réglage validé en
local tournerait sur un prompt différent de celui de la CI. Épingle la même version des deux côtés.

Corollaire utile : une version passée sert de point de comparaison. `#v1.1.0` est la dernière à
relire en un seul appel et sans contexte importé ; la lancer sur la même PR, à graine égale, dit
si un changement de prompt a rapporté des trouvailles ou seulement du bruit.

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
modification de `src/` publiée sans rebuild ferait distribuer l'ancien bundle par le tag majeur, en
silence et à tous les dépôts.

### Publier une version

```bash
git tag v2.0.1 && git push origin v2.0.1
```

Le workflow `release.yml` rejoue les tests et la garde du bundle, puis déplace le tag majeur
`v2`. Les dépôts épinglés sur `@v2` prennent la correction à leur prochaine PR, sans rien
changer chez eux. `@v2.0.1` pour figer une version précise.

Une rupture de compatibilité (input retiré ou renommé, comportement par défaut inversé) passe au
majeur suivant : le précédent reste où il est et les dépôts migrent quand ils veulent.

### Migrer de `v1` à `v2`

`v1` relit en un seul appel et n'envoie que les fichiers touchés. `v2` découpe en trois passes plus
une fusion, et joint les fichiers importés. Deux choses à changer dans le workflow du dépôt :

```yaml
    timeout-minutes: 40                        # 25 ne suffit plus
    steps:
      - uses: JulienCr/gh-actions/pr-review@v2 # au lieu de @v1
```

Le `timeout-minutes` n'est pas optionnel : le mur vaut désormais « passe la plus lente plus la
fusion », et un job resté à 25 minutes se fait tuer à mi-review. Aucun input n'a été retiré ni
renommé, le reste de la configuration se reprend tel quel. Compter environ quatre fois plus de
tokens en entrée par PR : c'est le prix du découpage, le contexte partant à chaque passe.

Pour rester sur l'ancien comportement, `@v1` continue de fonctionner et ne bougera plus.
