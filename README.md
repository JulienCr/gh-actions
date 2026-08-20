# gh-actions

Les actions GitHub réutilisables. Un dossier par action, versionnées ensemble
par des tags `vX.Y.Z` plus un tag majeur mobile `vX`.

| Action | Ce qu'elle fait |
| --- | --- |
| [`pr-review`](#pr-review) | **Aristarque** relit une pull request en trois passes, chacune sur le modèle qui lui convient, puis poste un commentaire de synthèse. |

## pr-review

À l'ouverture d'une PR, un modèle la relit avec les conventions du dépôt sous les yeux et poste
un commentaire signé **Aristarque**. Ce qu'elle cherche est ce qu'un linter ne peut pas voir : les
règles propres au projet, les régressions fonctionnelles, les fuites de données.

Le nom vient d'Aristarque de Samothrace, qui relisait Homère au deuxième siècle avant notre ère en
portant dans la marge des signes de sévérité : l'obèle pour le vers qu'il tenait pour faux,
l'astérisque pour le doublon. C'est déjà « Bloquant », « À corriger » et la déduplication que fait
ici la passe de fusion. Le mot a fini par désigner en français un critique sévère.

La lecture est découpée en **trois passes indépendantes**, puis fusionnée : voir
[Trois passes plutôt qu'une](#trois-passes-plutôt-quune). Chaque passe choisit son provider, son
modèle et son niveau de raisonnement : voir [Le mix par passe](#le-mix-par-passe).

**Elle ne fait jamais échouer le job.** Une review est un avis, pas un gate. Quota épuisé, panne
du provider, clé absente : c'est dit dans un commentaire quand c'est possible, et le job sort en 0.
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
  # Pour le statut de commit « aristarque/review », le seul mécanisme qui fasse
  # attendre la review. Voir « Faire attendre la review ».
  statuses: write

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
    # Le mur vaut « le plus gros groupe séquencé, plus la fusion ». Sans clé
    # DeepSeek les passes sont parallèles, donc deux fois le « timeout-minutes »
    # de l'action ; avec, le groupe DeepSeek en enchaîne deux, donc trois fois.
    timeout-minutes: 45
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

      - uses: JulienCr/gh-actions/pr-review@v3
        with:
          pr: ${{ github.event.pull_request.number || github.event.issue.number || inputs.pr }}
          ollama-api-key: ${{ secrets.OLLAMA_API_KEY }}
          # Facultative. Sans elle, les trois appels bon marché passent par
          # Ollama ; avec elle, par l'API DeepSeek, qui ajoute un cache de
          # préfixe. Voir « Le mix par passe ».
          deepseek-api-key: ${{ secrets.DEEPSEEK_API_KEY }}
          doctrine: |
            .github/copilot-instructions.md
            CLAUDE.md
          skip: |
            src/generated/**
            deploy/**
          # Voir « Faire attendre la review ». Sans ceci, un auto-merge armé
          # part par-dessus une review encore en cours.
          status-check: true

      # Un run tué par « cancel-in-progress » ou par « timeout-minutes » ne
      # repasse pas par la fin du programme : sans cette étape, son annonce
      # resterait « review en cours » et son statut « pending » pour toujours,
      # et ce pending bloquerait le merge sans fin. En « continue-on-error »
      # pour la même raison que l'accusé de réception : un nettoyage qui échoue
      # ne doit pas emporter ce qu'il nettoie.
      - name: Signaler une review interrompue
        if: always() && (cancelled() || failure())
        continue-on-error: true
        uses: JulienCr/gh-actions/pr-review@v3
        with:
          pr: ${{ github.event.pull_request.number || github.event.issue.number || inputs.pr }}
          mode: abort
          status-check: true
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
| `announce` | `true` | Poste « review en cours » **avant** les appels, que le rapport remplace en place. `false` : rien avant le rapport. |
| `status-check` | `false` | Pose le statut de commit qui fait attendre la review. Demande `statuses: write`. Voir ci-dessous. |
| `status-context` | `aristarque/review` | Nom du statut, à recopier tel quel dans la protection de branche. |
| `mode` | `review` | `abort` : ne rien lire ni appeler, seulement conclure ce qu'un run tué a laissé en suspens. |
| `ollama-api-key` | `''` | Clé Ollama Cloud. Vide : review ignorée sans bruit, job vert. |
| `deepseek-api-key` | `''` | Clé DeepSeek. Fait passer le [mix](#le-mix-par-passe) par l'API directe, qui **ajoute un cache de préfixe**. Vide : le même modèle, servi par Ollama. |
| `openai-api-key` | `''` | Clé du provider `openai` générique. Inutile sans `openai-base-url`. |
| `openai-base-url` | `''` | Base d'un endpoint OpenAI-compatible quelconque (Fireworks, Z.ai, OpenRouter…). |
| `openai-prefix-cache` | `false` | `true` si cet endpoint cache les préfixes. Sinon ses passes ne sont jamais séquencées. |
| `github-token` | `${{ github.token }}` | Jeton du CLI `gh`. Le jeton du job suffit, avec `pull-requests: write`. |
| `provider` | `ollama` | Provider des passes qui n'en désignent pas d'autre : `ollama`, `deepseek`, `openai`. |
| `model` | `glm-5.2:cloud` | Modèle du provider global, et de la seule passe « régression ». ⚠️ L'écrire **remet les quatre appels dessus** : voir ci-dessous. |
| `<passe>-provider` | `''` | Provider d'une passe : `regression`, `doctrine`, `data`, `merge`. |
| `<passe>-model` | `''` | Modèle d'une passe. |
| `<passe>-thinking` | `''` | Raisonnement d'une passe. Écrit ici, il **échappe au cran** d'`effort`. |
| `effort` | `balanced` | Ampleur des coupes dans ce qui est envoyé : `full`, `balanced`, `lean`. Voir ci-dessous. |
| `passes` | `''` | Passes à lancer (`regression`, `doctrine`, `data`), une par ligne. Vide : `effort` décide. |
| `thinking` | `max` | Effort de raisonnement des trois passes : `low`, `medium`, `high`, `max`, `off`. Un modèle qui refuse est relancé sans. |
| `merge-thinking` | `low` | Idem pour la fusion, qui trie sans avoir le code sous les yeux. `high` quand le mix est écarté. |
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
| `timeout-minutes` | `15` | Délai d'**une** requête. Le mur du job vaut « le plus gros groupe séquencé, plus la fusion » ; voir ci-dessous. |
| `max-output-tokens` | *(vide)* | Plafond de tokens de **sortie** d'une requête ; `budget-chars` borne l'entrée. Vide : le plafond du modèle. Le poser borne ce que coûte un appel qui part en boucle de raisonnement. |
| `dry-run` | `false` | `true` : la review part dans les logs, rien n'est posté. |

### Faire attendre la review

Un commentaire ne bloque rien. `mergeStateStatus` ne le voit pas, et un auto-merge armé part
par-dessus une review encore en cours : mesuré sur `avolo-shorts`, une PR mergée dix minutes après
le lancement d'une review qui en demandait quinze, et dont le run tournait encore sur une PR déjà
fermée.

Poser `status-check: true` fait poser à l'action un **statut de commit** sur la tête de la PR :

| Moment | État | Ce que ça dit |
| --- | --- | --- |
| au démarrage, avant tout appel | `pending` | une review est prévue, et elle n'est pas finie |
| rapport posté | `success` | la PR a été relue |
| aucune passe lançable, ou aucune qui aboutit | `failure` | la PR n'a **pas** été relue |
| run annulé ou délai dépassé (étape `mode: abort`) | `error` | la review a été interrompue |

**Le statut ne juge pas le contenu.** Un rapport plein de « Bloquant » sort en `success` : il
atteste qu'elle a été lue, pas qu'elle est propre. La doctrine tient — une review est un avis, pas
un gate — et ce qu'on gate est l'existence de la lecture, pas son verdict.

Il reste à le déclarer requis, côté dépôt, une fois pour toutes :

```
gh api -X PUT repos/<owner>/<repo>/branches/main/protection/required_status_checks \
  -f 'checks[][context]=aristarque/review'
```

Ce qui fait la valeur de ce mécanisme est le cas qu'un check ordinaire ne couvre pas : **un statut
requis mais absent bloque aussi le merge.** Toujours sur `avolo-shorts`, une PR passée en « prêt »
n'a produit *aucun run* — l'événement `ready_for_review` figure bien dans la timeline, le workflow
n'a jamais démarré. Un check requis y aurait bloqué le merge ; un commentaire absent, lui, ne se
distingue pas d'une PR jugée irréprochable. C'est le pendant du piège documenté plus haut : une PR
en conflit n'émet aucun événement `pull_request`, donc aucune review, donc aucun signal.

⚠️ **N'activer `status-check` que là où la clé est posée.** Sans clé, l'action sort avant de rien
poser (c'est le silence promis aux PR venues d'un fork, qui n'ont pas les secrets) : le check reste
absent, et le merge reste bloqué sans recours. Sur un dépôt qui reçoit des contributions
extérieures, laisser `false`.

### Dire qu'une review arrive

`announce` est allumée par défaut. Avant le premier appel au modèle, Aristarque pose un commentaire
« review en cours » qui nomme les passes qui partent et lie le run ; le rapport final **remplace ce
commentaire en place**, par son marqueur `<!-- aristarque -->`.

Ça lève une ambiguïté qui coûtait cher. Une PR sans commentaire ne distinguait pas quatre choses :
la review n'a pas été déclenchée, elle tourne encore, la clé est absente (l'action est alors
*totalement silencieuse*), ou il n'y avait rien à relire. Une annonce répond du deuxième cas, et le
statut ci-dessus des trois autres.

Effet de bord voulu : une PR relue plusieurs fois — `@aristarque review` après corrections — ne
porte plus qu'**un seul** commentaire, le dernier. Les rapports périmés ne s'empilent plus sous le
courant.

### Le mix par passe

Les quatre appels d'une review ne demandent pas le même modèle. « Régression fonctionnelle » trace
des appelants et des chemins d'erreur : c'est une recherche, et la valeur de GLM-5.2 y est observée
sur de vraies PR. « Doctrine du dépôt » applique des règles écrites qu'elle a sous les yeux. La
fusion trie une trentaine de puces **sans avoir le code**. Payer les quatre au même tarif revient à
payer trois fois pour une profondeur dont une seule se sert.

Trois appels sur quatre partent donc sur `deepseek-v4-flash`, **sans rien configurer** :

| Appel | Modèle | `thinking` |
| --- | --- | --- |
| régression fonctionnelle | `glm-5.2:cloud` | `max` |
| doctrine du dépôt | `deepseek-v4-flash:cloud` | `high` |
| données et accès | `deepseek-v4-flash:cloud` | `high` |
| fusion | `deepseek-v4-flash:cloud` | `low` |

Ollama Cloud ne facture pas au token mais au **temps GPU**, par niveau d'usage. `glm-5.2:cloud` y
est classé **usage élevé**, `deepseek-v4-flash:cloud` **usage moyen** : déplacer trois appels sur
quatre les fait descendre d'un niveau, avec la seule clé Ollama et sans compte à ouvrir.

Deux façons de ne pas prendre ce mix : écrire `model:` à la main, ce qui remet les quatre appels
sur le modèle nommé, ou désigner un `provider:` autre qu'`ollama`, auquel cas le dépôt a pris la
main et on ne le renvoie pas ailleurs dans son dos.

#### Ce que le mix ne fait pas : envoyer moins de tokens

Le réagencement des prompts a déplacé du texte, il n'en a retiré aucun. Mesuré sur la même PR, à
contenu de disque identique :

| | avant | après |
| --- | --- | --- |
| entrée totale des trois passes | 1 580 701 car. | 1 580 669 car. |

Trente-deux caractères d'écart, soit 0,002 %. **Le mix ne réduit pas ce qui part, il change qui le
lit.** Sur la review de la PR #8, cela déplace 66 % des tokens d'entrée et 58 % des tokens de sortie
du modèle flagship vers un modèle d'un niveau d'usage en dessous.

Pour réduire ce qui part, le levier reste [le cran d'effort](#le-cran-deffort), mesuré à -13,5 % sur
une PR comparable. Et le premier poste de dépense n'est plus l'entrée : la passe de régression a
rendu 41 681 tokens de sortie, dont 98 % de raisonnement.

#### Une clé DeepSeek achète le cache de préfixe

Le même modèle, servi en direct par `api.deepseek.com`, ajoute ce qu'Ollama n'a pas : un cache de
préfixe automatique, facturé **trente et une fois moins cher** que l'entrée fraîche (0,014 $/M
contre 0,44 $/M en heure pleine). Poser `deepseek-api-key` suffit à basculer les trois appels sur
cette route.

⚠️ DeepSeek est passé le **16 août 2026** d'un tarif plat à un tarif horaire : heures pleines de
01:00 à 04:00 et de 06:00 à 10:00 UTC, moitié prix le reste du temps. `estimateCost` applique le
régime de l'heure de l'appel. Toute table de prix antérieure à cette date est fausse d'un facteur
trois.

« Doctrine » et « données » visent volontairement le **même couple provider + modèle**, ce qui leur
permet de partager ce cache. Deux conditions, que l'action tient toutes les deux :

1. **Le préfixe doit être identique octet pour octet.** Le prompt système ne porte plus que le
   préambule commun ; l'objectif de la passe est passé en dernier message. Les fichiers importés
   sont rendus en fin de contexte, si bien que le prompt de « doctrine », qui ne les reçoit pas au
   cran `balanced`, est un préfixe **strict** de celui de « données ». Un test unitaire épingle
   cette propriété, sans appeler personne.
2. **Le second appel doit partir après le premier**, un cache s'écrivant à la fin de l'entrée qui
   l'a produit. Les passes qui partagent une destination **s'enchaînent** donc, la plus courte
   d'abord.

#### Deux appels ne partent jamais ensemble vers le même modèle

Le séquencement vaut pour **tous** les providers, y compris ceux qui n'ont pas de cache. Ce n'est
pas ce que faisait la première version : elle n'enchaînait que ce qui avait un cache à gagner, et
laissait donc partir ensemble deux requêtes qu'Ollama ne sait pas servir en même temps.

Mesuré sur `avolo-shorts`, trois PR de suite : trois grosses requêtes simultanées sur un même
compte, et les deux qui partagent un modèle rendent un contenu **vide** après trois minutes de
génération. Deux passes sur trois perdues, à chaque review.

| Appel | En parallèle de | Entrée | Résultat |
| --- | --- | --- | --- |
| doctrine (flash), en local | rien | **173 109** | aboutit |
| doctrine (flash), en CI | 2 autres appels | ~134 000 | **vide** |
| données (flash), en CI | 2 autres appels | ~134 000 | **vide** |
| régression (glm-5.2), en CI | 2 autres appels | 366 547 | aboutit |

La ligne qui tranche est la première : le prompt **le plus gros** aboutit quand il part seul, et le
plus petit échoue quand il part accompagné. Ce n'est donc pas la taille du contexte, c'est la
concurrence. Chez un provider qui cache, la mise en file achète des tokens ; chez les autres, elle
achète des passes qui aboutissent.

⚠️ **Le séquencement change l'arithmétique du `timeout-minutes` du job.** Le mur vaut
`(taille du plus gros groupe séquencé + 1) × timeout-minutes`, la fusion étant le `+ 1` :

| Configuration | Plus gros groupe | Mur théorique |
| --- | --- | --- |
| défaut (mix actif) | 2 (doctrine puis données) | 3 × 15 = **45 min** |
| `model:` écrit à la main | 3 (les trois passes, même modèle) | 4 × 15 = **60 min** |

La seconde ligne est le piège : écrire `model:` remet les quatre appels sur un seul modèle, donc
les trois passes dans le même groupe. Un `timeout-minutes: 45` y couperait la review pendant la
fusion, sans laisser le temps de poster le commentaire d'échec. Baisse `timeout-minutes` ou monte
le budget du job.

Mesuré sur cette PR, on est loin du pire cas, la régression pesant à elle seule cinq fois les deux
autres réunies :

| Appel | Modèle | Durée |
| --- | --- | --- |
| données et accès | `deepseek-v4-flash:cloud` | 67 s |
| doctrine du dépôt | `deepseek-v4-flash:cloud` | 89 s |
| régression fonctionnelle | `glm-5.2:cloud` | **470 s** |
| fusion | `deepseek-v4-flash:cloud` | 18 s |

Rien dans le code ne garantit pourtant ce rapport.

Mesuré sur la PR #7 de ce dépôt, ~140 000 tokens d'entrée par passe : la seconde passe a reçu
**141 694 tokens en cache sur 149 831**, et son coût est tombé de 0,0628 $ à 0,0057 $.
`--count-only` mesure le préfixe partagé avant tout appel, et prévient s'il s'effondre :

```
« doctrine du dépôt » puis « données et accès » : même destination,
donc lancées à la suite pour que la seconde rejoue le préfixe de la première en cache.
préfixe commun : 487 202 caractères, ~139 201 tokens réutilisables.
```

#### Régler autrement

- **Une passe seulement** : `data-model: deepseek-v4-pro` est la première escalade prévue si le
  recall de « données et accès » baisse sur de vraies PR. ⚠️ Cela la sépare de « doctrine », qui
  perd alors leur cache commun.
- **Un autre endpoint** : `provider: openai` avec `openai-base-url` et `openai-api-key` vise
  n'importe quelle API OpenAI-compatible. Nomme aussi un `model` : cet endpoint n'a pas de
  catalogue connu, donc aucun défaut. Et `openai-prefix-cache: true` si tu sais qu'il cache les
  préfixes, ce qu'« OpenAI-compatible » ne garantit pas : par défaut on ne séquence rien chez lui,
  pour ne pas payer du temps contre une économie imaginaire.
- **Le raisonnement** : un `<passe>-thinking` écrit à la main échappe au cran d'`effort`, pour que
  deux mécanismes ne se disputent pas la même valeur.

Une passe dont le provider n'a pas de clé retombe sur le provider global, avec un avertissement.
Si celui-ci n'en a pas non plus, la passe n'est pas lancée et le pied de page le déclare : le job
reste vert dans tous les cas.

⚠️ **`seed` n'est pas transmis à DeepSeek en direct**, qui ne le documente pas : ces passes varient
d'une exécution à l'autre. L'action le dit une fois dans le journal.

### Le cran d'effort

L'entrée d'une review se dépense d'un coup, dans les secondes qui suivent le lancement. L'input
`effort` règle son ampleur, et rien n'est économisé en douce : tout ce qu'un cran retire est
déclaré dans le pied de page du commentaire.

| | `full` | `balanced` (défaut) | `lean` |
| --- | --- | --- | --- |
| Fichiers touchés | entiers | par extraits au-delà de 250 lignes | par extraits au-delà de 120 lignes |
| Fichiers importés | aux trois passes | pas à « doctrine » | à « régression » seule, budget 120 000 |
| Passes | les trois | une passe qu'une PR ne peut pas déclencher n'est pas lancée | idem |
| `thinking` | inchangé | inchangé | deux crans plus bas sur « doctrine », un sur « données » |

`full` reproduit le comportement d'avant ce réglage, à deux exceptions près qui valent à tous les
crans : les doublons purs ne partent plus (contenu d'un fichier seulement renommé, corps du diff
d'un fichier neuf dont le contenu numéroté suit), et la passe « doctrine » ne tourne pas sans
doctrine. Aucune de ces deux coupes ne retire au modèle quoi que ce soit qu'il n'ait déjà.

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
  appel                           destination                     consignes    contexte       total    ≈ tokens
  passe régression fonctionnelle  ollama/glm-5.2:cloud                8 208     520 705     528 913    ~151 118
  passe doctrine du dépôt         ollama/deepseek-v4-flash:cloud      7 828     495 127     502 955    ~143 701
  passe données et accès          ollama/deepseek-v4-flash:cloud      8 092     520 705     528 797    ~151 085
  ────────────────────────────────────────────────────────────────────────────────────────────────────────────
  total entrée                                                                            1 560 665    ~445 904
  dont : diff 36 % · fichiers touchés 56 % · imports 5 % · système 2 % · reste 1 %
```

La ventilation est ce qui dit où couper, et elle ne se devine pas : sur ce dépôt le diff pèse
entre 10 et 37 % de l'entrée selon la PR, et les fichiers importés entre 0 et 11 %. Les tokens
sont estimés à partir des caractères ; les caractères, eux, sont exacts.

« consignes » regroupe le préambule commun **et** l'objectif de la passe, où que le message les
porte. Une colonne « ≈ entrée » apparaît en plus quand le tarif du modèle est connu, ce qui n'est
pas le cas d'Ollama Cloud, vendu au temps GPU et non au token ; elle ne chiffre alors que l'entrée,
au tarif plein et sans cache, la sortie n'étant pas devinable avant l'appel.

Une review dont au moins une passe aboutit imprime aussi une ligne `::stats::{…}` en JSON,
greppable dans un journal de CI, qui porte les compteurs. `--count-only`, qui n'appelle rien, n'en
imprime pas. Chaque appel y porte désormais son provider, son modèle, sa part d'entrée servie par
le cache, son coût estimé et ses tokens de raisonnement quand le provider les expose. Les
compteurs `promptTokens` et `evalTokens` s'y appellent maintenant `inputTokens` et `outputTokens` :
un dépouillement écrit contre l'ancien nom est à reprendre.

**Les trouvailles brutes n'y figurent qu'en local**, sous `--dry-run`. La passe « données et
accès » cherche des secrets : une trouvaille qui en cite un le recopierait dans le journal d'un
runner. Comparer deux réglages sur leurs trouvailles est un geste de réglage, qui se fait depuis un
poste ; en CI la ligne garde les compteurs, qui ne citent rien. Et c'est bien sur les trouvailles
qu'il faut comparer : les tokens disent lequel est le moins cher, jamais lequel a perdu quelque
chose.

### Pourquoi pas une review agentique

Le runner sort bien le dépôt, et `glm-5.2:cloud` accepte les outils : rien n'empêche techniquement
de donner au modèle un `read_file` et de le laisser chercher au lieu de tout lui envoyer.

L'arithmétique, si. Un aller-retour agentique ne renvoie pas la question, il renvoie tout ce qui
précède. Sans cache de prompt, `n` tours coûtent `n` fois le socle : avec un socle de 50 000 tokens
et huit tours de lecture, l'addition passe 400 000 tokens là où l'envoi glouton en coûte 65 000.
Plus le relecteur travaille bien, plus il coûte.

Or Ollama Cloud ne sert pas de cache de prompt ([#15600](https://github.com/ollama/ollama/issues/15600),
[#16714](https://github.com/ollama/ollama/issues/16714)). Un LSP n'y changerait rien non plus,
puisqu'il rétrécit les réponses des outils, pas le socle renvoyé à chaque tour.

Le raccourci symétrique, lui, a fini par exister ailleurs : chez un provider qui cache les
préfixes, faire partager aux passes un préfixe identique **fait** rejouer le socle à un
trente-et-unième du tarif. C'est ce que fait [le mix par passe](#le-mix-par-passe) avec une clé
DeepSeek. Une review agentique resterait hors de portée pour autant : elle renverrait un socle qui
**grossit** à chaque tour, là où deux passes partagent un socle figé. Le cache amortit la
répétition, pas l'accumulation.

À rouvrir le jour où le mode agentique tournera chez un provider dont le cache couvre aussi les
tours intermédiaires.

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

Trois lectures indépendantes tournent donc sur le même contexte, avec un seul objectif chacune :

1. **Régression fonctionnelle** : côté appelant, chemins d'erreur, entrées limites, état et
   ordonnancement, ce que le changement a oublié.
2. **Doctrine du dépôt** : ce que disent `CLAUDE.md` et consorts, et rien d'autre.
3. **Données et accès** : frontières de rôle, secrets, données personnelles.

Une quatrième requête les fusionne : elle déduplique, arbitre les sévérités, applique
`max-findings` et rédige les cinq rubriques. **Elle ne reçoit pas le code**, et son prompt le lui
dit : son travail est de trier, pas de relire, et un modèle qui complète de mémoire une trouvaille
trop courte l'invente.

Ce que ça coûte : le contexte part trois fois, et une fois seulement là où le cache de préfixe le
rejoue (voir [Le mix par passe](#le-mix-par-passe)). Ce que ça évite : un axe expédié parce que deux
autres tenaient la tête du modèle. Le mur du job vaut « le groupe le plus lent plus la fusion », pas
la somme des passes, d'où le `timeout-minutes: 40` de l'exemple.

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
npx --yes -p 'github:JulienCr/gh-actions#v3' pr-review 154 --dry-run
npx --yes -p 'github:JulienCr/gh-actions#v3' pr-review 154 --model qwen3-coder:480b-cloud --dry-run
```

Le `#v3` n'est pas décoratif : sans lui, npx prend la branche par défaut, et un réglage validé en
local tournerait sur un prompt différent de celui de la CI. Épingle la même version des deux côtés.

Corollaire utile : une version passée sert de point de comparaison. `#v1.1.0` est la dernière à
relire en un seul appel et sans contexte importé ; la lancer sur la même PR, à graine égale, dit
si un changement de prompt a rapporté des trouvailles ou seulement du bruit.

Chaque clé se prend dans `<PROVIDER>_API_KEY`, sinon dans 1Password à la référence
`<PROVIDER>_API_KEY_REF`, pour qu'elle ne traîne ni dans un `.env` ni dans l'historique du shell :

| Provider | Variable | Référence 1Password par défaut |
| --- | --- | --- |
| `ollama` | `OLLAMA_API_KEY` | `op://Personal/Ollama/add more/api_key` |
| `deepseek` | `DEEPSEEK_API_KEY` | `op://Personal/DeepSeek/api_key` |

Seuls les providers que la review va réellement solliciter sont cherchés : faire clignoter
1Password pour une clé dont aucune passe n'a besoin serait du bruit.

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
git tag v3.0.0 && git push origin v3.0.0
```

Le workflow `release.yml` rejoue les tests et la garde du bundle, puis déplace le tag majeur
`v3`. Les dépôts épinglés sur `@v3` prennent la correction à leur prochaine PR, sans rien
changer chez eux. `@v3.0.0` pour figer une version précise.

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

### Migrer de `v2` à `v3`

`v2` envoyait les quatre appels au même modèle. `v3` en déplace trois sur `deepseek-v4-flash`, qui
est à un niveau d'usage moindre chez Ollama, et peut passer par l'API DeepSeek pour y gagner un
cache de préfixe. Voir [Le mix par passe](#le-mix-par-passe).

Rien n'est à changer dans un workflow existant, hormis le tag :

```yaml
      - uses: JulienCr/gh-actions/pr-review@v3 # au lieu de @v2
```

Ce qui change quand même, et qu'il vaut mieux savoir :

- **trois des quatre appels changent de modèle.** Un dépôt qui tient à `glm-5.2:cloud` partout
  écrit `model: glm-5.2:cloud`, ce qui remet les quatre dessus ;
- **la ligne `::stats::` a renommé deux compteurs**, `promptTokens` et `evalTokens` devenant
  `inputTokens` et `outputTokens`. Un dépouillement écrit contre les anciens noms est à reprendre ;
- **le pied de page ne nomme plus un modèle unique** mais chaque destination, avec la part servie
  par le cache et le coût estimé quand le tarif est connu.

Aucun input n'a été retiré ni renommé, et `@v2` continue de fonctionner.
