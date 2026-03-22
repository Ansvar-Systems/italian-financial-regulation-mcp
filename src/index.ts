#!/usr/bin/env node

/**
 * Italian Financial Regulation MCP — stdio entry point.
 *
 * Provides MCP tools for querying Italian financial regulation:
 * CONSOB regolamenti, Banca d'Italia circolari, IVASS regolamenti,
 * enforcement actions, and currency checks.
 *
 * Tool prefix: it_fin_
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
} from "./db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback to default
}

const SERVER_NAME = "italian-financial-regulation-mcp";

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "it_fin_search_regulations",
    description:
      "Ricerca full-text nelle disposizioni regolamentari italiane: CONSOB Regolamento Emittenti, Regolamento Intermediari, Banca d'Italia Circolari, e IVASS Regolamenti. Restituisce articoli, disposizioni e orientamenti corrispondenti.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Query di ricerca (es. 'conflitti di interesse', 'valutazione di adeguatezza', 'intermediari')",
        },
        sourcebook: {
          type: "string",
          description: "Filtra per ID sourcebook (es. CONSOB_EMITTENTI, BDI_285, IVASS_38). Opzionale.",
        },
        status: {
          type: "string",
          enum: ["in_vigore", "abrogato", "non_ancora_in_vigore"],
          description: "Filtra per stato della disposizione. Default: tutti gli stati.",
        },
        limit: {
          type: "number",
          description: "Numero massimo di risultati da restituire. Default: 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "it_fin_get_regulation",
    description:
      "Recupera una specifica disposizione regolamentare italiana tramite sourcebook e riferimento. Accetta riferimenti come 'Art. 21 TUF', 'Art. 6 Reg. Emittenti', o 'Circ. 285 Tit. IV'.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: {
          type: "string",
          description: "Identificatore del sourcebook (es. CONSOB_EMITTENTI, BDI_285, BDI_288, IVASS_38)",
        },
        reference: {
          type: "string",
          description: "Riferimento completo alla disposizione (es. 'Art. 21', 'Art. 6', 'Tit. IV Cap. I')",
        },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "it_fin_list_sourcebooks",
    description:
      "Elenca tutti i sourcebook di regolamentazione finanziaria italiana disponibili: CONSOB Regolamenti, CONSOB Comunicazioni, Banca d'Italia Circolari, e IVASS Regolamenti.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
  {
    name: "it_fin_search_enforcement",
    description:
      "Ricerca sanzioni e provvedimenti CONSOB — delibere sanzionatorie, sospensioni, e interdizioni. Restituisce i provvedimenti di enforcement corrispondenti.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "Query di ricerca (es. nome impresa, tipo di violazione, 'abuso di mercato')",
        },
        action_type: {
          type: "string",
          enum: ["sanzione", "sospensione", "interdizione", "diffida"],
          description: "Filtra per tipo di provvedimento. Opzionale.",
        },
        limit: {
          type: "number",
          description: "Numero massimo di risultati da restituire. Default: 20.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "it_fin_check_currency",
    description:
      "Verifica se uno specifico riferimento regolamentare italiano è attualmente in vigore. Restituisce lo stato e la data di efficacia.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: {
          type: "string",
          description: "Riferimento completo alla disposizione da verificare (es. 'Art. 21 Reg. Emittenti')",
        },
      },
      required: ["reference"],
    },
  },
  {
    name: "it_fin_about",
    description: "Restituisce metadati su questo server MCP: versione, fonti dati, elenco strumenti.",
    inputSchema: {
      type: "object" as const,
      properties: {},
      required: [],
    },
  },
];

// ─── Zod schemas for argument validation ────────────────────────────────────

const SearchRegulationsArgs = z.object({
  query: z.string().min(1),
  sourcebook: z.string().optional(),
  status: z.enum(["in_vigore", "abrogato", "non_ancora_in_vigore"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const GetRegulationArgs = z.object({
  sourcebook: z.string().min(1),
  reference: z.string().min(1),
});

const SearchEnforcementArgs = z.object({
  query: z.string().min(1),
  action_type: z.enum(["sanzione", "sospensione", "interdizione", "diffida"]).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

const CheckCurrencyArgs = z.object({
  reference: z.string().min(1),
});

// ─── Helper ──────────────────────────────────────────────────────────────────

function textContent(data: unknown) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(data, null, 2) },
    ],
  };
}

function errorContent(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

// ─── Server setup ────────────────────────────────────────────────────────────

const server = new Server(
  { name: SERVER_NAME, version: pkgVersion },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case "it_fin_search_regulations": {
        const parsed = SearchRegulationsArgs.parse(args);
        const results = searchProvisions({
          query: parsed.query,
          sourcebook: parsed.sourcebook,
          status: parsed.status,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "it_fin_get_regulation": {
        const parsed = GetRegulationArgs.parse(args);
        const provision = getProvision(parsed.sourcebook, parsed.reference);
        if (!provision) {
          return errorContent(
            `Disposizione non trovata: ${parsed.sourcebook} ${parsed.reference}`,
          );
        }
        return textContent(provision);
      }

      case "it_fin_list_sourcebooks": {
        const sourcebooks = listSourcebooks();
        return textContent({ sourcebooks, count: sourcebooks.length });
      }

      case "it_fin_search_enforcement": {
        const parsed = SearchEnforcementArgs.parse(args);
        const results = searchEnforcement({
          query: parsed.query,
          action_type: parsed.action_type,
          limit: parsed.limit,
        });
        return textContent({ results, count: results.length });
      }

      case "it_fin_check_currency": {
        const parsed = CheckCurrencyArgs.parse(args);
        const currency = checkProvisionCurrency(parsed.reference);
        return textContent(currency);
      }

      case "it_fin_about": {
        return textContent({
          name: SERVER_NAME,
          version: pkgVersion,
          description:
            "Server MCP per la regolamentazione finanziaria italiana. Fornisce accesso a CONSOB Regolamento Emittenti, Regolamento Intermediari, Regolamento Mercati, Banca d'Italia Circolari 285 e 288, e IVASS Regolamenti.",
          data_sources: [
            "CONSOB — Commissione Nazionale per le Società e la Borsa (https://www.consob.it/)",
            "Banca d'Italia — Vigilanza bancaria e finanziaria (https://www.bancaditalia.it/)",
            "IVASS — Istituto per la Vigilanza sulle Assicurazioni (https://www.ivass.it/)",
          ],
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description })),
        });
      }

      default:
        return errorContent(`Strumento sconosciuto: ${name}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errorContent(`Errore nell'esecuzione di ${name}: ${message}`);
  }
});

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`${SERVER_NAME} v${pkgVersion} running on stdio\n`);
}

main().catch((err) => {
  process.stderr.write(`Fatal error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
