# uk-business-mcp

MCP server that lets Claude look up **UK companies** (Companies House) and **UK postcodes** (postcodes.io).

Ask things like:
- "Is Acme Trading Ltd still active? Are their accounts overdue?"
- "Who are the directors of company 00445790?"
- "Where is this supplier's registered office, and which council area is it in?"

## Tools

All tools are read-only (`readOnlyHint: true`) and call outside services (`openWorldHint: true`).

| Tool | Input | Returns |
|---|---|---|
| `search_companies` | `query`, `limit?` (1–20) | Matching companies with number, status, type, address |
| `get_company` | `company_number` | Profile + **warnings** (overdue accounts, insolvency, not active). Text + `structuredContent` |
| `get_officers` | `company_number`, `include_resigned?`, `limit?` (1–50) | Names, roles, appointment dates. **No dates of birth or addresses** |
| `get_filing_history` | `company_number`, `category?`, `limit?` (1–25) | Recent filings in plain words |
| `lookup_postcode` | `postcode` | Local authority, region, country, ward, constituency, coordinates. Text + `structuredContent` |
| `get_company_location` | `company_number` | Registered office + area details (uses both APIs) |

Company numbers and postcodes are cleaned up for you: `"sc 123456"` → `SC123456`, `"445790"` → `00445790`, `"sw1a 1aa"` → `SW1A1AA`.

## Setup

### 1. Get a free Companies House API key

1. Register at <https://developer.company-information.service.gov.uk/>.
2. Create an application (choose the **live** environment).
3. Add a **REST** API key to it.

Postcode tools work without a key. Company tools return a clear error until the key is set.

### 2. Put the key in `.env`

```bash
cp .env.example .env
```

Then open `.env` and paste your key after `COMPANIES_HOUSE_API_KEY=`. `.env` is in `.gitignore`. **Never commit it.**

### 3. Install, build, test

| Task | Command |
|---|---|
| Install | `npm install` |
| Build | `npm run build` |
| Tests (fetch is mocked, no key or network needed) | `npm test` |
| Type check | `npm run typecheck` |
| Open MCP Inspector UI (loads `.env`) | `npm run inspect` |
| Call one tool from the terminal | `npx @modelcontextprotocol/inspector@2.15.0 --cli node --env-file-if-exists=.env build/index.js --method tools/call --tool-name lookup_postcode --tool-arg "postcode=SW1A 1AA"` |

The Inspector version is pinned, so `npx` never downloads and runs a newer release by surprise. Node 22.9 or newer is needed for `--env-file-if-exists`.

## Use it in Claude Code

This keeps the key in `.env` only (not in Claude's config). Replace `/path/to/uk-business-mcp` with the full path to this folder:

```bash
claude mcp add uk-business -- node --env-file=/path/to/uk-business-mcp/.env /path/to/uk-business-mcp/build/index.js
```

Then ask: "Look up Tesco on Companies House and tell me where their registered office is."

## Files

| File | Job |
|---|---|
| `src/index.ts` | Entry point. Connects the server to **stdio**. Warns on stderr if the key is missing. |
| `src/server.ts` | `createServer()`: registers the 6 tools and the server instructions. No transport here, so tests and a future HTTP transport reuse it. |
| `src/companiesHouse.ts` | Companies House client: Basic auth, company-number checks, 401/404/429 messages, Zod response schemas, officer paging. |
| `src/postcodes.ts` | postcodes.io client: postcode checks, Zod response schema (also `lookup_postcode`'s output schema). |
| `src/format.ts` | API codes → plain words (`ltd` → "Private limited company"), address and filing text, input clean-up. |
| `src/http.ts` | `getJson()`: fetch with a 10 s timeout, JSON read and Zod check in one place. `UserFacingError` (messages safe to show the model). |
| `test/server.test.ts` | 40 tests: a real MCP `Client` ↔ server over `InMemoryTransport`, with `fetch` mocked and made-up data. |

## Security and privacy

| Rule | How |
|---|---|
| The API key never reaches the model or logs | Read from the environment only. Error messages never include it (tested). |
| The key only goes to Companies House | postcodes.io requests have no `Authorization` header (tested). |
| Input can't change which URL we call | Company numbers must be 8 letters/digits, postcodes must match the UK format, before they go into a URL path (tested with `../search`). |
| Only the personal data the task needs (GDPR data minimisation) | Zod keeps only the fields we use. Officers' dates of birth, home addresses and nationality are dropped (tested). |
| Errors are safe | Tools return `isError: true` with a plain message. Full details go to stderr only. |

## Limits

- Companies House: 600 requests per 5 minutes per key. The server reports a clear message on HTTP 429.
- `get_officers` reads officer records 100 at a time and stops once it has enough to show, after at most 500 records (5 requests). It says so when it didn't check them all.
- A 404 for a company's officers or filing history is checked against the company profile, so "no records" and "no such company" give different answers.
- If postcodes.io fails, `get_company_location` still returns the company and its address, and says the area details are missing.
- Region is only set for postcodes in England.
