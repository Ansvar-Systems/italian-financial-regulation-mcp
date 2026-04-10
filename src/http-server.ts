#!/usr/bin/env node

/**
 * HTTP Server Entry Point for Docker Deployment
 *
 * Provides Streamable HTTP transport for remote MCP clients.
 * Use src/index.ts for local stdio-based usage.
 *
 * Endpoints:
 *   GET  /health  — liveness probe
 *   POST /mcp     — MCP Streamable HTTP (session-aware)
 */

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  listSourcebooks,
  searchProvisions,
  getProvision,
  searchEnforcement,
  checkProvisionCurrency,
} from "./db.js";
import { buildCitation } from "./utils/citation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env["PORT"] ?? "3000", 10);
const SERVER_NAME = "italian-financial-regulation-mcp";

// ─── Coverage metadata ───────────────────────────────────────────────────────

let DATA_AGE = "unknown";
try {
  const coveragePath = join(__dirname, "..", "data", "coverage.json");
  if (existsSync(coveragePath)) {
    const coverage = JSON.parse(readFileSync(coveragePath, "utf8")) as { data_age: string };
    DATA_AGE = coverage.data_age;
  }
} catch {
  // fallback
}

const DISCLAIMER =
  "This tool provides informational access to Italian financial regulations. It is not legal advice. Always verify against official sources.";
const COPYRIGHT =
  "© CONSOB, Banca d'Italia, IVASS — official regulatory text. Aggregated for informational use under applicable public-access rules.";

function responseMeta(sourceUrl?: string) {
  return {
    data_age: DATA_AGE,
    disclaimer: DISCLAIMER,
    copyright: COPYRIGHT,
    ...(sourceUrl !== undefined && { source_url: sourceUrl }),
  };
}

let pkgVersion = "0.1.0";
try {
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string };
  pkgVersion = pkg.version;
} catch {
  // fallback
}

// ─── Tool definitions (shared with index.ts) ─────────────────────────────────

const TOOLS = [
  {
    name: "it_fin_search_regulations",
    description:
      "Ricerca full-text nelle disposizioni regolamentari italiane: CONSOB Regolamento Emittenti, Regolamento Intermediari, Banca d'Italia Circolari, e IVASS Regolamenti. Restituisce articoli, disposizioni e orientamenti corrispondenti.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Query di ricerca (es. 'conflitti di interesse', 'adeguatezza')" },
        sourcebook: { type: "string", description: "Filtra per ID sourcebook (es. CONSOB_EMITTENTI, BDI_285). Opzionale." },
        status: {
          type: "string",
          enum: ["in_vigore", "abrogato", "non_ancora_in_vigore"],
          description: "Filtra per stato della disposizione. Opzionale.",
        },
        limit: { type: "number", description: "Numero massimo di risultati (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "it_fin_get_regulation",
    description:
      "Recupera una specifica disposizione regolamentare italiana tramite sourcebook e riferimento.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sourcebook: { type: "string", description: "Identificatore del sourcebook (es. CONSOB_EMITTENTI, BDI_285)" },
        reference: { type: "string", description: "Riferimento alla disposizione (es. 'Art. 21', 'Tit. IV Cap. I')" },
      },
      required: ["sourcebook", "reference"],
    },
  },
  {
    name: "it_fin_list_sourcebooks",
    description: "Elenca tutti i sourcebook di regolamentazione finanziaria italiana disponibili.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "it_fin_search_enforcement",
    description:
      "Ricerca sanzioni e provvedimenti CONSOB — delibere sanzionatorie, sospensioni, e interdizioni.",
    inputSchema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Query di ricerca (nome impresa, tipo di violazione, etc.)" },
        action_type: {
          type: "string",
          enum: ["sanzione", "sospensione", "interdizione", "diffida"],
          description: "Filtra per tipo di provvedimento. Opzionale.",
        },
        limit: { type: "number", description: "Numero massimo di risultati (default 20)." },
      },
      required: ["query"],
    },
  },
  {
    name: "it_fin_check_currency",
    description: "Verifica se uno specifico riferimento regolamentare italiano è attualmente in vigore.",
    inputSchema: {
      type: "object" as const,
      properties: {
        reference: { type: "string", description: "Riferimento alla disposizione da verificare" },
      },
      required: ["reference"],
    },
  },
  {
    name: "it_fin_about",
    description: "Restituisce metadati su questo server MCP: versione, fonti dati, elenco strumenti.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
  {
    name: "it_fin_check_data_freshness",
    description:
      "Verifica la data di aggiornamento dei dati, il tipo di sorgente (live/frozen) e l'elenco dei sourcebook disponibili. Strumento meta obbligatorio per verificare la freschezza dei dati prima di utilizzare risposte regolamentari.",
    inputSchema: { type: "object" as const, properties: {}, required: [] },
  },
];

// ─── Zod schemas ─────────────────────────────────────────────────────────────

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

// ─── MCP server factory ──────────────────────────────────────────────────────

function createMcpServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: pkgVersion },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    function textContent(data: unknown) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
      };
    }

    function errorContent(message: string, errorType: string = "internal_error") {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ error: message, _error_type: errorType, _meta: responseMeta() }),
          },
        ],
        isError: true as const,
      };
    }

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
          const resultsWithCitation = results.map((r) => ({
            ...r,
            _citation: buildCitation(
              `${r.sourcebook_id} ${r.reference}`,
              String(r.title ?? `${r.sourcebook_id} ${r.reference}`),
              "it_fin_get_regulation",
              { sourcebook: r.sourcebook_id, reference: r.reference },
            ),
          }));
          return textContent({ results: resultsWithCitation, count: resultsWithCitation.length, _meta: responseMeta() });
        }

        case "it_fin_get_regulation": {
          const parsed = GetRegulationArgs.parse(args);
          const provision = getProvision(parsed.sourcebook, parsed.reference);
          if (!provision) {
            return errorContent(
              `Disposizione non trovata: ${parsed.sourcebook} ${parsed.reference}`,
              "not_found",
            );
          }
          const prov = provision as unknown as Record<string, unknown>;
          return textContent({
            ...provision,
            _citation: buildCitation(
              `${parsed.sourcebook} ${parsed.reference}`,
              String(prov.title ?? `${parsed.sourcebook} ${parsed.reference}`),
              "it_fin_get_regulation",
              { sourcebook: parsed.sourcebook, reference: parsed.reference },
              "https://www.consob.it/",
            ),
            _meta: responseMeta("https://www.consob.it/"),
          });
        }

        case "it_fin_list_sourcebooks": {
          const sourcebooks = listSourcebooks();
          return textContent({ sourcebooks, count: sourcebooks.length, _meta: responseMeta() });
        }

        case "it_fin_search_enforcement": {
          const parsed = SearchEnforcementArgs.parse(args);
          const results = searchEnforcement({
            query: parsed.query,
            action_type: parsed.action_type,
            limit: parsed.limit,
          });
          const resultsWithCitation = results.map((r) => ({
            ...r,
            _citation: buildCitation(
              String(r.reference_number ?? r.firm_name),
              r.firm_name,
              "it_fin_search_enforcement",
              { query: parsed.query },
            ),
          }));
          return textContent({ results: resultsWithCitation, count: resultsWithCitation.length, _meta: responseMeta() });
        }

        case "it_fin_check_currency": {
          const parsed = CheckCurrencyArgs.parse(args);
          const currency = checkProvisionCurrency(parsed.reference);
          return textContent({ ...currency, _meta: responseMeta() });
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
            _meta: responseMeta(),
          });
        }

        case "it_fin_check_data_freshness": {
          return textContent({
            data_age: DATA_AGE,
            source_type: "live",
            sourcebooks: listSourcebooks().map((s) => s.id),
            _meta: responseMeta(),
          });
        }

        default:
          return errorContent(`Strumento sconosciuto: ${name}`, "unknown_tool");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorContent(`Errore nell'esecuzione di ${name}: ${message}`, "internal_error");
    }
  });

  return server;
}

// ─── HTTP server ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const sessions = new Map<
    string,
    { transport: StreamableHTTPServerTransport; server: Server }
  >();

  const httpServer = createServer((req, res) => {
    handleRequest(req, res, sessions).catch((err) => {
      console.error(`[${SERVER_NAME}] Unhandled error:`, err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    });
  });

  async function handleRequest(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    activeSessions: Map<
      string,
      { transport: StreamableHTTPServerTransport; server: Server }
    >,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: SERVER_NAME, version: pkgVersion }));
      return;
    }

    if (url.pathname === "/mcp") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (sessionId && activeSessions.has(sessionId)) {
        const session = activeSessions.get(sessionId)!;
        await session.transport.handleRequest(req, res);
        return;
      }

      // New session — create a fresh MCP server instance per session
      const mcpServer = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- SDK type mismatch with exactOptionalPropertyTypes
      await mcpServer.connect(transport as any);

      transport.onclose = () => {
        if (transport.sessionId) {
          activeSessions.delete(transport.sessionId);
        }
        mcpServer.close().catch(() => {});
      };

      await transport.handleRequest(req, res);

      // Store AFTER handleRequest — sessionId is set during initialize
      if (transport.sessionId) {
        activeSessions.set(transport.sessionId, { transport, server: mcpServer });
      }
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  httpServer.listen(PORT, () => {
    console.error(`${SERVER_NAME} v${pkgVersion} (HTTP) listening on port ${PORT}`);
    console.error(`MCP endpoint:  http://localhost:${PORT}/mcp`);
    console.error(`Health check:  http://localhost:${PORT}/health`);
  });

  process.on("SIGTERM", () => {
    console.error("Received SIGTERM, shutting down...");
    httpServer.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
