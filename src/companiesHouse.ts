/**
 * Client for the Companies House Public Data API (free, needs an API key).
 * Docs: https://developer.company-information.service.gov.uk/
 *
 * Auth: HTTP Basic. The API key is the username and the password is empty.
 * Rate limit: 600 requests per 5 minutes per key.
 *
 * Security rules in this file:
 * - The key comes from the environment, never from tool input, and is never logged.
 * - The key is only sent to the Companies House host (postcodes.io never sees it).
 * - Company numbers must match a strict pattern before they go into a URL path,
 *   so input like "../" can't change which endpoint we call.
 * - We parse only the fields we need. Zod drops everything else, so personal
 *   data we don't need (officers' dates of birth, home addresses) never reaches the model.
 */
import { z } from "zod";
import { UserFacingError, fetchWithTimeout } from "./http.js";

const BASE_URL = "https://api.company-information.service.gov.uk";
const SERVICE = "Companies House";

export const API_KEY_ENV = "COMPANIES_HOUSE_API_KEY";

// ---------- Response schemas (only the fields we use) ----------

const AddressSchema = z.object({
  premises: z.string().optional(),
  address_line_1: z.string().optional(),
  address_line_2: z.string().optional(),
  locality: z.string().optional(),
  region: z.string().optional(),
  postal_code: z.string().optional(),
  country: z.string().optional(),
});
export type Address = z.infer<typeof AddressSchema>;

const SearchSchema = z.object({
  total_results: z.number().optional(),
  items: z
    .array(
      z.object({
        company_number: z.string(),
        title: z.string(),
        company_status: z.string().optional(),
        company_type: z.string().optional(),
        date_of_creation: z.string().optional(),
        address_snippet: z.string().optional(),
      }),
    )
    .optional(),
});
export type SearchResult = z.infer<typeof SearchSchema>;

const ProfileSchema = z.object({
  company_number: z.string(),
  company_name: z.string(),
  company_status: z.string().optional(),
  type: z.string().optional(),
  date_of_creation: z.string().optional(),
  date_of_cessation: z.string().optional(),
  registered_office_address: AddressSchema.optional(),
  sic_codes: z.array(z.string()).optional(),
  accounts: z
    .object({
      next_due: z.string().optional(),
      overdue: z.boolean().optional(),
      last_accounts: z.object({ made_up_to: z.string().optional() }).optional(),
    })
    .optional(),
  confirmation_statement: z
    .object({
      next_due: z.string().optional(),
      overdue: z.boolean().optional(),
    })
    .optional(),
  has_charges: z.boolean().optional(),
  has_insolvency_history: z.boolean().optional(),
});
export type CompanyProfile = z.infer<typeof ProfileSchema>;

const OfficersSchema = z.object({
  total_results: z.number().optional(),
  active_count: z.number().optional(),
  resigned_count: z.number().optional(),
  items: z
    .array(
      z.object({
        name: z.string(),
        officer_role: z.string(),
        appointed_on: z.string().optional(),
        resigned_on: z.string().optional(),
      }),
    )
    .optional(),
});
export type OfficerList = z.infer<typeof OfficersSchema>;

const FilingHistorySchema = z.object({
  total_count: z.number().optional(),
  items: z
    .array(
      z.object({
        date: z.string(),
        category: z.string().optional(),
        description: z.string().optional(),
        description_values: z.record(z.string(), z.unknown()).optional(),
      }),
    )
    .optional(),
});
export type FilingHistory = z.infer<typeof FilingHistorySchema>;

/** Filing categories the API accepts as a filter. */
export const FILING_CATEGORIES = [
  "accounts",
  "address",
  "annual-return",
  "capital",
  "change-of-name",
  "confirmation-statement",
  "incorporation",
  "liquidation",
  "miscellaneous",
  "mortgage",
  "officers",
  "persons-with-significant-control",
  "resolution",
] as const;
export type FilingCategory = (typeof FILING_CATEGORIES)[number];

// ---------- Helpers ----------

/**
 * "sc 123456" → "SC123456", "445790" → "00445790".
 * Throws a helpful error if it can't be a UK company number.
 */
export function normalizeCompanyNumber(input: string): string {
  let n = input.replace(/\s+/g, "").toUpperCase();
  if (/^\d{1,7}$/.test(n)) n = n.padStart(8, "0");
  if (!/^[A-Z0-9]{8}$/.test(n)) {
    throw new UserFacingError(
      `"${input}" is not a valid UK company number. It should have 8 characters, e.g. 00445790 or SC123456. ` +
        "Use search_companies if you only know the name.",
    );
  }
  return n;
}

function authHeader(): string {
  const key = process.env[API_KEY_ENV]?.trim();
  if (!key) {
    throw new UserFacingError(
      `The Companies House API key is not set. Add ${API_KEY_ENV} to this server's environment (see README). ` +
        "Postcode tools still work without it.",
    );
  }
  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

/** GET a Companies House path. Returns null on 404 (not found). */
async function chGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
  const authorization = authHeader(); // fails fast, before any network call, if the key is missing
  const url = new URL(path, BASE_URL);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const res = await fetchWithTimeout(url, SERVICE, {
    headers: { Authorization: authorization, Accept: "application/json" },
  });

  if (res.status === 404) return null;
  if (res.status === 401) {
    throw new UserFacingError(`Companies House rejected the API key. Check ${API_KEY_ENV} is a valid REST key.`);
  }
  if (res.status === 429) {
    throw new UserFacingError(
      "Companies House rate limit reached (600 requests per 5 minutes). Wait a few minutes and try again.",
    );
  }
  if (!res.ok) throw new UserFacingError(`Companies House returned HTTP ${res.status}. Please try again later.`);
  return res.json();
}

function notFound(companyNumber: string): UserFacingError {
  return new UserFacingError(
    `No company found with number ${companyNumber}. Use search_companies to find the right number.`,
  );
}

// ---------- Public functions ----------

export async function searchCompanies(query: string, limit: number): Promise<SearchResult> {
  const raw = await chGet("/search/companies", { q: query, items_per_page: String(limit) });
  return SearchSchema.parse(raw ?? {});
}

export async function getCompany(companyNumber: string): Promise<CompanyProfile> {
  const n = normalizeCompanyNumber(companyNumber);
  const raw = await chGet(`/company/${n}`);
  if (raw === null) throw notFound(n);
  return ProfileSchema.parse(raw);
}

/** Fetches up to 100 officer records (the API maximum for one page). */
export async function getOfficers(companyNumber: string): Promise<OfficerList> {
  const n = normalizeCompanyNumber(companyNumber);
  const raw = await chGet(`/company/${n}/officers`, { items_per_page: "100" });
  if (raw === null) throw notFound(n);
  return OfficersSchema.parse(raw);
}

export async function getFilingHistory(
  companyNumber: string,
  options: { limit: number; category?: FilingCategory },
): Promise<FilingHistory> {
  const n = normalizeCompanyNumber(companyNumber);
  const params: Record<string, string> = { items_per_page: String(options.limit) };
  if (options.category) params.category = options.category;
  const raw = await chGet(`/company/${n}/filing-history`, params);
  if (raw === null) throw notFound(n);
  return FilingHistorySchema.parse(raw);
}
