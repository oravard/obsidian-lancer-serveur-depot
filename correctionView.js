const { ItemView, Notice } = require("obsidian");
const { spawn } = require("child_process");

const VIEW_TYPE_CORRECTION = "correction-devoirs-view";

// Lance `pythonBin scriptArgs` en process attaché (pas détaché, contrairement à
// lancerPythonDetache dans main.js : on veut lire son stdout au fil de l'eau,
// et il se termine de lui-même une fois le lot corrigé). stdout est traité
// comme du NDJSON : chaque ligne complète est parsée en JSON et transmise à
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
  // pour afficher tout de suite un état "en attente" par élève.
  initialiser(entrees) {
    this.resultats = entrees.map((e) => ({
      id: e.id,
      ficheFile: e.ficheFile,
      eleve: e.eleve,
      bareme: e.bareme,
      questions: null,
      statut: "en_attente",
      erreur: null,
      valide: false,
    }));
    this.enCours = true;
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

  // Note finale = barème * (somme des notes par question) / nombre de questions.
  // Recalculée à chaque édition, jamais renvoyée par le script Python.
  noteFinale(r) {
    if (!r.questions || r.questions.length === 0) return 0;
    const somme = r.questions.reduce((s, q) => s + Number(q.note), 0);
    return (r.bareme * somme) / r.questions.length;
  }

  async onOpen() {
    this.render();
  }

  render() {
    const container = this.contentEl;
    container.empty();
    container.addClass("correction-devoirs-view");

    const barre = container.createDiv({ cls: "correction-barre-actions" });
    barre.style.cssText = "display:flex; align-items:center; gap:1em; margin-bottom:1em;";

    const nbOk = this.resultats.filter((r) => r.statut === "ok").length;
    const validerBtn = barre.createEl("button", { cls: "mod-cta", text: "Valider tout" });
    validerBtn.disabled = this.enCours || nbOk === 0;
    validerBtn.addEventListener("click", () => void this.validerTout());

    const statutTexte = this.enCours
      ? "Correction en cours…"
      : `${nbOk} copie(s) corrigée(s) sur ${this.resultats.length}`;
    barre.createSpan({ text: statutTexte });

    for (const r of this.resultats) this.renderEleve(container, r);
  }

  renderEleve(container, r) {
    const section = container.createDiv({ cls: "correction-eleve" });
    section.style.cssText = "margin-bottom:1.5em; padding-bottom:1em; border-bottom:1px solid var(--background-modifier-border);";

    const titre = section.createEl("h4");
    titre.createSpan({ text: r.eleve });
    if (r.valide) {
      const badge = titre.createSpan({ text: " ✓ validé" });
      badge.style.color = "var(--text-success)";
    }

    if (r.statut === "en_attente") {
      section.createEl("p", { text: "En attente…" }).style.opacity = "0.7";
      return;
    }
    if (r.statut === "erreur") {
      const p = section.createEl("p", { text: "Erreur : " + r.erreur });
      p.style.color = "var(--text-error)";
      return;
    }

    const table = section.createEl("table");
    table.style.cssText = "width:100%; border-collapse:collapse;";
    const thead = table.createEl("thead");
    const trHead = thead.createEl("tr");
    for (const label of ["Question", "Réponse élève", "Note", "Justification"]) {
      const th = trHead.createEl("th", { text: label });
      th.style.cssText = "text-align:left; padding:.3em .5em; border-bottom:1px solid var(--background-modifier-border);";
    }
    const tbody = table.createEl("tbody");

    const noteFinaleEl = section.createEl("p");
    noteFinaleEl.style.cssText = "font-weight:600; margin-top:.5em;";
    const majNoteFinale = () => {
      noteFinaleEl.setText(`Note finale : ${this.noteFinale(r).toFixed(2)} / ${r.bareme}`);
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
  }
}

module.exports = { CorrectionView, VIEW_TYPE_CORRECTION, lancerCorrectionJson };
