# Lancer serveur (dépôt) — plugin Obsidian

Plugin Obsidian (usage perso, `isDesktopOnly: true`) qui pilote le serveur de
dépôt de fichiers élèves depuis Obsidian : menu contextuel sur un PDF / `.doc` /
`.md` pour lancer `serveur.py` avec le bon `--cours`, `--document-seance`,
`--support-cours` ou `--qcm`, entrée de ruban pour un dépôt simple, exposition
d'un dossier en HTTP (`expose_dir.py`), un éditeur de `config/cours/*.json`, et
la correction automatique des devoirs (`../corrector.py`).

### Correction automatique

Clic droit sur un PDF → *Corriger un devoir · ce PDF comme document de séance*
puis, sur un autre PDF, *… comme corrigé professeur*. Une fois les deux
renseignés (même cours, résolu par `CLASSE_DIR` comme pour les autres rôles),
le plugin :

1. cherche dans le vault les fiches de dépôt (`.md`) avec `a_noter: true` pour
   ce cours, propose le choix du `type` s'il y en a plusieurs ;
2. lance `../corrector_cli.py` en sous-processus sur les copies élèves
   trouvées, et ouvre un onglet affichant les résultats au fil de l'eau
   (question / réponse / note éditable / justification par élève) ;
3. le bouton **Valider tout** écrit `note` et `corrige` dans le frontmatter de
   chaque fiche de dépôt, et le détail de la correction (tableau question /
   réponse / note / justification, même présentation que le rapport) dans le
   **corps** de la fiche — une correction précédente pour ce devoir y est
   remplacée, jamais dupliquée.

### Blocage internet pendant un contrôle

Menu ruban (icône « server ») → *Bloquer Internet* : bascule à cocher,
indépendante d'un fichier précis. Activée, elle ajoute `--bloquer-internet` au
prochain lancement/relance du serveur (relance immédiatement si un serveur
tourne déjà) — voir [`../README.md`](../README.md#blocage-internet-proxy-pendant-un-contrôle)
pour la portée réelle du blocage et ses limites. Se réinitialise à chaque
arrêt du serveur (pas de blocage qui reste armé par oubli d'une séance à
l'autre).

Le même menu ruban donne aussi accès à *Voir le journal du serveur en
direct* : onglet Obsidian qui tail `~/serveur.log` (mode dégradé volontaire :
pas de spawn attaché sur `serveur.py`, qui reste lancé détaché — voir
`lancerPythonDetache` dans `main.js` — pour ne jamais risquer de geler le
serveur si personne ne lit plus sa sortie).

Tout est dans `main.js` : Obsidian charge le plugin sans passer par un
`require()` Node classique (pas de résolution relative fiable vers un fichier
voisin), donc pas de découpage possible en plusieurs fichiers `.js` sans
bundler — voir « Ce dossier est la source de vérité » ci-dessous.

Voir [`../SPEC.md`](../SPEC.md) pour le cahier des charges du serveur.

## Ce dossier est la source de vérité

`main.js` est écrit **à la main** (pas de build, pas de TypeScript, pas
d'esbuild) : c'est à la fois la source et l'artefact livré — et ça doit rester
un seul fichier (voir la mésaventure ci-dessous). `manifest.json` va avec.

⚠️ Piège vérifié en pratique : `require("./un-autre-fichier.js")` échoue au
chargement du plugin (`Cannot find module`), même si le fichier existe bien à
côté de `main.js` sur le disque — Obsidian ne charge pas `main.js` avec un
`require` Node standard résolu depuis le dossier réel du plugin. Seuls les
modules Node intégrés (`path`, `fs`, `os`, `child_process`…) et `require("obsidian")`
fonctionnent. Toute nouvelle fonctionnalité doit donc être écrite directement
dans `main.js`, pas dans un fichier séparé chargé par `require()`.

Le vault de test [`../dépot-test/reseaux/test-1CIEL1`](../dépot-test/reseaux/test-1CIEL1)
n'a **pas de copie** : son dossier de plugin contient deux liens symboliques
vers ce dossier-ci —

```
dépot-test/.../.obsidian/plugins/lancer-serveur-depot/main.js       -> ../../../../../../obsidian-lancer-serveur-depot/main.js
dépot-test/.../.obsidian/plugins/lancer-serveur-depot/manifest.json -> ../../../../../../obsidian-lancer-serveur-depot/manifest.json
```

Éditer `main.js` ici (ou via le vault de test, c'est le même fichier), puis
recharger le plugin dans Obsidian (`Ctrl+P` → « Recharger sans sauvegarder », ou
désactiver/réactiver le plugin). Le vault de test **ne passe pas par BRAT** :
c'est le poste de développement.

## Distribuer les mises à jour aux autres vaults : BRAT

Comme pour [`obsidian-vault-sync`](../obsidian-vault-sync/), les **autres**
vaults reçoivent les mises à jour via **BRAT** (Beta Reviewer's Auto-update
Tool), qui installe/actualise un plugin depuis les *releases* d'un dépôt GitHub.
Le plugin n'est pas publié sur le store communautaire (usage perso, chemins en
dur vers `/home/ravard/workspace/cours/transfert_fichier`).

Dépôt : <https://github.com/oravard/obsidian-lancer-serveur-depot>

### Mise en place, une fois par vault

1. Installer **BRAT** depuis Réglages → Modules communautaires → Parcourir
   (chercher « BRAT »), puis l'activer. *(Le vault de test l'a déjà.)*
2. Réglages de BRAT → « Add Beta plugin » → coller
   `https://github.com/oravard/obsidian-lancer-serveur-depot` → valider (BRAT
   installe la dernière release taguée, dans un dossier nommé
   `obsidian-lancer-serveur-depot`).
3. Activer « Lancer serveur (dépôt) » dans Réglages → Modules communautaires.
4. Si ce vault avait déjà une **copie manuelle** du plugin (dossier
   `lancer_serveur_depot`), la **supprimer** : deux dossiers déclarant le même
   `id` (`lancer-serveur-depot`) se marchent dessus.

### Publier une mise à jour

Après avoir modifié `main.js` et **bumpé `version`** dans `manifest.json` :

```sh
git add -A && git commit -m "…"
./release.sh
```

`release.sh` vérifie que l'arbre git est propre, tague la version (tag =
`version` de `manifest.json` **exactement**, sans préfixe `v` — exigé par BRAT et
Obsidian), pousse, et crée la release GitHub avec `main.js` + `manifest.json` en
pièces jointes (via `gh` s'il est installé et authentifié, sinon le script
affiche les 2 fichiers à joindre à la main).

Ensuite, sur chaque vault : BRAT → « Check for updates » (ou attendre sa
vérification périodique) → la nouvelle version est installée.

## Contrainte connue : chemins en dur

Le haut de `main.js` fixe des chemins absolus :

```js
const SERVEUR_PY       = "/home/ravard/workspace/cours/transfert_fichier/serveur.py";
const CONFIG_COURS_DIR = "/home/ravard/workspace/cours/transfert_fichier/config/cours";
const EXPOSE_DIR_PY    = "/home/ravard/workspace/cours/transfert_fichier/expose_dir.py";
const CORRECTOR_CLI_PY = "/home/ravard/workspace/cours/transfert_fichier/corrector_cli.py";
```

Tous les vaults qui reçoivent ce `main.js` via BRAT doivent donc tourner sur une
machine où le dépôt est à ce chemin (le portable de classe). Un poste où le
dépôt est ailleurs aurait besoin d'un fork ou d'un passage de ces constantes en
réglages du plugin — non fait ici.
