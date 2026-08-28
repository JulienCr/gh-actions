# Faire apparaître Aristarque dans la liste des reviewers

Aristarque poste un commentaire de conversation. Il n'apparaît donc pas dans l'encart
« Reviewers » d'une PR, et ce qu'il produit ne déclenche aucun workflow en aval. Ce document
dit quoi changer pour l'y mettre, et ce qui reste hors de portée.

## Ce que fait Codex, ce que fait Copilot

Relevé le 28 août 2026 sur `openai/codex` :

```
PR 41207   reviews: chatgpt-codex-connector[bot]   requested_reviewers: []
PR 41205   reviews: chatgpt-codex-connector[bot]   requested_reviewers: []
PR 41183   reviews: chatgpt-codex-connector[bot]   requested_reviewers: []
```

Codex n'a jamais été demandé comme reviewer. Il figure dans l'encart parce qu'il a **soumis une
review** : `POST /pulls/{n}/reviews`, `state: COMMENTED`, avec des commentaires inline ancrés sur
`path` et `line`. L'encart liste les reviewers demandés *et* ceux qui ont relu. C'est ce qui
explique qu'il n'ait pas le bouton de re-request que Copilot affiche à côté de lui.

Copilot est demandable : état pending, re-request, demande automatique par ruleset. GitHub l'a
câblé, ce n'est pas une capacité ouverte. Une app tierce passée à cette API rend
`Could not resolve user with login 'monapp[bot]'`. La demande est déposée chez GitHub sans
engagement de leur part : <https://github.com/orgs/community/discussions/193037>.

La cible atteignable est donc celle de Codex, pas celle de Copilot.

## Étape 1 : poster une review au lieu d'un commentaire

Aujourd'hui `postComment` dans `pr-review/src/gh.ts` appelle `gh pr comment`, qui crée un
commentaire d'issue. La review passe par un autre endpoint :

```bash
gh api repos/$repo/pulls/$pr/reviews --input - <<'JSON'
{
  "commit_id": "<headSha>",
  "event": "COMMENT",
  "body": "…le rapport de synthèse…",
  "comments": [
    { "path": "src/x.ts", "line": 42, "side": "RIGHT", "body": "…une trouvaille…" }
  ]
}
JSON
```

`headSha` est déjà dans `PrMeta`. Le renseigner fait passer la review en « outdated » quand la
branche bouge, ce que le commentaire upserté ne sait pas faire.

Ce que ça apporte :

- Aristarque dans l'encart des reviewers, avec son état de review ;
- des événements `pull_request_review` et `pull_request_review_comment` au lieu d'`issue_comment` ;
- surtout, un `GET /pulls/{n}/comments` qui rend `path`, `line`, `diff_hunk` et `body`. Un agent
  correcteur consomme du structuré au lieu de parser du markdown.

## Trois pièges

**Un `line` hors du diff rend 422, et fait échouer la review entière.** Pas seulement la puce
fautive : tout le POST. Ça contredit frontalement la doctrine « la seule chose qu'on refuse est le
silence ». Prévoir le repli sur une review sans `comments`, corps seul, plutôt que de perdre le
rapport.

**`event: REQUEST_CHANGES` bloque le merge** jusqu'à ce que la review soit dismissée. Garder
`COMMENT` : le gate existe déjà, c'est le statut de commit `aristarque/review`.

**L'annonce et les commentaires inline ne cohabitent pas.** `PUT /pulls/{n}/reviews/{id}` ne
réécrit que le corps, pas les commentaires inline. Le plus simple est de laisser l'annonce
« review en cours » où elle est, en commentaire d'issue, puis de ne poser la review qu'à la fin.

## Étape 2 : une GitHub App, pour l'identité et pour la chaîne d'événements

Un événement produit avec `GITHUB_TOKEN` ne déclenche aucun autre workflow, c'est la garde
anti-récursion de GitHub Actions. Une review postée avec `github.token` n'allumera donc pas le
workflow de corrections. Si le déclenchement en aval est le but, il faut une identité tierce.

C'est là que la GitHub App reprend son intérêt, non pour le slot de reviewer, mais pour signer les
reviews et rallumer la chaîne :

1. créer une App « Aristarque », permissions `pull_requests: write`, `contents: read`,
   `metadata: read`, `commit statuses: write` ;
2. ne configurer **ni serveur ni webhook**. Elle ne sert que de porteuse de jeton ;
3. dans le workflow, `actions/create-github-app-token`, puis passer le jeton obtenu en
   `github-token` de l'action.

La review est alors signée `aristarque[bot]`, avec son avatar. Elle déclenche les workflows en
aval. Coût : App ID et clé privée en secrets, plus l'App installée sur chaque dépôt consommateur
(ou des secrets d'organisation si le dépôt appartient à une org).

Poser une garde `if: github.actor != 'aristarque[bot]'` sur le workflow correcteur. Sans elle, la
correction relance la review qui relance la correction.

## Ce qui reste fermé

L'état pending, le bouton de re-request, `CODEOWNERS` et les required reviewers restent hors
d'atteinte d'une app tierce, App maison comprise. Ces quatre choses supposent un compte que GitHub
sait résoudre comme utilisateur.

## Repli : un compte machine

Un compte utilisateur dédié avec un PAT est, lui, vraiment demandable comme reviewer. Il coche les
quatre points ci-dessus. Le prix : un compte supplémentaire à gérer, un PAT à faire tourner, une
licence sur un plan d'organisation payant.
