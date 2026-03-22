/**
 * Popola il database con dati campione sulla regolamentazione finanziaria italiana.
 *
 * Inserisce disposizioni rappresentative di CONSOB Regolamento Emittenti,
 * Regolamento Intermediari, Regolamento Mercati, Banca d'Italia Circolari
 * 285 e 288, e IVASS Regolamento 38/2018.
 *
 * Usage:
 *   npx tsx scripts/seed-sample.ts
 *   npx tsx scripts/seed-sample.ts --force   # cancella e ricrea il database
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { SCHEMA_SQL } from "../src/db.js";

const DB_PATH = process.env["CONSOB_DB_PATH"] ?? "data/consob.db";
const force = process.argv.includes("--force");

// ── Bootstrap database ───────────────────────────────────────────────────────

const dir = dirname(DB_PATH);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
}

if (force && existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`Database eliminato: ${DB_PATH}`);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(SCHEMA_SQL);

console.log(`Database inizializzato: ${DB_PATH}`);

// ── Sourcebooks ──────────────────────────────────────────────────────────────

interface SourcebookRow {
  id: string;
  name: string;
  description: string;
}

const sourcebooks: SourcebookRow[] = [
  {
    id: "CONSOB_EMITTENTI",
    name: "CONSOB Regolamento Emittenti (n. 11971/1999)",
    description:
      "Regolamento di attuazione del decreto legislativo 24 febbraio 1998, n. 58 concernente la disciplina degli emittenti. Disciplina prospetti, OPA, comunicazioni interne, e obblighi di trasparenza.",
  },
  {
    id: "CONSOB_INTERMEDIARI",
    name: "CONSOB Regolamento Intermediari (n. 20307/2018)",
    description:
      "Regolamento recante norme di attuazione del decreto legislativo 24 febbraio 1998, n. 58 in materia di intermediari. Recepisce MiFID II: classificazione clienti, adeguatezza, conflitti di interesse, governo dei prodotti.",
  },
  {
    id: "CONSOB_MERCATI",
    name: "CONSOB Regolamento Mercati (n. 20249/2017)",
    description:
      "Regolamento recante norme di attuazione del decreto legislativo 24 febbraio 1998, n. 58 in materia di mercati. Disciplina l'organizzazione e il funzionamento dei mercati regolamentati e dei sistemi multilaterali di negoziazione.",
  },
  {
    id: "CONSOB_COMUNICAZIONI",
    name: "CONSOB Comunicazioni e Orientamenti",
    description:
      "Comunicazioni CONSOB, orientamenti di vigilanza, e Q&A interpretativi su norme regolamentari.",
  },
  {
    id: "BDI_285",
    name: "Banca d'Italia Circolare 285 (Disposizioni di vigilanza per le banche)",
    description:
      "Disposizioni di vigilanza prudenziale per le banche. Recepisce CRR/CRD IV: fondi propri, requisiti patrimoniali, governo societario, remunerazioni, processo ICAAP/SREP.",
  },
  {
    id: "BDI_288",
    name: "Banca d'Italia Circolare 288 (Disposizioni di vigilanza per gli intermediari finanziari)",
    description:
      "Disposizioni di vigilanza per gli intermediari finanziari iscritti all'albo di cui all'art. 106 TUB. Disciplina governance, requisiti patrimoniali, antiriciclaggio, e segnalazioni di vigilanza.",
  },
  {
    id: "IVASS_38",
    name: "IVASS Regolamento 38/2018 (Governance assicurativa)",
    description:
      "Regolamento IVASS n. 38 del 3 luglio 2018 recante disposizioni in materia di governo societario delle imprese di assicurazione. Recepisce la Direttiva Solvency II in materia di sistema di governance.",
  },
];

const insertSourcebook = db.prepare(
  "INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)",
);

for (const sb of sourcebooks) {
  insertSourcebook.run(sb.id, sb.name, sb.description);
}

console.log(`Inseriti ${sourcebooks.length} sourcebook`);

// ── Sample provisions ────────────────────────────────────────────────────────

interface ProvisionRow {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string;
  chapter: string;
  section: string;
}

const provisions: ProvisionRow[] = [
  // ── CONSOB Regolamento Emittenti (n. 11971/1999) ───────────────────────
  {
    sourcebook_id: "CONSOB_EMITTENTI",
    reference: "Art. 65-bis Reg. Emittenti",
    title: "Requisiti degli amministratori",
    text: "I componenti del consiglio di amministrazione degli emittenti quotati devono possedere requisiti di onorabilita e professionalita. Almeno un quarto dei componenti deve essere in possesso dei requisiti di indipendenza stabiliti per i sindaci dall'art. 148, comma 3 del decreto legislativo 24 febbraio 1998, n. 58.",
    type: "disposizione",
    status: "in_vigore",
    effective_date: "2011-06-01",
    chapter: "VII",
    section: "I",
  },
  {
    sourcebook_id: "CONSOB_EMITTENTI",
    reference: "Art. 114 TUF - Reg. Emittenti",
    title: "Comunicazione al pubblico di informazioni privilegiate",
    text: "Gli emittenti quotati e i soggetti che li controllano comunicano al pubblico, senza indugio, le informazioni privilegiate di cui all'articolo 7 del Regolamento (UE) n. 596/2014. La comunicazione al pubblico e effettuata con modalita tali da consentire un accesso rapido e una valutazione completa e corretta delle informazioni.",
    type: "disposizione",
    status: "in_vigore",
    effective_date: "2016-07-03",
    chapter: "V",
    section: "I",
  },
  {
    sourcebook_id: "CONSOB_EMITTENTI",
    reference: "Art. 102 Reg. Emittenti - OPA",
    title: "Offerta pubblica di acquisto obbligatoria",
    text: "Chiunque venga a detenere una partecipazione superiore alla soglia del trenta per cento promuove un'offerta pubblica di acquisto sulla totalita delle azioni quotate. Il prezzo dell'offerta non puo essere inferiore a quello piu elevato pagato dall'offerente per acquisti di azioni della stessa categoria nei dodici mesi anteriori alla comunicazione dell'offerta.",
    type: "disposizione",
    status: "in_vigore",
    effective_date: "2007-01-01",
    chapter: "II",
    section: "II",
  },
  {
    sourcebook_id: "CONSOB_EMITTENTI",
    reference: "Art. 1 Reg. Emittenti - Definizioni",
    title: "Definizioni",
    text: "Ai fini del presente regolamento si intende per: a) 'informazione privilegiata': un'informazione di carattere preciso, che non e stata resa pubblica, concernente, direttamente o indirettamente, uno o piu emittenti o uno o piu strumenti finanziari, e che, se resa pubblica, potrebbe influire in modo sensibile sui prezzi di tali strumenti finanziari.",
    type: "definizione",
    status: "in_vigore",
    effective_date: "1999-06-14",
    chapter: "I",
    section: "I",
  },
  // ── CONSOB Regolamento Intermediari (n. 20307/2018) ────────────────────
  {
    sourcebook_id: "CONSOB_INTERMEDIARI",
    reference: "Art. 24 Reg. Intermediari - Adeguatezza",
    title: "Valutazione di adeguatezza",
    text: "Le imprese di investimento, prima di consigliare servizi di gestione di portafogli o strumenti finanziari, ottengono dal cliente o potenziale cliente le informazioni necessarie in merito alle conoscenze ed esperienze di tale persona nel settore di investimento rilevante per il tipo di strumento o di servizio specifico, alla sua situazione finanziaria, inclusa la sua capacita di sostenere perdite, e ai suoi obiettivi di investimento, inclusa la sua tolleranza al rischio.",
    type: "regola",
    status: "in_vigore",
    effective_date: "2018-01-03",
    chapter: "IV",
    section: "II",
  },
  {
    sourcebook_id: "CONSOB_INTERMEDIARI",
    reference: "Art. 37 Reg. Intermediari - Conflitti",
    title: "Gestione dei conflitti di interesse",
    text: "Le imprese di investimento devono mantenere ed applicare disposizioni organizzative e amministrative efficaci al fine di adottare tutte le misure ragionevoli destinate ad evitare che i conflitti di interesse ledano gli interessi dei loro clienti. Qualora non sia possibile garantire, con ragionevole certezza, che il rischio di nuocere agli interessi dei clienti sia evitato, l'impresa di investimento informa chiaramente questi ultimi, prima di agire per loro conto.",
    type: "regola",
    status: "in_vigore",
    effective_date: "2018-01-03",
    chapter: "V",
    section: "I",
  },
  {
    sourcebook_id: "CONSOB_INTERMEDIARI",
    reference: "Art. 54 Reg. Intermediari - Governo prodotti",
    title: "Obblighi di governo dei prodotti per i produttori",
    text: "Le imprese di investimento che fabbricano strumenti finanziari destinati alla vendita ai clienti devono mantenere, applicare e rivedere un processo per l'approvazione di ogni strumento finanziario e di ogni modifica significativa degli strumenti finanziari esistenti prima della loro commercializzazione o distribuzione ai clienti. Il processo di approvazione dei prodotti specifica per ogni strumento finanziario un mercato di riferimento identificato di clienti finali.",
    type: "regola",
    status: "in_vigore",
    effective_date: "2018-01-03",
    chapter: "VII",
    section: "I",
  },
  {
    sourcebook_id: "CONSOB_INTERMEDIARI",
    reference: "Art. 70 Reg. Intermediari - Classificazione",
    title: "Classificazione dei clienti",
    text: "Ai fini della prestazione di servizi di investimento, le imprese di investimento classificano i propri clienti come clienti al dettaglio, clienti professionali o controparti qualificate. La classificazione e determinata in base alle caratteristiche, alle conoscenze, alle esperienze e alla situazione finanziaria del cliente.",
    type: "regola",
    status: "in_vigore",
    effective_date: "2018-01-03",
    chapter: "III",
    section: "I",
  },
  // ── CONSOB Regolamento Mercati (n. 20249/2017) ─────────────────────────
  {
    sourcebook_id: "CONSOB_MERCATI",
    reference: "Art. 7 Reg. Mercati - MTF",
    title: "Sistemi multilaterali di negoziazione",
    text: "I gestori di sistemi multilaterali di negoziazione devono stabilire e mantenere regole trasparenti e non discrezionali per un corretto svolgimento delle negoziazioni. I gestori degli MTF devono dotarsi di sistemi e procedure idonei a garantire la resilienza e la continuita dei sistemi di negoziazione.",
    type: "regola",
    status: "in_vigore",
    effective_date: "2018-01-03",
    chapter: "II",
    section: "II",
  },
  {
    sourcebook_id: "CONSOB_MERCATI",
    reference: "Art. 23 Reg. Mercati - Trasparenza pre-trade",
    title: "Obblighi di trasparenza pre-negoziazione",
    text: "Gli operatori di mercato e le imprese di investimento che gestiscono sedi di negoziazione rendono pubblici i prezzi correnti di acquisto e vendita e la profondita degli interessi di negoziazione a tali prezzi pubblicizzati tramite i propri sistemi per gli strumenti finanziari ammessi alla negoziazione.",
    type: "regola",
    status: "in_vigore",
    effective_date: "2018-01-03",
    chapter: "IV",
    section: "I",
  },
  // ── Banca d'Italia Circolare 285 ──────────────────────────────────────
  {
    sourcebook_id: "BDI_285",
    reference: "Circ. 285 Tit. I Cap. I",
    title: "Ambito di applicazione e definizioni",
    text: "Le presenti disposizioni si applicano alle banche autorizzate in Italia e alle succursali di banche extracomunitarie. Ai fini delle presenti disposizioni si intende per 'fondi propri' il capitale regolamentare calcolato ai sensi del Regolamento (UE) n. 575/2013 (CRR), comprendente il capitale primario di classe 1 (CET1), il capitale aggiuntivo di classe 1 (AT1) e il capitale di classe 2 (T2).",
    type: "disposizione",
    status: "in_vigore",
    effective_date: "2013-12-17",
    chapter: "I",
    section: "I",
  },
  {
    sourcebook_id: "BDI_285",
    reference: "Circ. 285 Tit. IV Cap. I - Governo Societario",
    title: "Governo societario delle banche",
    text: "Le banche adottano sistemi di governo societario idonei ad assicurare una gestione sana e prudente, improntata alla creazione di valore per gli azionisti in un'ottica di lungo periodo e rispettosa degli interessi degli altri stakeholders. Il consiglio di amministrazione e responsabile dell'adeguatezza e dell'efficacia del sistema di governo societario, approva e rivede con cadenza almeno annuale gli indirizzi strategici e le politiche di rischio della banca.",
    type: "disposizione",
    status: "in_vigore",
    effective_date: "2014-07-01",
    chapter: "IV",
    section: "I",
  },
  {
    sourcebook_id: "BDI_285",
    reference: "Circ. 285 Tit. IV Cap. II - ICAAP",
    title: "Processo di controllo prudenziale - ICAAP",
    text: "Le banche conducono un processo di valutazione dell'adeguatezza patrimoniale interna (ICAAP - Internal Capital Adequacy Assessment Process). Il processo ICAAP e proporzionato alle caratteristiche, alle dimensioni e alla complessita dell'attivita svolta dalla banca. L'ICAAP viene sottoposto alla valutazione dell'autorita di vigilanza nell'ambito del processo SREP.",
    type: "disposizione",
    status: "in_vigore",
    effective_date: "2014-07-01",
    chapter: "IV",
    section: "II",
  },
  {
    sourcebook_id: "BDI_285",
    reference: "Circ. 285 Tit. IV Cap. V - Remunerazioni",
    title: "Politiche e prassi di remunerazione e incentivazione",
    text: "Le banche definiscono e applicano politiche e prassi di remunerazione e incentivazione coerenti con le strategie aziendali, gli obiettivi a lungo termine, i valori e gli interessi della banca. Le politiche di remunerazione sono soggette ad approvazione dell'assemblea dei soci. Il rapporto tra la componente variabile e la componente fissa della remunerazione individuale non puo superare il 100% (o il 200% con approvazione assembleare).",
    type: "disposizione",
    status: "in_vigore",
    effective_date: "2014-07-01",
    chapter: "IV",
    section: "V",
  },
  // ── Banca d'Italia Circolare 288 ──────────────────────────────────────
  {
    sourcebook_id: "BDI_288",
    reference: "Circ. 288 Tit. I Cap. I - Ambito",
    title: "Ambito di applicazione",
    text: "Le presenti disposizioni si applicano agli intermediari finanziari iscritti nell'albo previsto dall'articolo 106 del decreto legislativo 1 settembre 1993, n. 385 (TUB). Le presenti disposizioni recepiscono la Direttiva 2013/36/UE (CRD IV) e il Regolamento (UE) n. 575/2013 (CRR) per la parte applicabile agli intermediari finanziari.",
    type: "disposizione",
    status: "in_vigore",
    effective_date: "2015-08-01",
    chapter: "I",
    section: "I",
  },
  {
    sourcebook_id: "BDI_288",
    reference: "Circ. 288 Tit. III Cap. I - AML",
    title: "Presidi antiriciclaggio",
    text: "Gli intermediari finanziari adottano adeguate politiche e procedure per prevenire il rischio di riciclaggio e di finanziamento del terrorismo. Il responsabile antiriciclaggio ha accesso alle informazioni necessarie allo svolgimento delle proprie funzioni e riferisce all'organo di supervisione strategica e all'organo di gestione sull'adeguatezza e sull'efficacia delle procedure adottate.",
    type: "disposizione",
    status: "in_vigore",
    effective_date: "2015-08-01",
    chapter: "III",
    section: "I",
  },
  // ── IVASS Regolamento 38/2018 ─────────────────────────────────────────
  {
    sourcebook_id: "IVASS_38",
    reference: "Art. 4 IVASS Reg. 38 - Sistema di governance",
    title: "Sistema di governance delle imprese di assicurazione",
    text: "Le imprese di assicurazione si dotano di un efficace sistema di governance che prevede una struttura organizzativa trasparente e appropriata, con una chiara ripartizione e un'adeguata separazione delle responsabilita, nonche un efficace sistema per garantire la trasmissione delle informazioni. Il sistema di governance comprende la gestione dei rischi, il controllo interno, l'attuariale e la revisione interna.",
    type: "regola",
    status: "in_vigore",
    effective_date: "2018-08-01",
    chapter: "II",
    section: "I",
  },
  {
    sourcebook_id: "IVASS_38",
    reference: "Art. 12 IVASS Reg. 38 - Funzione di gestione dei rischi",
    title: "Funzione di gestione dei rischi (Risk Management)",
    text: "Le imprese istituiscono una funzione di gestione dei rischi efficace, strutturata in modo da facilitare l'attuazione del sistema di gestione dei rischi. La funzione di gestione dei rischi identifica, misura, monitora, gestisce e segnala, su base continuativa, i rischi a livello di impresa individuale e di gruppo ai quali le imprese sono o potrebbero essere esposte.",
    type: "regola",
    status: "in_vigore",
    effective_date: "2018-08-01",
    chapter: "III",
    section: "II",
  },
  {
    sourcebook_id: "IVASS_38",
    reference: "Art. 18 IVASS Reg. 38 - ORSA",
    title: "Valutazione interna del rischio e della solvibilita (ORSA)",
    text: "Le imprese effettuano, nell'ambito della propria gestione dei rischi, la valutazione interna dei rischi e della solvibilita (ORSA - Own Risk and Solvency Assessment). La valutazione ORSA include almeno la valutazione delle esigenze di solvibilita globale tenuto conto del profilo di rischio specifico, dei limiti di tolleranza al rischio approvati e della strategia operativa dell'impresa.",
    type: "regola",
    status: "in_vigore",
    effective_date: "2018-08-01",
    chapter: "III",
    section: "IV",
  },
  {
    sourcebook_id: "IVASS_38",
    reference: "Art. 25 IVASS Reg. 38 - Remunerazioni",
    title: "Politica di remunerazione",
    text: "Le imprese adottano e applicano politiche di remunerazione che promuovono una gestione del rischio sana ed efficace e non incoraggiano l'assunzione di rischi che esulano dai limiti di tolleranza al rischio dell'impresa. Le politiche di remunerazione si applicano ai componenti dell'organo amministrativo, ai dirigenti con responsabilita strategiche e al personale che assume rischi rilevanti.",
    type: "regola",
    status: "in_vigore",
    effective_date: "2018-08-01",
    chapter: "IV",
    section: "I",
  },
];

const insertProvision = db.prepare(`
  INSERT INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertAll = db.transaction(() => {
  for (const p of provisions) {
    insertProvision.run(
      p.sourcebook_id,
      p.reference,
      p.title,
      p.text,
      p.type,
      p.status,
      p.effective_date,
      p.chapter,
      p.section,
    );
  }
});

insertAll();

console.log(`Inserite ${provisions.length} disposizioni campione`);

// ── Sample enforcement actions ───────────────────────────────────────────────

interface EnforcementRow {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number;
  date: string;
  summary: string;
  sourcebook_references: string;
}

const enforcements: EnforcementRow[] = [
  {
    firm_name: "Parmalat SpA",
    reference_number: "CONSOB-DEL-2004-14473",
    action_type: "sanzione",
    amount: 2582000,
    date: "2004-06-30",
    summary:
      "Sanzioni comminate ai componenti del consiglio di amministrazione e del collegio sindacale di Parmalat SpA per la violazione degli obblighi di comunicazione al pubblico di informazioni privilegiate e per la diffusione di informazioni false e fuorvianti relative alla situazione patrimoniale e finanziaria del gruppo. Il crac Parmalat del dicembre 2003 ha rappresentato il piu grande default societario europeo, con un buco finanziario stimato in circa 14 miliardi di euro.",
    sourcebook_references: "Art. 114 TUF, Art. 65-bis Reg. Emittenti",
  },
  {
    firm_name: "Banca Monte dei Paschi di Siena SpA",
    reference_number: "CONSOB-DEL-2013-18683",
    action_type: "sanzione",
    amount: 500000,
    date: "2013-10-23",
    summary:
      "Sanzioni irrogate nei confronti degli esponenti aziendali di Monte dei Paschi di Siena per violazioni degli obblighi informativi in relazione alle operazioni in derivati 'Santorini' e 'Alexandria', utilizzate per occultare perdite rilevanti. CONSOB ha accertato la comunicazione di informazioni false o fuorvianti al mercato attraverso i prospetti informativi e la documentazione contabile, in violazione degli obblighi di trasparenza imposti agli emittenti quotati.",
    sourcebook_references: "Art. 114 TUF, Art. 102 Reg. Emittenti",
  },
  {
    firm_name: "Banca Etruria e Lazio (BPEL)",
    reference_number: "CONSOB-DEL-2016-19660",
    action_type: "sanzione",
    amount: 4500000,
    date: "2016-03-15",
    summary:
      "Sanzioni nei confronti di esponenti e dipendenti di Banca Etruria per violazione degli obblighi di valutazione dell'adeguatezza e dell'appropriatezza nella distribuzione di obbligazioni subordinate a clienti al dettaglio. CONSOB ha accertato che la banca ha distribuito strumenti finanziari complessi e rischiosi a clientela retail non professionale senza effettuare la dovuta verifica dell'adeguatezza del profilo di rischio del cliente, in violazione delle norme MiFID recepite nel Regolamento Intermediari.",
    sourcebook_references: "Art. 24 Reg. Intermediari, Art. 70 Reg. Intermediari",
  },
];

const insertEnforcement = db.prepare(`
  INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const insertEnforcementsAll = db.transaction(() => {
  for (const e of enforcements) {
    insertEnforcement.run(
      e.firm_name,
      e.reference_number,
      e.action_type,
      e.amount,
      e.date,
      e.summary,
      e.sourcebook_references,
    );
  }
});

insertEnforcementsAll();

console.log(`Inseriti ${enforcements.length} provvedimenti di enforcement campione`);

// ── Summary ──────────────────────────────────────────────────────────────────

const provisionCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions").get() as {
    cnt: number;
  }
).cnt;
const sourcebookCount = (
  db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as {
    cnt: number;
  }
).cnt;
const enforcementCount = (
  db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as {
    cnt: number;
  }
).cnt;
const ftsCount = (
  db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as {
    cnt: number;
  }
).cnt;

console.log(`\nRiepilogo database:`);
console.log(`  Sourcebook:              ${sourcebookCount}`);
console.log(`  Disposizioni:            ${provisionCount}`);
console.log(`  Provvedimenti enforcement: ${enforcementCount}`);
console.log(`  Voci FTS:                ${ftsCount}`);
console.log(`\nDone. Database pronto: ${DB_PATH}`);

db.close();
