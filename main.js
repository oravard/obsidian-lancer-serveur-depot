const { Plugin, Notice, SuggestModal, TFile, TFolder, Modal, App, ItemView } = require("obsidian");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");


// ==== À ADAPTER À TON ENVIRONNEMENT ====
const PYTHON_BIN = "python3"; // ou chemin absolu si "python3" n'est pas dans le PATH lancé par Obsidian
const SERVEUR_PY = "/home/ravard/workspace/cours/transfert_fichier/serveur.py";
const CONFIG_COURS_DIR = "/home/ravard/workspace/cours/transfert_fichier/config/cours"; // dossier contenant les <identifiant>.json
const LOG_PATH = path.join(os.homedir(), "serveur.log"); // stdout/stderr de serveur.py (mode append)
const EXPOSE_DIR_PY = "/home/ravard/workspace/cours/transfert_fichier/expose_dir.py";
const EXPOSE_DIR_PORT = 8000; // port d'expose_dir.py (serveur.py utilise le 80, pas de conflit)
const EXPOSE_LOG_PATH = path.join(os.homedir(), "expose_dir.log"); // stdout/stderr d'expose_dir.py
const CORRECTOR_CLI_PY = "/home/ravard/workspace/cours/transfert_fichier/corrector_cli.py";
const EVALUATION_PROJET_PY = "/home/ravard/workspace/cours/transfert_fichier/evaluation_projet.py";
// evaluation_projet.py n'est aujourd'hui écrit que pour évaluer un document de
// spécifications (même limite que TYPE_DOCUMENT_EVALUATION_IA dans obsidian.py,
// côté serveur) : à élargir le jour où ce module saura traiter d'autres types.
const TYPE_DOCUMENT_EVALUATION_IA = "Spécifications";
// ========================================

// Racine du projet : dossier de serveur.py. C'est le BASE_DIR de depot.py, sur
// lequel sont ancrés les CLASSE_DIR relatifs des configs.
const BASE_DIR = path.dirname(SERVEUR_PY);

// Lit une config config/cours/<...>.json en tolérant les lignes de commentaire
// "//" (JSON strict ne les gère pas), comme _read_config_json() dans depot.py.
function lireConfigJson(cheminJson) {
  const brut = fs.readFileSync(cheminJson, "utf8");
  const sansCommentaires = brut
    .split("\n")
    .filter((ligne) => !ligne.trimStart().startsWith("//"))
    .join("\n");
  return JSON.parse(sansCommentaires);
}

// Énumère les configs de CONFIG_COURS_DIR et résout leur CLASSE_DIR selon la même
// règle que depot.py (load_config) : chemin absolu conservé tel quel, chemin
// relatif ancré sur BASE_DIR. classeDir vaut null si la config n'en déclare pas
// ou si elle est illisible (elle sera alors ignorée du filtrage).
function chargerConfigsCours() {
  return fs
    .readdirSync(CONFIG_COURS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const identifiant = f.replace(/\.json$/, "");
      let classeDir = null;
      try {
        const data = lireConfigJson(path.join(CONFIG_COURS_DIR, f));
        if (data.CLASSE_DIR) classeDir = path.resolve(BASE_DIR, data.CLASSE_DIR);
      } catch (e) {
        // config invalide : ignorée, comme list_cours_disponibles() dans depot.py
      }
      return { identifiant, classeDir };
    });
}

// Vrai si `identifiantCours` désigne un cours "projet" (Equipes/ et Projets/ à
// côté du dossier des notes élèves), même critère que get_equipes_dir()/
// get_projets_dir() côté Python (obsidian.py). Résout ELEVES_DIR selon la même
// règle que load_config() dans depot.py : ancré sur CLASSE_DIR (lui-même
// résolu par rapport à BASE_DIR) si déclaré, sinon directement sur BASE_DIR.
// Faux si la config est introuvable ou invalide, sans lever d'exception (sert
// à décider d'afficher ou non une action de menu).
function estCoursProjet(identifiantCours) {
  if (!identifiantCours) return false;
  const configPath = path.join(CONFIG_COURS_DIR, identifiantCours + ".json");
  try {
    const data = lireConfigJson(configPath);
    if (!data.ELEVES_DIR) return false;
    const racine = data.CLASSE_DIR ? path.resolve(BASE_DIR, data.CLASSE_DIR) : BASE_DIR;
    const elevesDir = path.resolve(racine, data.ELEVES_DIR);
    const racineNotes = path.dirname(elevesDir);
    return (
      fs.existsSync(path.join(racineNotes, "Equipes")) &&
      fs.existsSync(path.join(racineNotes, "Projets"))
    );
  } catch (e) {
    return false;
  }
}

// Vrai si `fichier` est situé dans l'arborescence de `dossier`.
function cheminEstDans(dossier, fichier) {
  const rel = path.relative(dossier, fichier);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Vrai si `a` et `b` désignent le même dossier, ou si l'un contient l'autre.
function dossiersLies(a, b) {
  return a === b || cheminEstDans(a, b) || cheminEstDans(b, a);
}

// Valide le texte brut d'un config/cours/<identifiant>.json avant enregistrement,
// selon les mêmes règles que depot.load_config : types_documents non vide, DEPOT_ROOT
// et ELEVES_DIR renseignés, CLASSE_DIR optionnel (chaîne s'il est présent),
// types_notes optionnel (liste de types, ou objet { type: barème > 0 }, chaque type
// devant appartenir à types_documents). Les lignes de commentaire "//" sont
// tolérées, comme côté serveur (_read_config_json).
// Retourne null si tout est correct, sinon un message d'erreur à afficher.
function validerConfigCours(brut) {
  let data;
  try {
    const sansCommentaires = brut
      .split("\n")
      .filter((ligne) => !ligne.trimStart().startsWith("//"))
      .join("\n");
    data = JSON.parse(sansCommentaires);
  } catch (e) {
    return "JSON invalide : " + e.message;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return "Le contenu doit être un objet JSON { … }.";
  }
  if (!Array.isArray(data.types_documents) || data.types_documents.length === 0) {
    return "« types_documents » doit être une liste non vide.";
  }
  if (!data.types_documents.every((t) => typeof t === "string" && t.trim())) {
    return "« types_documents » ne doit contenir que des chaînes non vides.";
  }
  if (typeof data.DEPOT_ROOT !== "string" || !data.DEPOT_ROOT.trim()) {
    return "« DEPOT_ROOT » doit être une chaîne non vide.";
  }
  if (typeof data.ELEVES_DIR !== "string" || !data.ELEVES_DIR.trim()) {
    return "« ELEVES_DIR » doit être une chaîne non vide.";
  }
  if (
    data.CLASSE_DIR !== undefined &&
    (typeof data.CLASSE_DIR !== "string" || !data.CLASSE_DIR.trim())
  ) {
    return "« CLASSE_DIR » doit être une chaîne non vide, ou être absent.";
  }

  if (data.types_notes !== undefined) {
    let tn = data.types_notes;
    if (Array.isArray(tn)) {
      if (!tn.every((t) => typeof t === "string" && t.trim())) {
        return "« types_notes » (liste) ne doit contenir que des chaînes non vides.";
      }
      tn = Object.fromEntries(tn.map((t) => [t, 20]));
    }
    if (typeof tn !== "object" || tn === null || Array.isArray(tn)) {
      return "« types_notes » doit être une liste, ou un objet { type: barème }.";
    }
    for (const [nom, bareme] of Object.entries(tn)) {
      if (!data.types_documents.includes(nom)) {
        return `« types_notes » : « ${nom} » n'est pas dans types_documents.`;
      }
      if (typeof bareme !== "number" || !Number.isFinite(bareme) || bareme <= 0) {
        return `« types_notes » : barème invalide pour « ${nom} » (nombre strictement positif attendu).`;
      }
    }
  }

  return null;
}

// Première adresse IPv4 non-loopback de la machine (celle à taper côté iPad).
function ipLocale() {
  for (const cartes of Object.values(os.networkInterfaces())) {
    for (const carte of cartes || []) {
      if (carte.family === "IPv4" && !carte.internal) return carte.address;
    }
  }
  return "127.0.0.1";
}

// Lance `PYTHON_BIN scriptArgs` en processus détaché (survit à la fermeture
// d'Obsidian), après un `pkill -f matchKill` pour ne pas empiler les instances.
// stdout/stderr sont ajoutés à logPath. `onStarted()` est appelé une fois le
// processus lancé ; sur sortie en code non nul (plantage au démarrage),
// `onCrash(code)` est appelé puis un LogModal affiche la portion de log de ce
// lancement. Un arrêt volontaire (pkill, clic sur la barre de statut) sort par
// signal (code null) et est ignoré. Factorisé entre serveur.py et expose_dir.py.
function lancerPythonDetache({ app, scriptArgs, matchKill, logPath, titreErreur, onStarted, onCrash }) {
  let demarre = false;
  const demarrer = () => {
    if (demarre) return;
    demarre = true;

    let stdio = "ignore";
    let logOffset = 0; // taille du log juste avant CE lancement
    try {
      const logFd = fs.openSync(logPath, "a");
      logOffset = fs.fstatSync(logFd).size;
      fs.writeSync(
        logFd,
        `\n===== ${new Date().toISOString()} — ${PYTHON_BIN} ${scriptArgs.join(" ")} =====\n`
      );
      stdio = ["ignore", logFd, logFd];
    } catch (e) {
      new Notice("Impossible d'écrire dans " + logPath + " : " + e.message);
    }

    const proc = spawn(PYTHON_BIN, scriptArgs, { detached: true, stdio });
    proc.unref();
    if (Array.isArray(stdio)) fs.closeSync(stdio[1]); // l'enfant garde sa copie du fd

    proc.on("error", (err) => new Notice(titreErreur + " : " + err.message));
    proc.on("exit", (code) => {
      if (!code) return;
      let extrait;
      try {
        extrait = fs.readFileSync(logPath).toString("utf8", logOffset);
      } catch (e) {
        extrait = "(impossible de lire " + logPath + " : " + e.message + ")";
      }
      extrait = extrait.replace(/\x1b\[[0-9;]*m/g, "").trim(); // retire les couleurs ANSI
      if (onCrash) onCrash(code);
      new LogModal(app, `${titreErreur} (code ${code})`, extrait, logPath).open();
    });

    if (onStarted) onStarted();
  };

  const kill = spawn("pkill", ["-f", matchKill]);
  kill.on("close", demarrer);
  kill.on("error", demarrer); // pkill introuvable : on tente quand même
}

class ChoixCoursModal extends SuggestModal {
  constructor(app, identifiants, onChoose) {
    super(app);
    this.identifiants = identifiants;
    this.onChoose = onChoose;
    this.setPlaceholder("Choisir le cours pour cette séance…");
  }

  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.identifiants.filter((id) => id.toLowerCase().includes(q));
  }

  renderSuggestion(id, el) {
    el.createEl("div", { text: id });
  }

  onChooseSuggestion(id) {
    this.onChoose(id);
  }
}

// Choix du "type" de document à corriger (ex. "Contrôle"), parmi les types
// trouvés sur les fiches a_noter du cours concerné (voir demarrerCorrection).
class ChoixTypeModal extends SuggestModal {
  constructor(app, types, onChoose) {
    super(app);
    this.types = types;
    this.onChoose = onChoose;
    this.setPlaceholder("Type de document à corriger…");
  }

  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.types.filter((t) => t.toLowerCase().includes(q));
  }

  renderSuggestion(type, el) {
    el.createEl("div", { text: type });
  }

  onChooseSuggestion(type) {
    this.onChoose(type);
  }
}

// Choix du mode d'affichage pour le lancement en mode QCM : normal ou plein
// écran (--fullscreen). onChoose reçoit un booléen. En cas d'annulation (Échap),
// onChoose n'est pas appelé et l'appelant conserve son état.
class ChoixModeQcmModal extends SuggestModal {
  constructor(app, onChoose) {
    super(app);
    this.onChoose = onChoose;
    this.setPlaceholder("Mode d'affichage du QCM…");
  }

  getSuggestions(query) {
    const q = query.toLowerCase();
    return [
      { label: "Mode normal", fullscreen: false },
      { label: "Mode plein écran", fullscreen: true },
    ].filter((item) => item.label.toLowerCase().includes(q));
  }

  renderSuggestion(item, el) {
    el.createEl("div", { text: item.label });
  }

  onChooseSuggestion(item) {
    this.onChoose(item.fullscreen);
  }
}

// Menu du ruban : liste d'actions sur le serveur de dépôt. Chaque action est un
// objet { id, label, ... } ; onChoose reçoit l'objet choisi.
class ActionsServeurModal extends SuggestModal {
  constructor(app, actions, onChoose) {
    super(app);
    this.actions = actions;
    this.onChoose = onChoose;
    this.setPlaceholder("Serveur de dépôt…");
  }

  getSuggestions(query) {
    const q = query.toLowerCase();
    return this.actions.filter((a) => a.label.toLowerCase().includes(q));
  }

  renderSuggestion(action, el) {
    el.createEl("div", { text: action.label });
  }

  onChooseSuggestion(action) {
    this.onChoose(action);
  }
}

class ExampleModal extends Modal {
  constructor(app) {
    super(app);
	this.setContent('Look at me, I\'m a modal! 👀')
  }
}

// Modal d'information simple : un titre + une ou plusieurs lignes de texte.
class MessageModal extends Modal {
  constructor(app, titre, lignes) {
    super(app);
    this.titre = titre;
    this.lignes = Array.isArray(lignes) ? lignes : [lignes];
  }

  onOpen() {
    this.titleEl.setText(this.titre);
    for (const ligne of this.lignes) {
      this.contentEl.createEl("p", { text: ligne });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Éditeur du fichier config/cours/<identifiant>.json : zone de texte brute (les
// commentaires "//" sont préservés), validation (validerConfigCours) bloquant
// l'enregistrement tant que le contenu n'est pas conforme.
class EditeurConfigModal extends Modal {
  constructor(app, identifiant, cheminFichier) {
    super(app);
    this.identifiant = identifiant;
    this.cheminFichier = cheminFichier;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(`Configurer « ${this.identifiant} »`);
    this.modalEl.style.width = "min(760px, 92vw)";

    const chemin = contentEl.createEl("p", { text: this.cheminFichier });
    chemin.style.cssText = "margin:0 0 .5em; opacity:.7; font-size:.85em; word-break:break-all;";

    this.textarea = contentEl.createEl("textarea");
    this.textarea.spellcheck = false;
    try {
      this.textarea.value = fs.readFileSync(this.cheminFichier, "utf8");
    } catch (e) {
      new Notice("Lecture impossible : " + e.message);
    }
    this.textarea.style.cssText =
      "width:100%; height:48vh; box-sizing:border-box; resize:vertical; " +
      "font-family:var(--font-monospace); font-size:.9em; white-space:pre; " +
      "tab-size:2; padding:.6em; border-radius:6px; " +
      "background:var(--background-secondary); color:var(--text-normal); " +
      "border:1px solid var(--background-modifier-border);";

    this.erreurEl = contentEl.createEl("p");
    this.erreurEl.style.cssText =
      "color:var(--text-error); white-space:pre-wrap; min-height:1.2em; margin:.5em 0 0;";

    const barre = contentEl.createEl("div");
    barre.style.cssText = "margin-top:.75em; display:flex; gap:.5em; justify-content:flex-end;";
    barre.createEl("button", { text: "Annuler" }).addEventListener("click", () => this.close());
    const enregistrer = barre.createEl("button", { text: "Valider et enregistrer", cls: "mod-cta" });
    enregistrer.addEventListener("click", () => this.enregistrer());
  }

  enregistrer() {
    const brut = this.textarea.value;
    const erreur = validerConfigCours(brut);
    if (erreur) {
      this.erreurEl.setText("✗ " + erreur);
      return;
    }
    try {
      fs.writeFileSync(this.cheminFichier, brut, "utf8");
    } catch (e) {
      this.erreurEl.setText("✗ Écriture impossible : " + e.message);
      return;
    }
    new Notice(`Configuration « ${this.identifiant} » enregistrée.`);
    this.close();
  }

  onClose() {
    this.contentEl.empty();
  }
}

// Modal affichant un extrait de log : titre, chemin du fichier, contenu dans un
// <pre> défilant et sélectionnable, plus un bouton « Copier ». Sert à montrer la
// sortie d'erreur du serveur sans avoir à faire `cat ~/serveur.log`.
class LogModal extends Modal {
  constructor(app, titre, contenu, cheminLog) {
    super(app);
    this.titre = titre;
    this.contenu = contenu && contenu.trim() ? contenu : "(aucune sortie enregistrée)";
    this.cheminLog = cheminLog;
  }

  onOpen() {
    const { contentEl } = this;
    this.titleEl.setText(this.titre);

    const chemin = contentEl.createEl("p", { text: this.cheminLog });
    chemin.style.cssText = "margin:0 0 .5em; opacity:.7; font-size:.85em;";

    const pre = contentEl.createEl("pre", { text: this.contenu });
    pre.style.cssText =
      "max-height:50vh; overflow:auto; white-space:pre-wrap; word-break:break-word; " +
      "user-select:text; padding:.75em; border-radius:6px; background:var(--background-secondary);";

    const barre = contentEl.createEl("div");
    barre.style.cssText = "margin-top:.75em; text-align:right;";
    const copier = barre.createEl("button", { text: "Copier" });
    copier.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(this.contenu);
        copier.setText("Copié ✓");
      } catch (e) {
        new Notice("Copie impossible : " + e.message);
      }
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}



const VIEW_TYPE_CORRECTION = "correction-devoirs-view";

// Lance `pythonBin scriptArgs` en process attaché (pas détaché, contrairement à
// lancerPythonDetache : on veut lire son stdout au fil de l'eau, et il se
// termine de lui-même une fois le lot corrigé). stdout est traité comme du
// NDJSON : chaque ligne complète est parsée en JSON et transmise à
// onLigne(objet) dès qu'elle arrive. stderr est accumulé et transmis à
// onFin(code, stderr) à la fermeture du process (code null si tué par signal).
function lancerCorrectionJson({ pythonBin, scriptArgs, onLigne, onFin }) {
  const proc = spawn(pythonBin, scriptArgs, { stdio: ["ignore", "pipe", "pipe"] });
  let buffer = "";
  let stderr = "";

  proc.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const ligne = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!ligne) continue;
      try {
        onLigne(JSON.parse(ligne));
      } catch (e) {
        stderr += `(ligne stdout non JSON ignorée : ${ligne})\n`;
      }
    }
  });
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  proc.on("error", (err) => onFin(-1, stderr + err.message));
  proc.on("close", (code) => onFin(code, stderr));

  return proc;
}

// Vue affichant, pour chaque copie corrigée, un tableau Question / Réponse
// élève / Note (éditable) / Justification, avec la note finale recalculée en
// direct, et un bouton global "Valider tout" qui écrit le résultat dans le
// frontmatter de chaque fiche de dépôt correspondante.
class CorrectionView extends ItemView {
  constructor(leaf) {
    super(leaf);
    // Un élément par copie attendue : {id, ficheFile, eleve, bareme, questions,
    // statut: "en_attente"|"ok"|"erreur", erreur, valide}. `id` correspond au
    // champ "id" renvoyé par corrector_cli.py (chemin vault-relatif de la fiche).
    this.resultats = [];
    this.enCours = true;
    // Bascule d'affichage : "eleve" (un tableau Q/R/note/justification par
    // élève) ou "question" (un tableau élève/réponse/note/justification par
    // question, toutes copies confondues). Les deux modes lisent/modifient les
    // mêmes objets question (r.questions[i]) : éditer une note dans un mode se
    // reflète immédiatement dans l'autre.
    this.mode = "eleve";
    // État replié/déplié par question en mode "question" (indexé par position
    // dans questions[]) ; absent d'une clé = replié par défaut.
    this.questionPliee = {};
  }

  getViewType() {
    return VIEW_TYPE_CORRECTION;
  }

  getDisplayText() {
    return "Correction des devoirs";
  }

  getIcon() {
    return "check-check";
  }

  // Pré-remplit la liste des copies attendues avant le lancement du script,
  // triée par ordre alphabétique d'élève, pour afficher tout de suite un état
  // "en attente" par élève. Chaque section démarre repliée (voir renderEleve) :
  // seuls apparaissent le nom, l'état et — une fois corrigée — la note finale.
  initialiser(entrees, meta) {
    const tries = [...entrees].sort((a, b) =>
      (a.eleve || "").localeCompare(b.eleve || "", "fr", { sensitivity: "base" })
    );
    this.resultats = tries.map((e) => ({
      id: e.id,
      ficheFile: e.ficheFile,
      eleve: e.eleve,
      bareme: e.bareme,
      questions: null,
      statut: "en_attente",
      erreur: null,
      valide: false,
      plie: true,
    }));
    // Conservés pour le frontmatter/nom de fichier du rapport de correction
    // (voir genererRapport), pas utilisés pour l'affichage.
    this.cours = meta && meta.cours;
    this.type = meta && meta.type;
    this.enCours = true;
    // Poids w_i par question (indexé comme questions[]), tous à 1 par défaut
    // (équivalent à une simple moyenne, comportement historique) ; complété
    // dès que le nombre de questions est connu (voir assurerPoids).
    this.poids = null;
    this.render();
  }

  // Applique une ligne NDJSON reçue de corrector_cli.py au résultat correspondant.
  appliquerResultat(ligne) {
    const r = this.resultats.find((x) => x.id === ligne.id);
    if (!r) return;
    if (ligne.erreur) {
      r.statut = "erreur";
      r.erreur = ligne.erreur;
    } else {
      r.statut = "ok";
      r.questions = ligne.questions.map((q) => ({ ...q }));
    }
    this.render();
  }

  terminer() {
    this.enCours = false;
    this.render();
  }

  // Garantit un poids pour chacune des nbQuestions premières questions (1 par
  // défaut), sans écraser les poids déjà saisis par l'enseignant. Partagé par
  // toutes les copies de la vue : le poids d'une question est le même pour
  // tout le monde (voir renderPonderation).
  assurerPoids(nbQuestions) {
    if (!this.poids) this.poids = [];
    while (this.poids.length < nbQuestions) this.poids.push(1);
    return this.poids;
  }

  // Note finale = barème * (somme pondérée w_i·n_i) / (somme des poids w_i).
  // Avec tous les poids à 1 (valeur par défaut), équivaut à la simple moyenne
  // d'origine. Recalculée à chaque édition (note ou poids), jamais renvoyée
  // par le script Python.
  noteFinale(r) {
    if (!r.questions || r.questions.length === 0) return 0;
    const poids = this.assurerPoids(r.questions.length);
    let sommePonderee = 0;
    let sommePoids = 0;
    r.questions.forEach((q, i) => {
      const w = poids[i];
      sommePonderee += w * Number(q.note);
      sommePoids += w;
    });
    return sommePoids > 0 ? (r.bareme * sommePonderee) / sommePoids : 0;
  }

  // Résumé d'une ligne, utilisé à la fois dans l'en-tête repliable de la vue
  // et dans le <summary> du rapport de correction (voir construireRapport) :
  // les deux doivent toujours afficher exactement la même chose.
  resumeTexte(r) {
    if (r.statut === "en_attente") return "En attente…";
    if (r.statut === "erreur") return "Erreur";
    return `Note : ${this.noteFinale(r).toFixed(2)} / ${r.bareme}`;
  }

  async onOpen() {
    this.render();
  }

  render() {
    const container = this.contentEl;
    container.empty();
    container.addClass("correction-devoirs-view");
    // Mise en page en colonne : la barre d'actions reste fixe en haut, seule
    // la liste des élèves défile — inutile de remonter en haut pour valider.
    container.style.cssText = "display:flex; flex-direction:column; height:100%;";

    const barre = container.createDiv({ cls: "correction-barre-actions" });
    barre.style.cssText =
      "display:flex; align-items:center; gap:1em; padding:1em; flex:0 0 auto; " +
      "border-bottom:1px solid var(--background-modifier-border);";

    const nbOk = this.resultats.filter((r) => r.statut === "ok").length;
    const validerBtn = barre.createEl("button", { cls: "mod-cta", text: "Valider tout" });
    validerBtn.disabled = this.enCours || nbOk === 0;
    validerBtn.addEventListener("click", () => void this.validerTout());

    const modeBtn = barre.createEl("button", {
      text: this.mode === "eleve" ? "Afficher par question" : "Afficher par élève",
    });
    modeBtn.addEventListener("click", () => {
      this.mode = this.mode === "eleve" ? "question" : "eleve";
      this.render();
    });

    const statutTexte = this.enCours
      ? "Correction en cours…"
      : `${nbOk} copie(s) corrigée(s) sur ${this.resultats.length}`;
    barre.createSpan({ text: statutTexte });

    const ponderation = container.createDiv({ cls: "correction-ponderation-bloc" });
    ponderation.style.cssText = "flex:0 0 auto; max-height:30vh; overflow-y:auto;";
    this.renderPonderation(ponderation);

    const liste = container.createDiv({ cls: "correction-liste" });
    liste.style.cssText = "flex:1 1 auto; overflow-y:auto; padding:1em;";

    if (this.mode === "eleve") {
      for (const r of this.resultats) this.renderEleve(liste, r);
    } else {
      this.renderParQuestion(liste);
    }
  }

  // Liste des questions avec leur poids w_i (éditable), utilisés par
  // noteFinale pour toutes les copies. Reste vide tant qu'aucune copie n'est
  // encore corrigée (nombre/texte des questions pas encore connu). Le
  // recalcul se fait sur "change" (pas "input") pour ne pas perdre le focus du
  // champ à chaque frappe, un render() complet étant nécessaire pour
  // répercuter le nouveau poids sur toutes les notes affichées.
  renderPonderation(container) {
    const corrige = this.resultats.find((r) => r.statut === "ok");
    if (!corrige) return;

    const nbQuestions = corrige.questions.length;
    const poids = this.assurerPoids(nbQuestions);

    container.style.cssText += "padding:0 1em 1em; border-bottom:1px solid var(--background-modifier-border);";
    const titre = container.createEl("p", {
      text: "Pondération des questions (poids par défaut : 1 — n'affecte pas la somme, seulement sa répartition)",
    });
    titre.style.cssText = "font-weight:600; margin:.75em 0 .5em;";

    const table = container.createEl("table");
    table.style.cssText = "width:100%; border-collapse:collapse;";
    const tbody = table.createEl("tbody");

    for (let i = 0; i < nbQuestions; i++) {
      const tr = tbody.createEl("tr");
      const tdQ = tr.createEl("td", { text: `Q${i + 1} — ${corrige.questions[i].Q}` });
      tdQ.style.cssText = "padding:.2em .5em; vertical-align:top;";

      const tdW = tr.createEl("td");
      tdW.style.cssText = "padding:.2em .5em; vertical-align:top; white-space:nowrap;";
      const input = tdW.createEl("input", { type: "number" });
      input.min = "0";
      input.step = "0.5";
      input.value = String(poids[i]);
      input.style.width = "4.5em";
      input.addEventListener("change", () => {
        const v = parseFloat(input.value);
        poids[i] = Number.isFinite(v) && v >= 0 ? v : 0;
        this.render();
      });
    }
  }

  renderEleve(container, r) {
    const section = container.createDiv({ cls: "correction-eleve" });
    section.style.cssText = "margin-bottom:1em; padding-bottom:1em; border-bottom:1px solid var(--background-modifier-border);";

    // En-tête toujours visible : chevron + nom + résumé (état ou note finale)
    // + badge de validation. Cliquer dessus plie/déplie le détail ci-dessous.
    const header = section.createDiv({ cls: "correction-eleve-header" });
    header.style.cssText = "display:flex; align-items:center; gap:.5em; cursor:pointer;";
    header.addEventListener("click", () => {
      r.plie = !r.plie;
      this.render();
    });

    const chevron = header.createSpan({ text: r.plie ? "▶" : "▼" });
    chevron.style.cssText = "width:1em; display:inline-block; opacity:.7;";

    const nom = header.createSpan({ text: r.eleve });
    nom.style.fontWeight = "600";

    const resume = header.createSpan();
    resume.style.cssText = "opacity:.8;";
    resume.setText(this.resumeTexte(r));
    if (r.statut === "erreur") resume.style.color = "var(--text-error)";

    if (r.valide) {
      const badge = header.createSpan({ text: "✓ validé" });
      badge.style.color = "var(--text-success)";
    }

    if (r.plie) return;

    if (r.statut === "en_attente") return; // rien de plus à montrer que le résumé
    if (r.statut === "erreur") {
      const p = section.createEl("p", { text: "Erreur : " + r.erreur });
      p.style.cssText = "color:var(--text-error); margin-left:1.5em;";
      return;
    }

    const detail = section.createDiv();
    detail.style.marginLeft = "1.5em";

    const table = detail.createEl("table");
    table.style.cssText = "width:100%; border-collapse:collapse;";
    const thead = table.createEl("thead");
    const trHead = thead.createEl("tr");
    for (const label of ["Question", "Réponse élève", "Note", "Justification"]) {
      const th = trHead.createEl("th", { text: label });
      th.style.cssText = "text-align:left; padding:.3em .5em; border-bottom:1px solid var(--background-modifier-border);";
    }
    const tbody = table.createEl("tbody");

    const noteFinaleEl = detail.createEl("p");
    noteFinaleEl.style.cssText = "font-weight:600; margin-top:.5em;";
    const majNoteFinale = () => {
      noteFinaleEl.setText("Note finale : " + this.noteFinale(r).toFixed(2) + " / " + r.bareme);
      resume.setText(this.resumeTexte(r)); // garde le résumé de l'en-tête synchronisé pendant l'édition
    };

    for (const q of r.questions) {
      const tr = tbody.createEl("tr");
      for (const texte of [q.Q, q.R]) {
        const td = tr.createEl("td", { text: texte });
        td.style.cssText = "padding:.3em .5em; vertical-align:top;";
      }

      const tdNote = tr.createEl("td");
      tdNote.style.cssText = "padding:.3em .5em; vertical-align:top;";
      const input = tdNote.createEl("input", { type: "number" });
      input.min = "0";
      input.max = "1";
      input.step = "0.5";
      input.value = String(q.note);
      input.style.width = "4em";
      input.disabled = r.valide;
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        q.note = Number.isFinite(v) ? v : 0;
        majNoteFinale();
      });

      const tdJust = tr.createEl("td", { text: q.justification });
      tdJust.style.cssText = "padding:.3em .5em; vertical-align:top; opacity:.85;";
    }

    majNoteFinale();
  }

  // Mode "par question" : une section repliable par question (même ordre que
  // dans les copies, déduit de la première copie corrigée — toutes les copies
  // partagent le même questionnaire), listant élève/réponse/note/justification
  // pour cette question sur toutes les copies déjà corrigées.
  renderParQuestion(container) {
    const corriges = this.resultats.filter((r) => r.statut === "ok");
    const nbErreurs = this.resultats.filter((r) => r.statut === "erreur").length;

    if (nbErreurs > 0) {
      const p = container.createEl("p", {
        text: `${nbErreurs} copie(s) en erreur non affichée(s) dans cette vue (voir le mode « par élève »).`,
      });
      p.style.cssText = "opacity:.7; margin-bottom:1em;";
    }

    if (corriges.length === 0) {
      container.createEl("p", { text: "Aucune copie corrigée pour l'instant." }).style.opacity = "0.7";
      return;
    }

    const nbQuestions = corriges[0].questions.length;
    for (let i = 0; i < nbQuestions; i++) this.renderQuestion(container, i, corriges);
  }

  renderQuestion(container, index, corriges) {
    const section = container.createDiv({ cls: "correction-question" });
    section.style.cssText = "margin-bottom:1em; padding-bottom:1em; border-bottom:1px solid var(--background-modifier-border);";

    const plie = this.questionPliee[index] !== false;

    const header = section.createDiv({ cls: "correction-question-header" });
    header.style.cssText = "display:flex; align-items:flex-start; gap:.5em; cursor:pointer;";
    header.addEventListener("click", () => {
      this.questionPliee[index] = !plie;
      this.render();
    });

    const chevron = header.createSpan({ text: plie ? "▶" : "▼" });
    chevron.style.cssText = "width:1em; flex:0 0 auto; opacity:.7;";

    const titre = header.createSpan({ text: `Question ${index + 1} — ${corriges[0].questions[index].Q}` });
    titre.style.fontWeight = "600";

    if (plie) return;

    const detail = section.createDiv();
    detail.style.marginLeft = "1.5em";

    const table = detail.createEl("table");
    table.style.cssText = "width:100%; border-collapse:collapse;";
    const thead = table.createEl("thead");
    const trHead = thead.createEl("tr");
    for (const label of ["Élève", "Réponse", "Note", "Justification"]) {
      const th = trHead.createEl("th", { text: label });
      th.style.cssText = "text-align:left; padding:.3em .5em; border-bottom:1px solid var(--background-modifier-border);";
    }
    const tbody = table.createEl("tbody");

    for (const r of corriges) {
      const q = r.questions[index];
      if (!q) continue;

      const tr = tbody.createEl("tr");
      const tdEleve = tr.createEl("td", { text: r.eleve });
      tdEleve.style.cssText = "padding:.3em .5em; vertical-align:top; font-weight:600;";

      const tdReponse = tr.createEl("td", { text: q.R });
      tdReponse.style.cssText = "padding:.3em .5em; vertical-align:top;";

      const tdNote = tr.createEl("td");
      tdNote.style.cssText = "padding:.3em .5em; vertical-align:top;";
      const input = tdNote.createEl("input", { type: "number" });
      input.min = "0";
      input.max = "1";
      input.step = "0.5";
      input.value = String(q.note);
      input.style.width = "4em";
      input.disabled = r.valide;
      input.addEventListener("input", () => {
        const v = parseFloat(input.value);
        q.note = Number.isFinite(v) ? v : 0;
      });

      const tdJust = tr.createEl("td", { text: q.justification });
      tdJust.style.cssText = "padding:.3em .5em; vertical-align:top; opacity:.85;";
    }
  }

  async validerTout() {
    let compte = 0;
    for (const r of this.resultats) {
      if (r.statut !== "ok" || r.valide) continue;
      const noteFinale = Math.round(this.noteFinale(r) * 100) / 100;
      try {
        await this.app.fileManager.processFrontMatter(r.ficheFile, (fm) => {
          fm.note = noteFinale;
          fm.corrige = true;
          fm.corrections = r.questions.map((q) => ({
            question: q.Q,
            reponse_eleve: q.R,
            note: q.note,
            justification: q.justification,
          }));
        });
        r.valide = true;
        compte++;
      } catch (e) {
        new Notice(`Échec de l'enregistrement pour ${r.eleve} : ${e.message}`);
      }
    }
    new Notice(`${compte} note(s) enregistrée(s).`);
    this.render();
    await this.genererRapport();
  }

  // Dossier de dépôt du cours (parent des sous-dossiers <eleve>/), déduit de la
  // première fiche disponible plutôt que reparsé depuis config/cours/*.json :
  // toutes les fiches d'une même correction partagent le même dossier parent
  // (<DEPOT_ROOT>/<eleve>/<fiche>.md, voir create_depot_note dans obsidian.py).
  dossierDepot() {
    const premiere = this.resultats.find((r) => r.ficheFile);
    return premiere ? premiere.ficheFile.parent.parent : null;
  }

  // Échappe une valeur pour une cellule de tableau markdown : caractères HTML
  // (le texte vient du PDF/LLM, pas de garantie qu'il ne ressemble jamais à une
  // balise), pipe littéral, et retours à la ligne (interdits dans une cellule,
  // transformés en <br> — volontairement laissé tel quel, ajouté après coup).
  echapperCellule(texte) {
    return this.echapperHtml(texte)
      .replace(/\|/g, "\\|")
      .replace(/\r?\n/g, "<br>");
  }

  // Échappe une valeur destinée à un contexte HTML brut (ex. <summary>), pour
  // qu'un nom d'élève ou un message d'erreur contenant "<"/">"/"&" ne casse pas
  // la structure de la note ou ne soit pas interprété comme une balise.
  echapperHtml(texte) {
    return String(texte ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Contenu markdown du rapport : mêmes informations et même présentation que
  // l'onglet (arbre replié par défaut, nom + résumé/note finale toujours
  // visibles, détail question/réponse/note/justification au dépli), via un
  // callout Obsidian repliable (`> [!type]- titre`) plutôt qu'un <details> HTML
  // brut : à l'usage, Obsidian ne réinterprète pas le markdown (tableaux
  // compris) à l'intérieur d'un <details>, alors qu'un callout est prévu pour
  // contenir du markdown riche. Pas de champ modifiable ici, contrairement au
  // tableau interactif de la vue.
  construireRapport() {
    const maintenant = new Date();
    const nbOk = this.resultats.filter((r) => r.statut === "ok").length;
    const nbErreurs = this.resultats.filter((r) => r.statut === "erreur").length;

    const lignes = ["---", "tags:", "  - rapport-correction"];
    if (this.type) lignes.push(`type: ${JSON.stringify(this.type)}`);
    if (this.cours) lignes.push(`cours: ${JSON.stringify(this.cours)}`);
    lignes.push(`date: ${JSON.stringify(maintenant.toISOString())}`);
    lignes.push(`nb_eleves: ${this.resultats.length}`);
    lignes.push(`nb_corriges: ${nbOk}`);
    lignes.push(`nb_erreurs: ${nbErreurs}`);
    lignes.push("---", "");

    const titre = ["# Rapport de correction", this.type, this.cours ? `(${this.cours})` : null]
      .filter(Boolean)
      .join(" ");
    lignes.push(titre, "");

    for (const r of this.resultats) {
      const typeCallout = r.statut === "erreur" ? "failure" : r.statut === "ok" ? "success" : "note";
      const titreCallout = `${this.echapperHtml(r.eleve)} — ${this.echapperHtml(this.resumeTexte(r))}`;
      lignes.push(`> [!${typeCallout}]- ${titreCallout}`);

      const corps = [];
      if (r.statut === "erreur") {
        corps.push(`Erreur : ${r.erreur}`);
      } else if (r.statut !== "ok") {
        corps.push("Non traité.");
      } else {
        corps.push("| Question | Réponse élève | Note | Justification |");
        corps.push("| --- | --- | --- | --- |");
        for (const q of r.questions) {
          corps.push(
            `| ${this.echapperCellule(q.Q)} | ${this.echapperCellule(q.R)} | ${q.note} | ${this.echapperCellule(q.justification)} |`
          );
        }
        corps.push("", `**Note finale : ${this.noteFinale(r).toFixed(2)} / ${r.bareme}**`);
      }
      // Chaque ligne du corps reste dans le callout via le préfixe "> " ; une
      // ligne vide doit quand même porter le ">" seul, sinon elle sort du bloc.
      for (const ligneCorps of corps) lignes.push(ligneCorps === "" ? ">" : `> ${ligneCorps}`);

      lignes.push("");
    }

    return lignes.join("\n");
  }

  // Écrit le rapport dans le dossier de dépôt du cours et l'ouvre dans un
  // nouvel onglet. N'échoue jamais bruyamment : un souci d'écriture affiche
  // juste une Notice (les notes elles-mêmes sont déjà enregistrées à ce stade).
  async genererRapport() {
    const dossier = this.dossierDepot();
    if (!dossier) return;

    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const horodatage = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    const typeSafe = (this.type || "correction").replace(/[\\/:*?"<>|]/g, "_");
    const nomFichier = `Rapport de correction - ${typeSafe} - ${horodatage}.md`;
    const cheminFichier = dossier.path ? `${dossier.path}/${nomFichier}` : nomFichier;

    try {
      const fichier = await this.app.vault.create(cheminFichier, this.construireRapport());
      new Notice("Rapport de correction créé : " + fichier.path);
      await this.app.workspace.getLeaf("tab").openFile(fichier);
    } catch (e) {
      new Notice("Impossible de créer le rapport de correction : " + e.message);
    }
  }
}

module.exports = class LancerServeurPlugin extends Plugin {
  async onload() {
    // Session courante du serveur : null tant qu'aucun serveur n'a été lancé.
    // { cours, documentSeance, supportCours, qcm, fullscreen } — les trois
    // fichiers sont des chemins absolus ou null (qcm = note Markdown, les autres
    // des PDF) ; fullscreen (booléen) n'a d'effet qu'avec qcm.
    // Réinitialisée par stop_server().
    this.session = null;
    this.statusBarEl = null;

    // État du serveur expose_dir.py (indépendant du serveur de dépôt) : chemin
    // absolu du dossier exposé, ou null. Réinitialisé par stopExposeDir().
    this.exposeDir = null;
    this.exposeStatusBarEl = null;

    // Session de correction en cours (indépendante de this.session, qui régit
    // le serveur de dépôt) : { cours, originalPdf, profPdf }. originalPdf/
    // profPdf valent null tant que le rôle correspondant n'a pas été choisi.
    // Réinitialisée une fois la correction lancée (voir demarrerCorrection).
    this.correction = null;

    this.registerView(VIEW_TYPE_CORRECTION, (leaf) => new CorrectionView(leaf));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFolder) {
          menu.addItem((item) => {
            item
              .setTitle("Exposer ce dossier en HTTP (projection)")
              .setIcon("screen-share")
              .onClick(() => this.lancerExposeDir(file));
          });
          return;
        }

        if (!(file instanceof TFile)) return;

        const ext = file.extension.toLowerCase();

        // Document de séance : PDF ou document Word (.doc/.docx).
        if (ext === "pdf" || ext === "doc" || ext === "docx") {
          menu.addItem((item) => {
            item
              .setTitle("Serveur de dépôt · ce document comme document de séance")
              .setIcon("upload")
              .onClick(() => this.definirRole(file, "documentSeance"));
          });
        }
        // Support de cours : PDF exclusif.
        if (ext === "pdf") {
          menu.addItem((item) => {
            item
              .setTitle("Serveur de dépôt · ce PDF comme support de cours")
              .setIcon("book-open")
              .onClick(() => this.definirRole(file, "supportCours"));
          });
        }
        // Correction automatique de devoirs (corrector.py) : PDF exclusif.
        if (ext === "pdf") {
          menu.addItem((item) => {
            item
              .setTitle("Corriger un devoir · ce PDF comme document de séance")
              .setIcon("file-check")
              .onClick(() => this.definirRoleCorrection(file, "originalPdf"));
          });
          menu.addItem((item) => {
            item
              .setTitle("Corriger un devoir · ce PDF comme corrigé professeur")
              .setIcon("file-check-2")
              .onClick(() => this.definirRoleCorrection(file, "profPdf"));
          });
        }
        if (ext === "md") {
          menu.addItem((item) => {
            item
              .setTitle("Serveur de dépôt · ce QCM (mode QCM)")
              .setIcon("list-checks")
              .onClick(() => this.definirRole(file, "qcm"));
          });

          // Fiche de dépôt (create_depot_note dans obsidian.py) d'un cours
          // "projet", de type TYPE_DOCUMENT_EVALUATION_IA : permet de (re)lancer
          // manuellement l'évaluation IA des spécifications (evaluation_projet.py),
          // en particulier pour les dépôts faits avant la mise en place du
          // déclenchement automatique.
          const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
          if (
            fm &&
            fm.eleve &&
            fm.fichier &&
            fm.type === TYPE_DOCUMENT_EVALUATION_IA &&
            estCoursProjet(fm.cours)
          ) {
            menu.addItem((item) => {
              item
                .setTitle("Évaluer les spécifications (IA)")
                .setIcon("sparkles")
                .onClick(() => this.lancerEvaluationProjet(file));
            });
          }
        }
      })
    );

    // Ruban : lancer un dépôt sans documents, ou configurer une des configs
    // compatibles avec ce vault (voir ouvrirActionsServeur).
    this.addRibbonIcon("server", "Serveur de dépôt : lancer ou configurer", () => {
      this.ouvrirActionsServeur();
    });
  }

  // Ruban : menu des actions du serveur de dépôt.
  ouvrirActionsServeur() {
    let configs;
    try {
      configs = chargerConfigsCours();
    } catch (e) {
      new Notice("Impossible de lire " + CONFIG_COURS_DIR + " : " + e.message);
      return;
    }

    const vault = this.app.vault.adapter.getBasePath();
    const compatibles = configs.filter((c) => c.classeDir && dossiersLies(c.classeDir, vault));

    const actions = [
      { id: "lancer", label: "▶  Lancer le serveur de dépôt (sans documents associés)" },
      ...compatibles.map((c) => ({
        id: "configurer",
        cours: c.identifiant,
        label: `⚙  Configurer « ${c.identifiant} »`,
      })),
    ];

    new ActionsServeurModal(this.app, actions, (action) => {
      // Ouverture différée d'un tick : le modal suivant serait sinon déclenché
      // pendant la fermeture de ce SuggestModal (cf. appliquerRole / ChoixModeQcmModal).
      setTimeout(() => {
        if (action.id === "lancer") this.lancerDepotSansDocuments(compatibles);
        else this.ouvrirEditeurConfig(action.cours);
      }, 0);
    }).open();
  }

  // Lance serveur.py en mode dépôt simple : --cours seul, sans --document-seance,
  // --support-cours ni --qcm. Choix du cours parmi les configs compatibles avec ce
  // vault (direct s'il n'y en a qu'une).
  lancerDepotSansDocuments(compatibles) {
    if (compatibles.length === 0) {
      new MessageModal(this.app, "Aucune configuration compatible", [
        "Aucune configuration de " + CONFIG_COURS_DIR,
        "n'a de CLASSE_DIR correspondant au dossier de ce vault :",
        this.app.vault.adapter.getBasePath(),
      ]).open();
      return;
    }

    const demarrer = (identifiant) => {
      this.session = {
        cours: identifiant,
        documentSeance: null,
        supportCours: null,
        qcm: null,
        fullscreen: false,
      };
      this.lancerServeur();
    };

    if (compatibles.length === 1) {
      demarrer(compatibles[0].identifiant);
    } else {
      new ChoixCoursModal(
        this.app,
        compatibles.map((c) => c.identifiant),
        demarrer
      ).open();
    }
  }

  // Ouvre l'éditeur du fichier config/cours/<identifiant>.json.
  ouvrirEditeurConfig(identifiant) {
    new EditeurConfigModal(
      this.app,
      identifiant,
      path.join(CONFIG_COURS_DIR, identifiant + ".json")
    ).open();
  }

  // Affecte le fichier `file` au rôle demandé ("documentSeance", "supportCours"
  // ou "qcm"), puis (re)lance le serveur avec tout ce qui est renseigné dans la
  // session. Le --cours n'est demandé qu'une fois, au premier rôle défini ;
  // ensuite il est figé et chaque fichier doit appartenir à son CLASSE_DIR.
  definirRole(file, role) {
    const basePath = this.app.vault.adapter.getBasePath();
    const cheminAbsolu = path.resolve(basePath, file.path);

    let configs;
    try {
      configs = chargerConfigsCours();
    } catch (e) {
      new Notice("Impossible de lire " + CONFIG_COURS_DIR + " : " + e.message);
      return;
    }
    if (configs.length === 0) {
      new Notice("Aucun fichier de config trouvé dans " + CONFIG_COURS_DIR);
      return;
    }

    // Session déjà ouverte : le cours est figé. On vérifie que le fichier est
    // bien dans son CLASSE_DIR, on remplace le rôle et on relance.
    if (this.session) {
      const config = configs.find((c) => c.identifiant === this.session.cours);
      if (!config || !config.classeDir || !cheminEstDans(config.classeDir, cheminAbsolu)) {
        new MessageModal(this.app, "Document hors du cours actif", [
          `Cours actif : « ${this.session.cours} ». Pour changer de cours, arrêtez d'abord le serveur.`,
          "Document sélectionné :",
          cheminAbsolu,
          config && config.classeDir
            ? "Il n'est pas situé dans son CLASSE_DIR (" + config.classeDir + ")."
            : "Or ce cours n'a pas de CLASSE_DIR exploitable.",
        ]).open();
        return;
      }
      this.appliquerRole(this.session.cours, role, cheminAbsolu);
      return;
    }

    // Première définition : on choisit le cours parmi ceux dont le CLASSE_DIR
    // contient ce fichier (même règle pour les trois rôles).
    const identifiants = configs
      .filter((c) => c.classeDir && cheminEstDans(c.classeDir, cheminAbsolu))
      .map((c) => c.identifiant);

    if (identifiants.length === 0) {
      new MessageModal(this.app, "Aucune configuration compatible", [
        "Le document sélectionné :",
        cheminAbsolu,
        "n'est situé dans le CLASSE_DIR d'aucune configuration de " + CONFIG_COURS_DIR + ".",
      ]).open();
      return;
    }

    new ChoixCoursModal(this.app, identifiants, (identifiant) => {
      this.appliquerRole(identifiant, role, cheminAbsolu);
    }).open();
  }

  // Construit la session (cours + fichier dans son champ `role`) et (re)lance le
  // serveur. Pour le rôle "qcm", demande d'abord le mode d'affichage. `this.session`
  // n'est affectée qu'au tout dernier moment, juste avant lancerServeur : si un
  // modal est annulé, l'état précédent reste intact (pas de session fantôme, ni
  // de course entre le handler de choix et celui de fermeture).
  appliquerRole(cours, role, cheminAbsolu) {
    const base =
      this.session && this.session.cours === cours
        ? this.session
        : { cours, documentSeance: null, supportCours: null, qcm: null, fullscreen: false };

    if (role === "qcm") {
      // Ouverture différée d'un tick : ce modal est souvent déclenché depuis le
      // onChoose de ChoixCoursModal, dont la fermeture n'est pas encore terminée.
      setTimeout(() => {
        new ChoixModeQcmModal(this.app, (fullscreen) => {
          this.session = { ...base, qcm: cheminAbsolu, fullscreen };
          this.lancerServeur();
        }).open();
      }, 0);
      return;
    }

    // Rôle "dépôt" (documentSeance / supportCours) : on efface un éventuel QCM,
    // sinon serveur.py redémarrerait en mode QCM — sa seule présence suffit
    // (voir is_qcm_mode dans depot.py). fullscreen redevient donc sans objet.
    this.session = { ...base, qcm: null, fullscreen: false, [role]: cheminAbsolu };
    this.lancerServeur();
  }

  // Affecte le fichier `file` au rôle demandé pour la correction automatique
  // ("originalPdf" = document de séance, "profPdf" = corrigé professeur), avec
  // la même règle de résolution du cours par CLASSE_DIR que definirRole, mais
  // dans un état totalement indépendant de this.session (pas de lancement de
  // serveur ici). Dès que les deux rôles sont renseignés, lance la correction.
  definirRoleCorrection(file, role) {
    const basePath = this.app.vault.adapter.getBasePath();
    const cheminAbsolu = path.resolve(basePath, file.path);

    let configs;
    try {
      configs = chargerConfigsCours();
    } catch (e) {
      new Notice("Impossible de lire " + CONFIG_COURS_DIR + " : " + e.message);
      return;
    }
    if (configs.length === 0) {
      new Notice("Aucun fichier de config trouvé dans " + CONFIG_COURS_DIR);
      return;
    }

    if (this.correction) {
      const config = configs.find((c) => c.identifiant === this.correction.cours);
      if (!config || !config.classeDir || !cheminEstDans(config.classeDir, cheminAbsolu)) {
        new MessageModal(this.app, "Document hors du cours actif", [
          `Cours actif pour cette correction : « ${this.correction.cours} ». Pour changer de cours, relance la correction depuis un autre PDF.`,
          "Document sélectionné :",
          cheminAbsolu,
          config && config.classeDir
            ? "Il n'est pas situé dans son CLASSE_DIR (" + config.classeDir + ")."
            : "Or ce cours n'a pas de CLASSE_DIR exploitable.",
        ]).open();
        return;
      }
      this.appliquerRoleCorrection(this.correction.cours, role, cheminAbsolu);
      return;
    }

    const identifiants = configs
      .filter((c) => c.classeDir && cheminEstDans(c.classeDir, cheminAbsolu))
      .map((c) => c.identifiant);

    if (identifiants.length === 0) {
      new MessageModal(this.app, "Aucune configuration compatible", [
        "Le document sélectionné :",
        cheminAbsolu,
        "n'est situé dans le CLASSE_DIR d'aucune configuration de " + CONFIG_COURS_DIR + ".",
      ]).open();
      return;
    }

    if (identifiants.length === 1) {
      this.appliquerRoleCorrection(identifiants[0], role, cheminAbsolu);
    } else {
      new ChoixCoursModal(this.app, identifiants, (identifiant) => {
        this.appliquerRoleCorrection(identifiant, role, cheminAbsolu);
      }).open();
    }
  }

  // Construit/complète this.correction et, dès que les deux PDF sont
  // renseignés, lance demarrerCorrection().
  appliquerRoleCorrection(cours, role, cheminAbsolu) {
    const base =
      this.correction && this.correction.cours === cours
        ? this.correction
        : { cours, originalPdf: null, profPdf: null };
    this.correction = { ...base, [role]: cheminAbsolu };

    if (this.correction.originalPdf && this.correction.profPdf) {
      this.demarrerCorrection();
    } else {
      new Notice(
        `« ${role === "originalPdf" ? "document de séance" : "corrigé professeur"} » défini — ` +
          "choisis maintenant l'autre PDF pour lancer la correction."
      );
    }
  }

  // Recherche, parmi les fiches de dépôt du vault, celles à corriger (a_noter
  // === true, même cours que this.correction), fait choisir un "type" à
  // l'enseignant, puis lance corrector_cli.py sur les copies correspondantes
  // et ouvre la vue de résultats. Réinitialise this.correction à la fin (ou en
  // cas d'abandon), pour permettre d'enchaîner une nouvelle correction.
  demarrerCorrection() {
    const { cours, originalPdf, profPdf } = this.correction;

    const fichesANoter = this.app.vault.getMarkdownFiles().filter((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter;
      return fm && fm.a_noter === true && fm.cours === cours;
    });

    if (fichesANoter.length === 0) {
      new MessageModal(this.app, "Aucune fiche à corriger", [
        `Aucune fiche de dépôt avec "a_noter: true" trouvée pour le cours « ${cours} ».`,
      ]).open();
      this.correction = null;
      return;
    }

    const types = [...new Set(fichesANoter.map((f) => this.app.metadataCache.getFileCache(f).frontmatter.type))];

    const poursuivre = (type) => this.lancerCorrectionPourType(cours, type, fichesANoter, originalPdf, profPdf);

    if (types.length === 1) {
      poursuivre(types[0]);
    } else {
      new ChoixTypeModal(this.app, types, poursuivre).open();
    }
  }

  // Filtre les fiches sur le type choisi, résout le PDF associé à chacune,
  // puis lance corrector_cli.py et ouvre la vue de résultats.
  lancerCorrectionPourType(cours, type, fichesANoter, originalPdf, profPdf) {
    const basePath = this.app.vault.adapter.getBasePath();
    const entrees = [];
    const introuvables = [];

    for (const fiche of fichesANoter) {
      const fm = this.app.metadataCache.getFileCache(fiche).frontmatter;
      if (fm.type !== type) continue;
      // Fiche et PDF partagent le même dossier (voir create_depot_note dans
      // obsidian.py) ; fiche.parent.path vaut "" pour la racine du vault.
      const pdfPath = fiche.parent.path ? fiche.parent.path + "/" + fm.fichier : fm.fichier;
      const pdfFile = this.app.vault.getAbstractFileByPath(pdfPath);
      if (!(pdfFile instanceof TFile)) {
        introuvables.push(fm.fichier);
        continue;
      }
      entrees.push({
        id: fiche.path,
        ficheFile: fiche,
        eleve: fm.eleve || fiche.basename,
        bareme: typeof fm.bareme === "number" ? fm.bareme : 20,
        pdfAbsolu: path.resolve(basePath, pdfFile.path),
      });
    }

    this.correction = null; // la correction démarre : libère le menu contextuel pour la suivante

    if (introuvables.length > 0) {
      new Notice(`PDF introuvable pour ${introuvables.length} fiche(s), ignorée(s) : ${introuvables.join(", ")}`);
    }
    if (entrees.length === 0) {
      new MessageModal(this.app, "Aucune copie à corriger", [
        `Aucune copie exploitable pour le type « ${type} » (cours « ${cours} »).`,
      ]).open();
      return;
    }

    const requete = {
      original: originalPdf,
      prof: profPdf,
      eleves: entrees.map((e) => ({ id: e.id, pdf: e.pdfAbsolu })),
    };
    const cheminRequete = path.join(os.tmpdir(), `correction-${Date.now()}.json`);
    try {
      fs.writeFileSync(cheminRequete, JSON.stringify(requete), "utf8");
    } catch (e) {
      new Notice("Impossible d'écrire la requête de correction : " + e.message);
      return;
    }

    (async () => {
      const leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE_CORRECTION, active: true });
      this.app.workspace.revealLeaf(leaf);
      const view = leaf.view;
      view.initialiser(entrees, { cours, type });

      lancerCorrectionJson({
        pythonBin: PYTHON_BIN,
        scriptArgs: [CORRECTOR_CLI_PY, cheminRequete],
        onLigne: (ligne) => view.appliquerResultat(ligne),
        onFin: (code, stderr) => {
          view.terminer();
          fs.unlink(cheminRequete, () => {});
          if (code) {
            new LogModal(
              this.app,
              `La correction a échoué (code ${code})`,
              stderr,
              "(sortie du script corrector_cli.py, aucun fichier de log)"
            ).open();
          }
        },
      });
    })();
  }

  // (Re)lance serveur.py avec la session courante : --cours toujours, plus
  // --document-seance, --support-cours et/ou --qcm selon ce qui est renseigné.
  // La présence de --qcm bascule le serveur en mode QCM (le dépôt de fichiers
  // est remplacé par le formulaire QCM, voir is_qcm_mode dans depot.py) ;
  // --fullscreen n'est ajouté qu'avec --qcm (sans effet sinon). Le détail du
  // lancement détaché (pkill préalable, redirection vers LOG_PATH, modal en cas
  // d'échec au démarrage) est dans lancerPythonDetache.
  lancerServeur() {
    const { cours, documentSeance, supportCours, qcm, fullscreen } = this.session;

    const args = [SERVEUR_PY, "--cours", cours];
    if (documentSeance) args.push("--document-seance", documentSeance);
    if (supportCours) args.push("--support-cours", supportCours);
    if (qcm) args.push("--qcm", qcm);
    if (qcm && fullscreen) args.push("--fullscreen");

    const resume = [
      `cours "${cours}"`,
      documentSeance ? "séance : " + path.basename(documentSeance) : null,
      supportCours ? "support : " + path.basename(supportCours) : null,
      qcm ? "QCM : " + path.basename(qcm) + (fullscreen ? " (plein écran)" : "") : null,
    ]
      .filter(Boolean)
      .join(" — ");

    lancerPythonDetache({
      app: this.app,
      scriptArgs: args,
      matchKill: SERVEUR_PY,
      logPath: LOG_PATH,
      titreErreur: "Le serveur a échoué",
      onStarted: () => {
        new Notice("Serveur (re)lancé — " + resume);
        this.majBarreStatut();
      },
      onCrash: () => {
        if (this.statusBarEl) this.statusBarEl.setText("⚠ Serveur arrêté — voir le log ✕");
      },
    });
  }

  // Reconstruit l'indicateur de la barre de statut à partir de la session.
  // Un clic dessus arrête le serveur et réinitialise la session.
  majBarreStatut() {
    if (this.statusBarEl) this.statusBarEl.remove();

    // Libellé visible volontairement court et de largeur stable : uniquement le
    // mode (+ la croix d'arrêt). Les noms de fichiers, potentiellement longs,
    // élargiraient sinon le bouton de la barre de statut — ils passent donc dans
    // l'infobulle (aria-label, affichée au survol par Obsidian).
    const mode = this.session.qcm
      ? (this.session.fullscreen ? "QCM plein écran" : "QCM")
      : "Dépôt";

    const details = [`cours « ${this.session.cours} »`];
    if (this.session.documentSeance) details.push("séance : " + path.basename(this.session.documentSeance));
    if (this.session.supportCours) details.push("support : " + path.basename(this.session.supportCours));
    if (this.session.qcm) details.push("QCM : " + path.basename(this.session.qcm));

    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.setText(mode + " ✕");
    this.statusBarEl.addClass("mod-clickable");
    this.statusBarEl.style.cursor = "pointer";
    this.statusBarEl.setAttribute(
      "aria-label",
      details.join(" · ") + " — cliquer pour arrêter le serveur de dépôt"
    );
    this.statusBarEl.addEventListener("click", () => this.stop_server());
  }

  // Arrête le serveur et remet la session à zéro.
  stop_server() {
    spawn("pkill", ["-f", SERVEUR_PY]);

    const docs = this.session
      ? [this.session.documentSeance, this.session.supportCours, this.session.qcm]
          .filter(Boolean)
          .map((p) => path.basename(p))
          .join(", ")
      : "";
    new Notice("Serveur stoppé !" + (docs ? " (" + docs + ")" : ""));

    this.session = null;
    if (this.statusBarEl) {
      this.statusBarEl.remove();
      this.statusBarEl = null;
    }
  }

  // (Re)lance expose_dir.py sur le dossier choisi (menu contextuel des dossiers).
  // Indépendant du serveur de dépôt : autre script, autre port, autre barre de
  // statut. Un seul dossier exposé à la fois — relancer sur un autre remplace.
  lancerExposeDir(folder) {
    const basePath = this.app.vault.adapter.getBasePath();
    const cheminAbsolu = folder.path === "/" ? basePath : path.resolve(basePath, folder.path);
    this.exposeDir = cheminAbsolu;

    const url = `http://${ipLocale()}:${EXPOSE_DIR_PORT}/`;

    lancerPythonDetache({
      app: this.app,
      scriptArgs: [EXPOSE_DIR_PY, cheminAbsolu, "-p", String(EXPOSE_DIR_PORT)],
      matchKill: EXPOSE_DIR_PY,
      logPath: EXPOSE_LOG_PATH,
      titreErreur: "expose_dir a échoué",
      onStarted: () => {
        new Notice(`Dossier exposé — ${path.basename(cheminAbsolu)}\n${url}`, 10000);
        this.majBarreStatutExpose();
      },
      onCrash: () => {
        if (this.exposeStatusBarEl) this.exposeStatusBarEl.setText("⚠ Partage arrêté — voir le log ✕");
      },
    });
  }

  // Indicateur de barre de statut du dossier exposé ; clic = arrêt du partage.
  majBarreStatutExpose() {
    if (this.exposeStatusBarEl) this.exposeStatusBarEl.remove();

    // Même principe que majBarreStatut : libellé court et stable, le nom du
    // dossier exposé (potentiellement long) va dans l'infobulle.
    this.exposeStatusBarEl = this.addStatusBarItem();
    this.exposeStatusBarEl.setText(`Exposé (:${EXPOSE_DIR_PORT}) ✕`);
    this.exposeStatusBarEl.addClass("mod-clickable");
    this.exposeStatusBarEl.style.cursor = "pointer";
    this.exposeStatusBarEl.setAttribute(
      "aria-label",
      `dossier : ${path.basename(this.exposeDir)} — cliquer pour arrêter le partage`
    );
    this.exposeStatusBarEl.addEventListener("click", () => this.stopExposeDir());
  }

  // Arrête expose_dir.py et efface son état.
  stopExposeDir() {
    spawn("pkill", ["-f", EXPOSE_DIR_PY]);
    new Notice(
      "Partage du dossier arrêté" +
        (this.exposeDir ? " (" + path.basename(this.exposeDir) + ")" : "")
    );

    this.exposeDir = null;
    if (this.exposeStatusBarEl) {
      this.exposeStatusBarEl.remove();
      this.exposeStatusBarEl = null;
    }
  }

  // Lance evaluation_projet.py sur la fiche de dépôt `file` (create_note_from_analysis
  // côté Python) : dérive le PDF déposé du nom de la fiche, interroge le modèle et
  // ajoute l'analyse en fin de note. Prend plusieurs secondes ; process attaché
  // (comme lancerCorrectionJson) pour pouvoir notifier la fin, mais pas de flux
  // NDJSON ici, juste stdout/stderr accumulés en cas d'échec.
  lancerEvaluationProjet(file) {
    const basePath = this.app.vault.adapter.getBasePath();
    const cheminAbsolu = path.resolve(basePath, file.path);

    new Notice(`Évaluation IA lancée pour « ${file.basename} »…`);

    let stderr = "";
    const proc = spawn(PYTHON_BIN, [EVALUATION_PROJET_PY, cheminAbsolu], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    proc.on("error", (err) => {
      new Notice(`Évaluation IA impossible pour « ${file.basename} » : ${err.message}`);
    });
    proc.on("close", (code) => {
      if (code === 0) {
        new Notice(`Évaluation IA terminée pour « ${file.basename} ».`);
      } else {
        new LogModal(
          this.app,
          `Évaluation IA échouée pour « ${file.basename} » (code ${code})`,
          stderr,
          EVALUATION_PROJET_PY
        ).open();
      }
    });
  }
};
