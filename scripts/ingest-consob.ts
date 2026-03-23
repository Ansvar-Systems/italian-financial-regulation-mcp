/**
 * CONSOB ingestion crawler — scrapes consob.it for Italian financial regulation data
 * and populates the SQLite database.
 *
 * Crawls:
 *   1. Regulation index pages (Emittenti, Intermediari, Mercati, Parti Correlate, etc.)
 *   2. Individual regulation HTML full texts (article-level extraction)
 *   3. Delibere / enforcement decisions
 *   4. Comunicazioni and orientamenti (guidance)
 *   5. Bollettino listings for enforcement actions
 *
 * Usage:
 *   npx tsx scripts/ingest-consob.ts
 *   npx tsx scripts/ingest-consob.ts --resume      # resume from last checkpoint
 *   npx tsx scripts/ingest-consob.ts --dry-run      # parse only, do not write to DB
 *   npx tsx scripts/ingest-consob.ts --force         # delete and recreate the database
 *   npx tsx scripts/ingest-consob.ts --resume --force  # not allowed (exits with error)
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as cheerio from "cheerio";
import { SCHEMA_SQL } from "../src/db.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const DB_PATH = process.env["CONSOB_DB_PATH"] ?? "data/consob.db";
const PROGRESS_FILE = resolve(dirname(DB_PATH), "ingest-progress.json");
const BASE_URL = "https://www.consob.it";

const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 3000;
const REQUEST_TIMEOUT_MS = 30_000;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ─── CLI flags ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flagResume = args.includes("--resume");
const flagDryRun = args.includes("--dry-run");
const flagForce = args.includes("--force");

if (flagResume && flagForce) {
  console.error("Errore: --resume e --force non possono essere usati insieme.");
  process.exit(1);
}

// ─── Types ──────────────────────────────────────────────────────────────────

interface SourcebookDef {
  id: string;
  name: string;
  description: string;
  /** URL(s) to crawl for this sourcebook's provisions */
  urls: CrawlTarget[];
}

interface CrawlTarget {
  url: string;
  type: "regulation_html" | "regulation_pdf_index" | "delibere_list" | "orientamenti_list" | "bollettino_list";
}

interface ParsedProvision {
  sourcebook_id: string;
  reference: string;
  title: string;
  text: string;
  type: string;
  status: string;
  effective_date: string | null;
  chapter: string | null;
  section: string | null;
}

interface ParsedEnforcement {
  firm_name: string;
  reference_number: string;
  action_type: string;
  amount: number | null;
  date: string | null;
  summary: string;
  sourcebook_references: string | null;
}

interface IngestProgress {
  completed_urls: string[];
  provisions_inserted: number;
  enforcements_inserted: number;
  last_updated: string;
}

// ─── Sourcebook definitions ────────────────────────────────────────────────

const SOURCEBOOKS: SourcebookDef[] = [
  {
    id: "CONSOB_EMITTENTI",
    name: "CONSOB Regolamento Emittenti (n. 11971/1999)",
    description:
      "Regolamento di attuazione del decreto legislativo 24 febbraio 1998, n. 58 concernente la disciplina degli emittenti. Disciplina prospetti, OPA, comunicazioni interne, e obblighi di trasparenza.",
    urls: [
      {
        url: `${BASE_URL}/documents/1912911/1950567/reg_consob_1999_11971.html/1c3731c3-b60b-f7c2-b62c-d421a92d49df`,
        type: "regulation_html",
      },
    ],
  },
  {
    id: "CONSOB_INTERMEDIARI",
    name: "CONSOB Regolamento Intermediari (n. 20307/2018)",
    description:
      "Regolamento recante norme di attuazione del decreto legislativo 24 febbraio 1998, n. 58 in materia di intermediari. Recepisce MiFID II: classificazione clienti, adeguatezza, conflitti di interesse, governo dei prodotti.",
    urls: [
      {
        url: `${BASE_URL}/documents/46180/46181/reg_consob_2018_20307.html/d72ae8b4-1ee3-44c8-b2e3-2de158e58509`,
        type: "regulation_html",
      },
    ],
  },
  {
    id: "CONSOB_MERCATI",
    name: "CONSOB Regolamento Mercati (n. 20249/2017)",
    description:
      "Regolamento recante norme di attuazione del decreto legislativo 24 febbraio 1998, n. 58 in materia di mercati. Disciplina l'organizzazione e il funzionamento dei mercati regolamentati e dei sistemi multilaterali di negoziazione.",
    urls: [
      {
        url: `${BASE_URL}/documents/11973/0/Regolamento+mercati+n.+20249+del+29.12.2017/76ba32c8-93c4-45ea-8511-7c9eaaf7c928`,
        type: "regulation_html",
      },
    ],
  },
  {
    id: "CONSOB_PARTI_CORRELATE",
    name: "CONSOB Regolamento Operazioni Parti Correlate (n. 17221/2010)",
    description:
      "Regolamento recante disposizioni in materia di operazioni con parti correlate. Disciplina i presidi procedurali e informativi per le operazioni con parti correlate delle società quotate.",
    urls: [
      {
        url: `${BASE_URL}/documents/1912911/1950567/reg_consob_2010_17221.pdf`,
        type: "regulation_pdf_index",
      },
    ],
  },
  {
    id: "CONSOB_COMUNICAZIONI",
    name: "CONSOB Comunicazioni e Orientamenti",
    description:
      "Comunicazioni CONSOB, orientamenti di vigilanza, e Q&A interpretativi su norme regolamentari.",
    urls: [
      {
        url: `${BASE_URL}/web/area-pubblica/emittenti-orientamenti-consob`,
        type: "orientamenti_list",
      },
      {
        url: `${BASE_URL}/web/area-pubblica/intermediari-orientamenti-consob`,
        type: "orientamenti_list",
      },
      {
        url: `${BASE_URL}/web/area-pubblica/collettiva-orientamenti-consob`,
        type: "orientamenti_list",
      },
    ],
  },
  {
    id: "CONSOB_CROWDFUNDING",
    name: "CONSOB Regolamento Crowdfunding (n. 22720/2023)",
    description:
      "Regolamento di attuazione del Regolamento (UE) 2020/1503 relativo ai fornitori europei di servizi di crowdfunding per le imprese.",
    urls: [
      {
        url: `${BASE_URL}/documents/1912911/1950567/reg_consob_2023_22720.pdf`,
        type: "regulation_pdf_index",
      },
    ],
  },
  {
    id: "CONSOB_SANZIONI",
    name: "CONSOB Provvedimenti Sanzionatori",
    description:
      "Delibere sanzionatorie della CONSOB nei confronti di emittenti, intermediari e soggetti vigilati per violazioni del TUF e dei regolamenti.",
    urls: [
      {
        url: `${BASE_URL}/web/area-pubblica/sanzioni`,
        type: "delibere_list",
      },
      {
        url: `${BASE_URL}/web/area-pubblica/bollettino`,
        type: "bollettino_list",
      },
    ],
  },
  {
    id: "BDI_285",
    name: "Banca d'Italia Circolare 285 (Disposizioni di vigilanza per le banche)",
    description:
      "Disposizioni di vigilanza prudenziale per le banche. Recepisce CRR/CRD IV: fondi propri, requisiti patrimoniali, governo societario, remunerazioni, processo ICAAP/SREP.",
    urls: [],
  },
  {
    id: "BDI_288",
    name: "Banca d'Italia Circolare 288 (Disposizioni di vigilanza per gli intermediari finanziari)",
    description:
      "Disposizioni di vigilanza per gli intermediari finanziari iscritti all'albo di cui all'art. 106 TUB. Disciplina governance, requisiti patrimoniali, antiriciclaggio, e segnalazioni di vigilanza.",
    urls: [],
  },
  {
    id: "IVASS_38",
    name: "IVASS Regolamento 38/2018 (Governance assicurativa)",
    description:
      "Regolamento IVASS n. 38 del 3 luglio 2018 recante disposizioni in materia di governo societario delle imprese di assicurazione. Recepisce la Direttiva Solvency II in materia di sistema di governance.",
    urls: [],
  },
];

// ─── Progress tracking ─────────────────────────────────────────────────────

function loadProgress(): IngestProgress {
  if (flagResume && existsSync(PROGRESS_FILE)) {
    try {
      const raw = readFileSync(PROGRESS_FILE, "utf-8");
      const parsed = JSON.parse(raw) as IngestProgress;
      console.log(`Ripresa da checkpoint: ${parsed.completed_urls.length} URL completati, ${parsed.provisions_inserted} disposizioni, ${parsed.enforcements_inserted} enforcement`);
      return parsed;
    } catch {
      console.warn("Impossibile leggere il file di progresso, ripartenza da zero.");
    }
  }
  return {
    completed_urls: [],
    provisions_inserted: 0,
    enforcements_inserted: 0,
    last_updated: new Date().toISOString(),
  };
}

function saveProgress(progress: IngestProgress): void {
  progress.last_updated = new Date().toISOString();
  writeFileSync(PROGRESS_FILE, JSON.stringify(progress, null, 2), "utf-8");
}

// ─── HTTP fetch with retry, rate limiting, and bot-protection handling ──────

let lastRequestTime = 0;

async function rateLimitedFetch(url: string): Promise<string> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await sleep(RATE_LIMIT_MS - elapsed);
  }

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      lastRequestTime = Date.now();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "it-IT,it;q=0.9,en;q=0.5",
          "Accept-Encoding": "gzip, deflate, br",
          "Connection": "keep-alive",
          "Cache-Control": "no-cache",
        },
        signal: controller.signal,
        redirect: "follow",
      });

      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText} per ${url}`);
      }

      const finalUrl = response.url;

      // Detect Radware bot-protection redirect
      if (finalUrl.includes("validate.perfdrive.com") || finalUrl.includes("botmanager")) {
        throw new Error(`Bot protection redirect rilevato per ${url} — il sito blocca richieste automatiche. Tentativo ${attempt}/${MAX_RETRIES}`);
      }

      const text = await response.text();

      // Secondary check: some bot walls return 200 with a challenge page
      if (text.includes("perfdrive") || text.includes("botmanager_support@radware.com")) {
        throw new Error(`Pagina di challenge bot rilevata nel body per ${url}`);
      }

      return text;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      console.warn(`  Tentativo ${attempt}/${MAX_RETRIES} fallito per ${url}: ${lastError.message}`);
      if (attempt < MAX_RETRIES) {
        const backoff = RETRY_BACKOFF_MS * attempt;
        console.log(`  Attesa ${backoff}ms prima del prossimo tentativo...`);
        await sleep(backoff);
      }
    }
  }

  throw new Error(`Tutti i ${MAX_RETRIES} tentativi falliti per ${url}: ${lastError?.message ?? "errore sconosciuto"}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── HTML Parsing: Regulation articles ─────────────────────────────────────

/**
 * Parses a CONSOB regulation HTML page and extracts individual articles.
 *
 * CONSOB regulation HTML pages follow several structural patterns:
 *
 * Pattern A (older regulations like Emittenti 11971):
 *   - Articles marked with <p> or <div> containing "Art." followed by number
 *   - Chapter/Titolo headings in bold or centered paragraphs
 *   - Inline styles rather than CSS classes
 *
 * Pattern B (newer regulations like Intermediari 20307):
 *   - More structured with heading tags (<h1>-<h4>) for parts/titles/chapters
 *   - Articles in <p> tags with "Art." prefix, sometimes with <b> or <strong>
 *
 * The parser handles both patterns by scanning for article boundaries.
 */
function parseRegulationHtml(
  html: string,
  sourcebookId: string,
  effectiveDate: string | null,
): ParsedProvision[] {
  const $ = cheerio.load(html);
  const provisions: ParsedProvision[] = [];

  let currentChapter: string | null = null;
  let currentSection: string | null = null;
  let currentTitle: string | null = null;

  // Identify the regulation short name from the sourcebook ID
  const regShortName = REGULATION_SHORT_NAMES[sourcebookId] ?? sourcebookId;

  // Remove script/style elements
  $("script, style, nav, header, footer").remove();

  // Get the main content body
  const body = $("body").length > 0 ? $("body") : $.root();

  // Collect all text nodes in document order by iterating block-level elements
  const blocks: Array<{ tag: string; text: string; html: string }> = [];

  body.find("p, div, h1, h2, h3, h4, h5, h6, td, li, span, blockquote, pre").each((_i, el) => {
    const $el = $(el);
    const tagName = "tagName" in el ? (el.tagName as string) : "unknown";
    // Skip nested elements (only process leaf-level blocks)
    if ($el.find("p, div, h1, h2, h3, h4, h5, h6").length > 0 && tagName !== "div") {
      return;
    }
    const text = $el.text().trim();
    if (text.length > 0) {
      blocks.push({
        tag: tagName.toLowerCase(),
        text,
        html: $el.html() ?? "",
      });
    }
  });

  // Regex patterns for structural elements
  const artPattern = /^Art\.?\s*(\d+[\w-]*(?:\s*-?\s*(?:bis|ter|quater|quinquies|sexies|septies|octies|novies|decies|undecies|duodecies|terdecies|quaterdecies|quindecies))?)/i;
  const chapterPattern = /^(?:CAPO|Capo)\s+([IVXLCDM]+(?:\s*-\s*[IVXLCDM]+)?)\b/;
  const titlePattern = /^(?:TITOLO|Titolo)\s+([IVXLCDM]+(?:\s*-\s*[IVXLCDM]+)?)\b/;
  const sectionPattern = /^(?:SEZIONE|Sezione)\s+([IVXLCDM]+(?:\s*-\s*[IVXLCDM]+)?)\b/;
  const partePattern = /^(?:PARTE|Parte)\s+([IVXLCDM]+(?:\s*-\s*[IVXLCDM]+)?)\b/;

  // Two-pass approach:
  // Pass 1: identify article start indices and structural context at each block
  interface ArticleSpan {
    startIdx: number;
    artNum: string;
    artTitle: string;
    chapter: string | null;
    section: string | null;
    titleNum: string | null;
  }

  const articleSpans: ArticleSpan[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const text = block.text;

    // Track structural context
    const parteMatch = text.match(partePattern);
    if (parteMatch) {
      // Parte is treated as a higher-level chapter
      currentChapter = `Parte ${parteMatch[1]!}`;
      currentSection = null;
      continue;
    }

    const titleMatch = text.match(titlePattern);
    if (titleMatch) {
      currentTitle = titleMatch[1] ?? null;
      currentSection = null;
      continue;
    }

    const chapterMatch = text.match(chapterPattern);
    if (chapterMatch) {
      currentChapter = chapterMatch[1] ?? null;
      currentSection = null;
      continue;
    }

    const sectionMatch = text.match(sectionPattern);
    if (sectionMatch) {
      currentSection = sectionMatch[1] ?? null;
      continue;
    }

    // Detect article start
    const artMatch = text.match(artPattern);
    if (artMatch) {
      const artNum = artMatch[1]!.trim();

      // Extract article title: text after the article number on the same line,
      // or on the next line if the current line is just "Art. N"
      let artTitle = "";
      const afterArtNum = text.slice(artMatch[0].length).trim();

      // Some pages put the title in parentheses or after a dash
      if (afterArtNum.length > 2) {
        // Title is on the same line
        artTitle = afterArtNum.replace(/^\s*[-–—.]\s*/, "").replace(/\(.*\)\s*$/, "").trim();
        // Take only the first sentence-like fragment as title (before a period or newline)
        const titleEnd = artTitle.search(/[.]\s/);
        if (titleEnd > 0 && titleEnd < 200) {
          artTitle = artTitle.slice(0, titleEnd).trim();
        }
      }

      articleSpans.push({
        startIdx: i,
        artNum,
        artTitle,
        chapter: currentChapter,
        section: currentSection,
        titleNum: currentTitle,
      });
    }
  }

  // Pass 2: extract text between consecutive article starts
  for (let a = 0; a < articleSpans.length; a++) {
    const span = articleSpans[a]!;
    const nextStart = a + 1 < articleSpans.length ? articleSpans[a + 1]!.startIdx : blocks.length;

    // Collect text from span.startIdx to nextStart
    const textParts: string[] = [];
    for (let i = span.startIdx; i < nextStart; i++) {
      const block = blocks[i]!;
      // Skip the article heading line itself from the body text if we extracted a title
      if (i === span.startIdx && span.artTitle) {
        // Include everything after the title line
        const afterHeading = block.text.slice(block.text.indexOf(span.artTitle) + span.artTitle.length).trim();
        if (afterHeading.length > 10) {
          textParts.push(afterHeading);
        }
        continue;
      }
      if (i === span.startIdx) {
        // No separate title — include everything after "Art. N"
        const artMatch = block.text.match(artPattern);
        if (artMatch) {
          const afterArt = block.text.slice(artMatch[0].length).trim();
          if (afterArt.length > 5) {
            textParts.push(afterArt);
          }
        }
        continue;
      }
      // Skip structural headings within the article body
      if (block.text.match(chapterPattern) || block.text.match(titlePattern) || block.text.match(sectionPattern)) {
        continue;
      }
      textParts.push(block.text);
    }

    const fullText = textParts.join("\n").trim();

    // Skip empty articles (repealed, etc.)
    if (fullText.length < 10) {
      continue;
    }

    const reference = `Art. ${span.artNum} ${regShortName}`;

    // Determine provision type
    let provType = "disposizione";
    if (/^1\b/.test(span.artNum) && /definizion/i.test(span.artTitle || fullText.slice(0, 200))) {
      provType = "definizione";
    }
    if (/sanzione|sanzioni|penalità/i.test(span.artTitle || "")) {
      provType = "sanzione";
    }

    // Detect abrogated articles
    let status = "in_vigore";
    if (/\babrogat[oai]\b/i.test(fullText.slice(0, 100)) || /\bsoppresso\b/i.test(fullText.slice(0, 100))) {
      status = "abrogato";
    }

    provisions.push({
      sourcebook_id: sourcebookId,
      reference,
      title: span.artTitle || `Articolo ${span.artNum}`,
      text: fullText,
      type: provType,
      status,
      effective_date: effectiveDate,
      chapter: span.chapter ?? (span.titleNum ? `Titolo ${span.titleNum}` : null),
      section: span.section,
    });
  }

  return provisions;
}

const REGULATION_SHORT_NAMES: Record<string, string> = {
  CONSOB_EMITTENTI: "Reg. Emittenti",
  CONSOB_INTERMEDIARI: "Reg. Intermediari",
  CONSOB_MERCATI: "Reg. Mercati",
  CONSOB_PARTI_CORRELATE: "Reg. Parti Correlate",
  CONSOB_CROWDFUNDING: "Reg. Crowdfunding",
};

const REGULATION_EFFECTIVE_DATES: Record<string, string> = {
  CONSOB_EMITTENTI: "1999-06-14",
  CONSOB_INTERMEDIARI: "2018-01-03",
  CONSOB_MERCATI: "2018-01-03",
  CONSOB_PARTI_CORRELATE: "2010-12-01",
  CONSOB_CROWDFUNDING: "2023-11-10",
};

// ─── HTML Parsing: Orientamenti / Communications listing pages ─────────────

/**
 * Parses a CONSOB orientamenti listing page and extracts communication entries.
 * These pages list guidance documents, Q&A, and interpretive communications.
 *
 * Typical structure:
 *   - A list of links with dates and titles
 *   - Each link points to a detail page or PDF
 *   - The listing may be paginated (Liferay portlet pagination)
 */
function parseOrientamentiList(
  html: string,
  sourcebookId: string,
): { provisions: ParsedProvision[]; nextPageUrl: string | null } {
  const $ = cheerio.load(html);
  const provisions: ParsedProvision[] = [];
  let nextPageUrl: string | null = null;

  // CONSOB uses Liferay CMS — content items are typically in asset-abstract or journal-content divs
  const contentItems = $(".asset-abstract, .journal-content-article, .entry-title, .asset-content, .portlet-body a, .results-row a, table.table a");

  contentItems.each((_i, el) => {
    const $el = $(el);
    const linkEl = $el.is("a") ? $el : $el.find("a").first();
    const title = (linkEl.text() || $el.text()).trim();
    const href = linkEl.attr("href");

    if (!title || title.length < 10) return;

    // Skip navigation links, pagination, breadcrumbs
    if (/^(pag\.|pagina|successiva|precedente|prima|ultima|mostra|\d+)$/i.test(title)) return;

    // Extract date if present in the text or a sibling element
    let dateText: string | null = null;
    const dateMatch = title.match(/(\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4})/);
    if (dateMatch) {
      dateText = normalizeDate(dateMatch[1]!);
    }

    // Extract reference number from patterns like "Comunicazione n. DEM/XXX" or "Delibera n. XXXXX"
    let reference = "";
    const comRefMatch = title.match(/(Comunicazione|Delibera|Nota|Raccomandazione|Richiamo)\s+(?:n\.?\s*)?([A-Z0-9/.-]+)/i);
    if (comRefMatch) {
      reference = `${comRefMatch[1]!} ${comRefMatch[2]!}`;
    } else {
      // Generate a reference from the title
      reference = title.slice(0, 80);
    }

    const fullUrl = href ? resolveUrl(href) : null;

    provisions.push({
      sourcebook_id: sourcebookId,
      reference,
      title: title.slice(0, 500),
      text: title, // We store the listing text; detail page crawl can enrich later
      type: "comunicazione",
      status: "in_vigore",
      effective_date: dateText,
      chapter: null,
      section: null,
    });
  });

  // Check for pagination: Liferay "next" link
  const nextLink = $("a.next, a[title='Successiva'], .pager .next a, .lfr-pagination-buttons .next a").attr("href");
  if (nextLink) {
    nextPageUrl = resolveUrl(nextLink);
  }

  return { provisions, nextPageUrl };
}

// ─── HTML Parsing: Delibere / Enforcement ──────────────────────────────────

/**
 * Parses a delibere listing page (sanctions) or bollettino index and extracts
 * links to individual enforcement decisions.
 *
 * Returns a list of detail-page URLs to crawl for full enforcement data.
 */
function parseDelibereList(html: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];

  // CONSOB delibere are linked as "/web/area-pubblica/-/delibera-n.-XXXXX" or "delibera-n-XXXXX"
  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    if (/delibera-n[.-]\d+/i.test(href)) {
      urls.push(resolveUrl(href));
    }
  });

  return [...new Set(urls)];
}

/**
 * Parses an individual delibera/enforcement decision page and extracts
 * structured enforcement data.
 */
function parseDeliberaPage(html: string): ParsedEnforcement | null {
  const $ = cheerio.load(html);

  // Remove noise
  $("script, style, nav, header, footer, .breadcrumb, .portlet-header").remove();

  const bodyText = $(".journal-content-article, .portlet-body, .asset-content, article, main, body")
    .first()
    .text()
    .trim();

  if (bodyText.length < 50) return null;

  // Extract delibera number from title or heading
  const pageTitle = $("h1, h2, .portlet-title, title").first().text().trim();
  const delNumMatch = pageTitle.match(/[Dd]elibera\s+n\.?\s*(\d+)/);
  const referenceNumber = delNumMatch ? `CONSOB-DEL-${delNumMatch[1]!}` : null;

  // Extract date
  let date: string | null = null;
  const datePatterns = [
    /del\s+(\d{1,2})\s+(gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre)\s+(\d{4})/i,
    /(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/,
  ];
  for (const pat of datePatterns) {
    const m = bodyText.match(pat);
    if (m) {
      if (m[2] && /[a-z]/i.test(m[2])) {
        date = parseItalianDate(m[1]!, m[2]!, m[3]!);
      } else if (m[1] && m[2] && m[3]) {
        date = normalizeDate(`${m[1]}/${m[2]}/${m[3]}`);
      }
      break;
    }
  }

  // Extract firm/person name — look for patterns like "nei confronti di XXX"
  let firmName = "Soggetto non identificato";
  const firmPatterns = [
    /nei confronti d(?:i|ella|ell'|el)\s+(.+?)(?:\s+per\b|\s*[,;.])/i,
    /a carico d(?:i|ella|ell'|el)\s+(.+?)(?:\s+per\b|\s*[,;.])/i,
    /sanzion[ea]\s+(?:amministrativa\s+)?(?:pecuniaria\s+)?(?:irrogata\s+)?(?:a|nei confronti di)\s+(.+?)(?:\s+per\b|\s*[,;.])/i,
  ];
  for (const pat of firmPatterns) {
    const m = bodyText.match(pat);
    if (m && m[1]) {
      firmName = m[1].trim().slice(0, 200);
      break;
    }
  }

  // Extract sanction amount
  let amount: number | null = null;
  const amountPatterns = [
    /(?:euro|EUR|€)\s*([\d.,]+)/i,
    /([\d.,]+)\s*(?:euro|EUR|€)/i,
    /sanzione\s+(?:amministrativa\s+)?(?:pecuniaria\s+)?(?:(?:complessiva|pari)\s+)?(?:di\s+)?(?:euro|EUR|€)\s*([\d.,]+)/i,
  ];
  for (const pat of amountPatterns) {
    const m = bodyText.match(pat);
    if (m && m[1]) {
      amount = parseItalianNumber(m[1]);
      break;
    }
  }

  // Determine action type
  let actionType = "delibera";
  if (/sanzione|sanzioni/i.test(bodyText.slice(0, 500))) actionType = "sanzione";
  if (/radiazione/i.test(bodyText.slice(0, 500))) actionType = "radiazione";
  if (/sospensione/i.test(bodyText.slice(0, 500))) actionType = "sospensione";
  if (/ammonizione/i.test(bodyText.slice(0, 500))) actionType = "ammonizione";
  if (/diffida/i.test(bodyText.slice(0, 500))) actionType = "diffida";

  // Build summary from the first meaningful paragraph (up to 1000 chars)
  const summary = bodyText
    .replace(/\s+/g, " ")
    .slice(0, 1000)
    .trim();

  // Extract sourcebook references from mentions like "art. XX TUF", "Reg. Emittenti", etc.
  const refMatches = bodyText.match(/(?:art\.?\s*\d+[\w-]*\s*(?:TUF|Reg\.?\s*(?:Emittenti|Intermediari|Mercati)|d\.lgs\.?\s*\d+\/\d+))/gi);
  const sourcebookReferences = refMatches ? [...new Set(refMatches)].join(", ") : null;

  return {
    firm_name: firmName,
    reference_number: referenceNumber ?? `CONSOB-${Date.now()}`,
    action_type: actionType,
    amount,
    date,
    summary,
    sourcebook_references: sourcebookReferences,
  };
}

// ─── HTML Parsing: Bollettino listing ──────────────────────────────────────

/**
 * Parses the bollettino (bulletin) index page and extracts links to
 * individual bollettino HTML delibere pages.
 * The bollettino is organized as bi-weekly issues in HTML and PDF format.
 */
function parseBollettinoList(html: string): string[] {
  const $ = cheerio.load(html);
  const urls: string[] = [];

  $("a[href]").each((_i, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    // Look for delibera links within bollettino
    if (/delibera-n[.-]\d+/i.test(href) || /d\d{5}/i.test(href)) {
      urls.push(resolveUrl(href));
    }
    // Also collect bollettino period pages that list delibere
    if (/bollettino.*periodo/i.test(href) || /bollnov|bollgen|bollfeb|bollmar|bollapr|bollmag|bollgiu|bolllug|bollago|bollset|bollott|bolldic/i.test(href)) {
      urls.push(resolveUrl(href));
    }
  });

  return [...new Set(urls)];
}

// ─── Utility functions ─────────────────────────────────────────────────────

function resolveUrl(href: string): string {
  if (href.startsWith("http://") || href.startsWith("https://")) {
    return href;
  }
  if (href.startsWith("/")) {
    return `${BASE_URL}${href}`;
  }
  return `${BASE_URL}/${href}`;
}

const ITALIAN_MONTHS: Record<string, string> = {
  gennaio: "01", febbraio: "02", marzo: "03", aprile: "04",
  maggio: "05", giugno: "06", luglio: "07", agosto: "08",
  settembre: "09", ottobre: "10", novembre: "11", dicembre: "12",
};

function parseItalianDate(day: string, month: string, year: string): string {
  const mm = ITALIAN_MONTHS[month.toLowerCase()];
  if (!mm) return `${year}-01-01`;
  return `${year}-${mm}-${day.padStart(2, "0")}`;
}

function normalizeDate(raw: string): string {
  // Handles DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
  const parts = raw.split(/[\/.\-]/);
  if (parts.length !== 3) return raw;
  const [dd, mm, yyyy] = parts as [string, string, string];
  const year = yyyy.length === 2 ? `20${yyyy}` : yyyy;
  return `${year}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
}

function parseItalianNumber(raw: string): number {
  // Italian numbers use . as thousands separator and , as decimal separator
  const cleaned = raw.replace(/\./g, "").replace(",", ".");
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : num;
}

// ─── Database operations ───────────────────────────────────────────────────

function initDb(): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
    console.log(`Creata directory: ${dir}`);
  }

  if (flagForce && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Database eliminato (--force): ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  console.log(`Database inizializzato: ${DB_PATH}`);
  return db;
}

function insertSourcebooks(db: Database.Database): void {
  const stmt = db.prepare("INSERT OR IGNORE INTO sourcebooks (id, name, description) VALUES (?, ?, ?)");
  const tx = db.transaction(() => {
    for (const sb of SOURCEBOOKS) {
      stmt.run(sb.id, sb.name, sb.description);
    }
  });
  tx();
  console.log(`Inseriti/aggiornati ${SOURCEBOOKS.length} sourcebook`);
}

function insertProvisions(db: Database.Database, provisions: ParsedProvision[]): number {
  if (provisions.length === 0) return 0;

  const stmt = db.prepare(`
    INSERT OR REPLACE INTO provisions (sourcebook_id, reference, title, text, type, status, effective_date, chapter, section)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const p of provisions) {
      try {
        stmt.run(
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
        count++;
      } catch (err) {
        console.warn(`  Errore inserimento disposizione "${p.reference}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  tx();
  return count;
}

function insertEnforcements(db: Database.Database, enforcements: ParsedEnforcement[]): number {
  if (enforcements.length === 0) return 0;

  const stmt = db.prepare(`
    INSERT INTO enforcement_actions (firm_name, reference_number, action_type, amount, date, summary, sourcebook_references)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  const tx = db.transaction(() => {
    for (const e of enforcements) {
      try {
        // Check if already exists by reference number
        const existing = db.prepare("SELECT id FROM enforcement_actions WHERE reference_number = ?").get(e.reference_number);
        if (existing) continue;

        stmt.run(
          e.firm_name,
          e.reference_number,
          e.action_type,
          e.amount,
          e.date,
          e.summary,
          e.sourcebook_references,
        );
        count++;
      } catch (err) {
        console.warn(`  Errore inserimento enforcement "${e.reference_number}": ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  });
  tx();
  return count;
}

// ─── Crawl orchestration ───────────────────────────────────────────────────

async function crawlRegulationHtml(
  url: string,
  sourcebookId: string,
): Promise<ParsedProvision[]> {
  console.log(`  Scaricamento regolamento HTML: ${url}`);
  try {
    const html = await rateLimitedFetch(url);
    const effectiveDate = REGULATION_EFFECTIVE_DATES[sourcebookId] ?? null;
    const provisions = parseRegulationHtml(html, sourcebookId, effectiveDate);
    console.log(`  Estratti ${provisions.length} articoli da ${sourcebookId}`);
    return provisions;
  } catch (err) {
    console.error(`  Errore crawl regolamento ${sourcebookId}: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

async function crawlOrientamentiList(
  url: string,
  sourcebookId: string,
): Promise<ParsedProvision[]> {
  console.log(`  Scaricamento orientamenti: ${url}`);
  const allProvisions: ParsedProvision[] = [];
  let currentUrl: string | null = url;
  let pageNum = 1;
  const maxPages = 10; // Safety limit on pagination

  while (currentUrl && pageNum <= maxPages) {
    try {
      const html = await rateLimitedFetch(currentUrl);
      const { provisions, nextPageUrl } = parseOrientamentiList(html, sourcebookId);
      allProvisions.push(...provisions);
      console.log(`    Pagina ${pageNum}: ${provisions.length} comunicazioni`);
      currentUrl = nextPageUrl;
      pageNum++;
    } catch (err) {
      console.error(`  Errore crawl orientamenti pagina ${pageNum}: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  return allProvisions;
}

async function crawlDelibereList(url: string): Promise<ParsedEnforcement[]> {
  console.log(`  Scaricamento lista delibere: ${url}`);
  const enforcements: ParsedEnforcement[] = [];

  try {
    const html = await rateLimitedFetch(url);
    const delibereUrls = parseDelibereList(html);
    console.log(`  Trovate ${delibereUrls.length} delibere da analizzare`);

    const maxDelibere = 50; // Safety limit per list page
    const toProcess = delibereUrls.slice(0, maxDelibere);

    for (const deliberaUrl of toProcess) {
      try {
        console.log(`    Scaricamento delibera: ${deliberaUrl}`);
        const deliberaHtml = await rateLimitedFetch(deliberaUrl);
        const enforcement = parseDeliberaPage(deliberaHtml);
        if (enforcement) {
          enforcements.push(enforcement);
        }
      } catch (err) {
        console.warn(`    Errore delibera ${deliberaUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    console.error(`  Errore crawl lista delibere: ${err instanceof Error ? err.message : String(err)}`);
  }

  return enforcements;
}

async function crawlBollettinoList(url: string): Promise<ParsedEnforcement[]> {
  console.log(`  Scaricamento bollettino: ${url}`);
  const enforcements: ParsedEnforcement[] = [];

  try {
    const html = await rateLimitedFetch(url);
    const urls = parseBollettinoList(html);
    console.log(`  Trovati ${urls.length} link nel bollettino`);

    // Only process delibera URLs (not period index pages, to avoid infinite recursion)
    const delibereUrls = urls.filter((u) => /delibera-n[.-]\d+/i.test(u));
    const maxDelibere = 30;
    const toProcess = delibereUrls.slice(0, maxDelibere);

    for (const deliberaUrl of toProcess) {
      try {
        console.log(`    Scaricamento delibera dal bollettino: ${deliberaUrl}`);
        const deliberaHtml = await rateLimitedFetch(deliberaUrl);
        const enforcement = parseDeliberaPage(deliberaHtml);
        if (enforcement) {
          enforcements.push(enforcement);
        }
      } catch (err) {
        console.warn(`    Errore delibera bollettino ${deliberaUrl}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    console.error(`  Errore crawl bollettino: ${err instanceof Error ? err.message : String(err)}`);
  }

  return enforcements;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  CONSOB Ingestion Crawler");
  console.log(`  Database:  ${DB_PATH}`);
  console.log(`  Modalità:  ${flagDryRun ? "DRY RUN (nessuna scrittura)" : "LIVE"}`);
  console.log(`  Resume:    ${flagResume ? "SI" : "NO"}`);
  console.log(`  Force:     ${flagForce ? "SI (ricreazione DB)" : "NO"}`);
  console.log("═══════════════════════════════════════════════════════════════\n");

  const progress = loadProgress();

  // Initialize database (unless dry-run)
  let db: Database.Database | null = null;
  if (!flagDryRun) {
    db = initDb();
    insertSourcebooks(db);
  } else {
    console.log("[DRY RUN] Database non inizializzato\n");
  }

  let totalProvisions = progress.provisions_inserted;
  let totalEnforcements = progress.enforcements_inserted;

  for (const sourcebook of SOURCEBOOKS) {
    if (sourcebook.urls.length === 0) {
      console.log(`\n[SKIP] ${sourcebook.id} — nessun URL configurato (fonte esterna)`);
      continue;
    }

    console.log(`\n─── ${sourcebook.id} ───`);

    for (const target of sourcebook.urls) {
      // Skip already-completed URLs when resuming
      if (flagResume && progress.completed_urls.includes(target.url)) {
        console.log(`  [SKIP] URL gia completato: ${target.url}`);
        continue;
      }

      try {
        switch (target.type) {
          case "regulation_html": {
            const provisions = await crawlRegulationHtml(target.url, sourcebook.id);
            if (!flagDryRun && db && provisions.length > 0) {
              const inserted = insertProvisions(db, provisions);
              totalProvisions += inserted;
              console.log(`  Inserite ${inserted} disposizioni nel database`);
            } else if (flagDryRun) {
              console.log(`  [DRY RUN] Estratte ${provisions.length} disposizioni`);
              for (const p of provisions.slice(0, 3)) {
                console.log(`    - ${p.reference}: ${p.title}`);
              }
              if (provisions.length > 3) {
                console.log(`    ... e altre ${provisions.length - 3}`);
              }
            }
            break;
          }

          case "regulation_pdf_index": {
            // PDF regulations are not crawled directly — they require PDF parsing.
            // Log the URL for manual processing or future PDF extraction.
            console.log(`  [NOTA] Regolamento PDF (non crawlabile via HTML): ${target.url}`);
            console.log(`  Usare un estrattore PDF dedicato per questo regolamento.`);
            break;
          }

          case "orientamenti_list": {
            const provisions = await crawlOrientamentiList(target.url, sourcebook.id);
            if (!flagDryRun && db && provisions.length > 0) {
              const inserted = insertProvisions(db, provisions);
              totalProvisions += inserted;
              console.log(`  Inserite ${inserted} comunicazioni nel database`);
            } else if (flagDryRun) {
              console.log(`  [DRY RUN] Estratte ${provisions.length} comunicazioni`);
            }
            break;
          }

          case "delibere_list": {
            const enforcements = await crawlDelibereList(target.url);
            if (!flagDryRun && db && enforcements.length > 0) {
              const inserted = insertEnforcements(db, enforcements);
              totalEnforcements += inserted;
              console.log(`  Inseriti ${inserted} provvedimenti sanzionatori`);
            } else if (flagDryRun) {
              console.log(`  [DRY RUN] Estratti ${enforcements.length} provvedimenti`);
            }
            break;
          }

          case "bollettino_list": {
            const enforcements = await crawlBollettinoList(target.url);
            if (!flagDryRun && db && enforcements.length > 0) {
              const inserted = insertEnforcements(db, enforcements);
              totalEnforcements += inserted;
              console.log(`  Inseriti ${inserted} provvedimenti dal bollettino`);
            } else if (flagDryRun) {
              console.log(`  [DRY RUN] Estratti ${enforcements.length} provvedimenti dal bollettino`);
            }
            break;
          }
        }

        // Mark URL as completed
        progress.completed_urls.push(target.url);
        progress.provisions_inserted = totalProvisions;
        progress.enforcements_inserted = totalEnforcements;
        saveProgress(progress);
      } catch (err) {
        console.error(`  ERRORE FATALE per ${target.url}: ${err instanceof Error ? err.message : String(err)}`);
        // Save progress even on failure so --resume can skip completed work
        saveProgress(progress);
      }
    }
  }

  // ── Final summary ──────────────────────────────────────────────────────

  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  Riepilogo ingestion");
  console.log("═══════════════════════════════════════════════════════════════");

  if (db && !flagDryRun) {
    const provisionCount = (db.prepare("SELECT count(*) as cnt FROM provisions").get() as { cnt: number }).cnt;
    const sourcebookCount = (db.prepare("SELECT count(*) as cnt FROM sourcebooks").get() as { cnt: number }).cnt;
    const enforcementCount = (db.prepare("SELECT count(*) as cnt FROM enforcement_actions").get() as { cnt: number }).cnt;
    const ftsCount = (db.prepare("SELECT count(*) as cnt FROM provisions_fts").get() as { cnt: number }).cnt;

    console.log(`  Sourcebook:                ${sourcebookCount}`);
    console.log(`  Disposizioni totali:       ${provisionCount}`);
    console.log(`  Provvedimenti enforcement: ${enforcementCount}`);
    console.log(`  Voci indice FTS:           ${ftsCount}`);
    console.log(`  URL completati:            ${progress.completed_urls.length}`);

    db.close();
  } else {
    console.log(`  [DRY RUN] Disposizioni estratte:       ${totalProvisions}`);
    console.log(`  [DRY RUN] Provvedimenti estratti:      ${totalEnforcements}`);
    console.log(`  URL processati:                        ${progress.completed_urls.length}`);
  }

  console.log(`\n  File di progresso: ${PROGRESS_FILE}`);
  console.log(`  Database:          ${DB_PATH}`);
  console.log("═══════════════════════════════════════════════════════════════");
}

main().catch((err) => {
  console.error("Errore fatale nell'ingestion:", err);
  process.exit(1);
});
