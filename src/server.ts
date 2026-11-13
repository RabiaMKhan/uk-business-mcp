/**
 * Builds the MCP server and registers its tools.
 *
 * Kept separate from index.ts (the transport) so tests can connect to the same
 * server in memory, and an HTTP transport can be added later without touching the tools.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  FILING_CATEGORIES,
  getCompany,
  getFilingHistory,
  getOfficers,
  searchCompanies,
  type CompanyProfile,
} from "./companiesHouse.js";
import { companyType, describeFiling, formatAddress, postcodeLines, readable } from "./format.js";
import { UserFacingError } from "./http.js";
import { PostcodeInfoSchema, isUkPostcode, lookupPostcode, type PostcodeInfo } from "./postcodes.js";

export const SERVER_NAME = "uk-business-mcp";
export const SERVER_VERSION = "0.1.0";

// Sent to the client once at startup. Tells the model how the tools fit together.
const INSTRUCTIONS =
  "Look up UK companies (Companies House) and UK postcodes (postcodes.io). " +
  "If you only have a company name, call search_companies first to get its company number. " +
  "Use get_company for a due-diligence summary, including overdue accounts and insolvency history. " +
  "Company data comes from the public register; officer dates of birth and home addresses are never returned.";

// Reused input fields. `.describe()` text is sent to the model, so write it for the model.
const companyNumberField = z
  .string()
  .trim()
  .min(1)
  .max(12)
  .regex(/^[A-Za-z0-9 ]+$/, "Letters, numbers and spaces only")
  .describe('UK company number, e.g. "00445790" or "SC123456". Leading zeros can be left out.');

const postcodeField = z
  .string()
  .trim()
  .min(5)
  .max(10)
  .regex(/^[A-Za-z0-9 ]+$/, "Letters, numbers and spaces only")
  .describe('Full UK postcode, e.g. "SW1A 1AA". Spaces and upper/lower case do not matter.');

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * Turns any error into a tool result with `isError: true`.
 * The model can read this and react (fix the input, retry, tell the user).
 * Real details go to stderr only; the model gets a safe message.
 */
function toolError(err: unknown): CallToolResult {
  console.error(`[${SERVER_NAME}] tool error:`, err);
  const message =
    err instanceof UserFacingError ? err.message : "Unexpected error while looking up business data. Please try again.";
  return { isError: true, content: [{ type: "text", text: message }] };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

// `.describe()` before `.nullable()` makes the JSON Schema an `anyOf` instead of a
// type array (["string","null"]), which more MCP clients accept.
const nullableText = (description: string) => z.string().describe(description).nullable();

/** get_company's structured output. Used as its outputSchema and as companySummary's return type. */
const CompanySummarySchema = z.object({
  companyNumber: z.string(),
  name: z.string(),
  status: z.string(),
  type: z.string(),
  incorporatedOn: nullableText("Incorporation date (YYYY-MM-DD)"),
  dissolvedOn: nullableText("Dissolution date (YYYY-MM-DD), if dissolved"),
  registeredOffice: nullableText("Registered office address"),
  postcode: nullableText("Registered office postcode"),
  sicCodes: z.array(z.string()),
  accountsNextDue: nullableText("Date the next accounts are due"),
  accountsOverdue: z.boolean(),
  lastAccountsMadeUpTo: nullableText("Date the last accounts were made up to"),
  confirmationStatementNextDue: nullableText("Date the next confirmation statement is due"),
  confirmationStatementOverdue: z.boolean(),
  hasCharges: z.boolean(),
  hasInsolvencyHistory: z.boolean(),
  warnings: z.array(z.string()),
});
type CompanySummary = z.infer<typeof CompanySummarySchema>;

// Statuses that mean the company is live. Overseas companies use "open", and
// registered overseas entities use "registered", instead of "active".
const LIVE_STATUSES = new Set(["active", "open", "registered"]);

function companySummary(c: CompanyProfile): CompanySummary {
  const status = readable(c.company_status);
  const warnings: string[] = [];
  if (c.company_status && !LIVE_STATUSES.has(c.company_status)) {
    warnings.push(`Company status is "${status}", not active.`);
  }
  if (c.accounts?.overdue) warnings.push(`Accounts are overdue (were due ${c.accounts.next_due ?? "on an unknown date"}).`);
  if (c.confirmation_statement?.overdue) {
    warnings.push(
      `Confirmation statement is overdue (was due ${c.confirmation_statement.next_due ?? "on an unknown date"}).`,
    );
  }
  if (c.has_insolvency_history) warnings.push("Company has insolvency history.");

  const office = c.registered_office_address;
  return {
    companyNumber: c.company_number,
    name: c.company_name,
    status,
    type: companyType(c.type),
    incorporatedOn: c.date_of_creation ?? null,
    dissolvedOn: c.date_of_cessation ?? null,
    registeredOffice: office ? formatAddress(office) || null : null,
    postcode: office?.postal_code ?? null,
    sicCodes: c.sic_codes ?? [],
    accountsNextDue: c.accounts?.next_due ?? null,
    accountsOverdue: c.accounts?.overdue ?? false,
    lastAccountsMadeUpTo: c.accounts?.last_accounts?.made_up_to ?? null,
    confirmationStatementNextDue: c.confirmation_statement?.next_due ?? null,
    confirmationStatementOverdue: c.confirmation_statement?.overdue ?? false,
    hasCharges: c.has_charges ?? false,
    hasInsolvencyHistory: c.has_insolvency_history ?? false,
    warnings,
  };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });

  // ---------- Tool 1: search_companies ----------
  server.registerTool(
    "search_companies",
    {
      title: "Search UK companies",
      description:
        "Search the Companies House register by company name. Returns company numbers, status, type and address. " +
        "Use this first when you only know a company's name.",
      inputSchema: {
        query: z.string().trim().min(2).max(160).describe('Company name or part of it, e.g. "Tesco" or "Acme Trading".'),
        limit: z.number().int().min(1).max(20).default(5).describe("Max results, 1–20. Default 5."),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      try {
        const { items = [], total_results } = await searchCompanies(query, limit);
        if (items.length === 0) return textResult(`No companies found for "${query}".`);

        const header =
          total_results !== undefined
            ? `Found ${total_results.toLocaleString("en-GB")} companies for "${query}" (showing ${items.length}):`
            : `Companies matching "${query}":`;
        const lines = items.map((c, i) => {
          const facts = [readable(c.company_status), companyType(c.company_type)];
          if (c.date_of_creation) facts.push(`incorporated ${c.date_of_creation}`);
          const address = c.address_snippet ? `\n   ${c.address_snippet}` : "";
          return `${i + 1}. ${c.title} (${c.company_number}) — ${facts.join(", ")}${address}`;
        });
        return textResult([header, ...lines].join("\n"));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------- Tool 2: get_company (with structured output) ----------
  server.registerTool(
    "get_company",
    {
      title: "Get company profile",
      description:
        "Get a UK company's profile from Companies House: status, type, incorporation date, registered office, " +
        "SIC codes, accounts and confirmation statement due dates, and warnings such as overdue accounts or " +
        "insolvency history. Good for supplier or customer due diligence.",
      inputSchema: { company_number: companyNumberField },
      outputSchema: CompanySummarySchema.shape,
      annotations: READ_ONLY,
    },
    async ({ company_number }) => {
      try {
        const s = companySummary(await getCompany(company_number));
        const lines = [
          `${s.name} (${s.companyNumber})`,
          `Status: ${s.status} · Type: ${s.type}`,
          `Incorporated: ${s.incorporatedOn ?? "unknown"}${s.dissolvedOn ? ` · Dissolved: ${s.dissolvedOn}` : ""}`,
          `Registered office: ${s.registeredOffice ?? "not on record"}`,
          `SIC codes: ${s.sicCodes.length ? s.sicCodes.join(", ") : "none listed"}`,
          `Accounts: next due ${s.accountsNextDue ?? "n/a"}, last made up to ${s.lastAccountsMadeUpTo ?? "n/a"}`,
          `Confirmation statement: next due ${s.confirmationStatementNextDue ?? "n/a"}`,
          `Charges: ${s.hasCharges ? "yes" : "no"} · Insolvency history: ${s.hasInsolvencyHistory ? "yes" : "no"}`,
        ];
        lines.push(s.warnings.length ? `Warnings:\n${s.warnings.map((w) => `- ${w}`).join("\n")}` : "Warnings: none");
        return { content: [{ type: "text", text: lines.join("\n") }], structuredContent: s };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------- Tool 3: get_officers ----------
  server.registerTool(
    "get_officers",
    {
      title: "Get company officers",
      description:
        "List a UK company's officers (directors, secretaries, LLP members) with role and appointment dates. " +
        "Active officers only by default. Dates of birth and addresses are not returned.",
      inputSchema: {
        company_number: companyNumberField,
        include_resigned: z.boolean().default(false).describe("Also list officers who have resigned. Default false."),
        limit: z.number().int().min(1).max(50).default(20).describe("Max officers to list, 1–50. Default 20."),
      },
      annotations: READ_ONLY,
    },
    async ({ company_number, include_resigned, limit }) => {
      try {
        const { companyNumber: n, officers } = await getOfficers(company_number, {
          includeResigned: include_resigned,
          limit,
        });
        if (!officers) return textResult(`Companies House has no officer records for company ${n}.`);

        const { items = [], active_count, resigned_count, total_results } = officers;
        const active = active_count ?? items.filter((o) => !o.resigned_on).length;
        const resigned = resigned_count ?? items.filter((o) => o.resigned_on).length;
        const matching = include_resigned ? items : items.filter((o) => !o.resigned_on);

        const out = [`Company ${n}: ${active} active and ${resigned} resigned officers.`];
        if (matching.length === 0) {
          out.push(`No ${include_resigned ? "" : "active "}officers to show.`);
        } else {
          matching.slice(0, limit).forEach((o, i) => {
            const resignedText = o.resigned_on ? `, resigned ${o.resigned_on}` : "";
            out.push(
              `${i + 1}. ${o.name} — ${readable(o.officer_role)}, appointed ${o.appointed_on ?? "date unknown"}${resignedText}`,
            );
          });
          if (matching.length > limit) out.push(`...and ${matching.length - limit} more.`);
        }
        if (total_results !== undefined && total_results > items.length) {
          out.push(`(Only the first ${items.length} of ${total_results} officer records were checked.)`);
        }
        return textResult(out.join("\n"));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------- Tool 4: get_filing_history ----------
  server.registerTool(
    "get_filing_history",
    {
      title: "Get filing history",
      description:
        "List a UK company's recent Companies House filings (accounts, confirmation statements, officer changes, etc.), " +
        "newest first. Optionally filter by category.",
      inputSchema: {
        company_number: companyNumberField,
        category: z.enum(FILING_CATEGORIES).optional().describe("Optional filing category to filter by."),
        limit: z.number().int().min(1).max(25).default(10).describe("Max filings to list, 1–25. Default 10."),
      },
      annotations: READ_ONLY,
    },
    async ({ company_number, category, limit }) => {
      try {
        const { companyNumber: n, filings } = await getFilingHistory(company_number, { limit, category });
        if (!filings) return textResult(`Companies House has no filing history for company ${n}.`);

        const { items = [], total_count } = filings;
        const filter = category ? ` (${readable(category)})` : "";
        if (items.length === 0) return textResult(`No filings found for company ${n}${filter}.`);

        const count = total_count !== undefined ? `showing ${items.length} of ${total_count}` : `${items.length} filings`;
        const lines = items.map(
          (f) => `${f.date} · ${readable(f.category)} · ${describeFiling(f.description, f.description_values)}`,
        );
        return textResult([`Filing history for ${n}${filter}, ${count}:`, ...lines].join("\n"));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------- Tool 5: lookup_postcode (with structured output) ----------
  server.registerTool(
    "lookup_postcode",
    {
      title: "Look up UK postcode",
      description:
        "Get the area for a UK postcode: local authority, region, country, ward, parliamentary constituency and coordinates. " +
        "Region is only set for England.",
      inputSchema: { postcode: postcodeField },
      outputSchema: PostcodeInfoSchema.shape,
      annotations: READ_ONLY,
    },
    async ({ postcode }) => {
      try {
        const info = await lookupPostcode(postcode);
        if (!info) {
          throw new UserFacingError(
            `Postcode "${postcode.toUpperCase()}" was not found. Check it is a current, full UK postcode.`,
          );
        }
        const text = [info.postcode, ...postcodeLines(info)].join("\n");
        return { content: [{ type: "text", text }], structuredContent: { ...info } };
      } catch (err) {
        return toolError(err);
      }
    },
  );

  // ---------- Tool 6: get_company_location (combines both APIs) ----------
  server.registerTool(
    "get_company_location",
    {
      title: "Get company location",
      description:
        "Find where a UK company's registered office is: the address plus local authority, region, country and " +
        "coordinates for its postcode. Combines Companies House and postcodes.io.",
      inputSchema: { company_number: companyNumberField },
      annotations: READ_ONLY,
    },
    async ({ company_number }) => {
      try {
        const c = await getCompany(company_number);
        const office = c.registered_office_address;
        const address = (office && formatAddress(office)) || "not on record";
        const header = `${c.company_name} (${c.company_number})\nRegistered office: ${address}`;

        const postcode = office?.postal_code;
        if (!postcode || !isUkPostcode(postcode)) {
          return textResult(`${header}\nNo UK postcode on record, so no area details are available.`);
        }
        let info: PostcodeInfo | null;
        try {
          info = await lookupPostcode(postcode);
        } catch (err) {
          // Keep the company and address we already have. Only the area details are missing.
          console.error(`[${SERVER_NAME}] postcode lookup failed:`, err);
          const reason = err instanceof UserFacingError ? err.message : "The postcode lookup failed.";
          return textResult(`${header}\nArea details are not available right now: ${reason}`);
        }
        if (!info) {
          return textResult(`${header}\nPostcode ${postcode} was not found on postcodes.io (it may be new or retired).`);
        }
        return textResult([header, ...postcodeLines(info)].join("\n"));
      } catch (err) {
        return toolError(err);
      }
    },
  );

  return server;
}
