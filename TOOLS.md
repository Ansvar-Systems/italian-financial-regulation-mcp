# Tools

This MCP server exposes 7 tools under the `it_fin_` prefix.

## it_fin_search_regulations

Full-text search across Italian financial regulation provisions (CONSOB, Banca d'Italia, IVASS).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query (e.g. `"conflitti di interesse"`, `"adeguatezza"`) |
| `sourcebook` | string | no | Filter by sourcebook ID (e.g. `CONSOB_EMITTENTI`, `BDI_285`) |
| `status` | `"in_vigore"` \| `"abrogato"` \| `"non_ancora_in_vigore"` | no | Filter by provision status |
| `limit` | number | no | Max results to return (default: 20, max: 100) |

Returns: `{ results: Provision[], count: number, _meta }` — each result includes `_citation`.

---

## it_fin_get_regulation

Retrieve a specific Italian financial regulation provision by sourcebook and reference.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sourcebook` | string | yes | Sourcebook ID (e.g. `CONSOB_EMITTENTI`, `BDI_285`) |
| `reference` | string | yes | Provision reference (e.g. `"Art. 21"`, `"Tit. IV Cap. I"`) |

Returns: full `Provision` object with `_citation` and `_meta`, or error if not found.

---

## it_fin_list_sourcebooks

List all available Italian financial regulation sourcebooks.

No parameters.

Returns: `{ sourcebooks: Sourcebook[], count: number, _meta }`.

---

## it_fin_search_enforcement

Search CONSOB enforcement actions (sanctions, suspensions, interdictions).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | yes | Search query (e.g. firm name, violation type, `"abuso di mercato"`) |
| `action_type` | `"sanzione"` \| `"sospensione"` \| `"interdizione"` \| `"diffida"` | no | Filter by action type |
| `limit` | number | no | Max results to return (default: 20, max: 100) |

Returns: `{ results: EnforcementAction[], count: number, _meta }` — each result includes `_citation`.

**Note:** `_citation.lookup.tool` points back to `it_fin_search_enforcement` (no singleton get-enforcement tool exists). See COVERAGE.md for details.

---

## it_fin_check_currency

Check whether a specific Italian regulation reference is currently in force.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `reference` | string | yes | Provision reference to check (e.g. `"Art. 21 Reg. Emittenti"`) |

Returns: `{ reference, status, effective_date, found, _meta }`.

---

## it_fin_about

Return metadata about this MCP server: version, data sources, tool list.

No parameters.

Returns: `{ name, version, description, data_sources, tools, _meta }`.

---

## it_fin_check_data_freshness

Meta-tool: returns data age, source type, and available sourcebook IDs. Use to verify freshness before relying on regulatory answers.

No parameters.

Returns: `{ data_age, source_type, sourcebooks: string[], _meta }`.
