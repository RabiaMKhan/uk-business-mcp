/**
 * Turns API codes into plain words for the model and the user.
 */
import type { Address } from "./companiesHouse.js";
import type { PostcodeInfo } from "./postcodes.js";

/** "confirmation-statement" → "Confirmation statement" */
export function readable(code: string | undefined): string {
  if (!code) return "Unknown";
  const words = code.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const COMPANY_TYPES: Record<string, string> = {
  ltd: "Private limited company",
  plc: "Public limited company",
  llp: "Limited liability partnership",
  "private-limited-guarant-nsc": "Private company limited by guarantee",
  "private-unlimited": "Private unlimited company",
  "limited-partnership": "Limited partnership",
  "oversea-company": "Overseas company",
  "uk-establishment": "UK establishment of an overseas company",
};

export function companyType(code: string | undefined): string {
  return code ? (COMPANY_TYPES[code] ?? readable(code)) : "Unknown";
}

export function formatAddress(a: Address): string {
  return [a.premises, a.address_line_1, a.address_line_2, a.locality, a.region, a.postal_code, a.country]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(", ");
}

/** Lines describing where a postcode is. Skips empty fields. */
export function postcodeLines(p: PostcodeInfo): string[] {
  const area = [p.localAuthority, p.region, p.country].filter(Boolean).join(", ");
  const lines = [`Area: ${area}`];
  if (p.ward) lines.push(`Ward: ${p.ward}`);
  if (p.constituency) lines.push(`Constituency: ${p.constituency}`);
  if (p.latitude !== null && p.longitude !== null) lines.push(`Coordinates: ${p.latitude}, ${p.longitude}`);
  return lines;
}

/** Filing description codes → words, e.g. "accounts-with-accounts-type-full" → "Accounts with accounts type full". */
export function describeFiling(description: string | undefined, values: Record<string, unknown> | undefined): string {
  const legacyText = typeof values?.description === "string" ? values.description : undefined;
  const text = !description || description === "legacy" ? (legacyText ?? "No description") : readable(description);
  const madeUpTo = typeof values?.made_up_date === "string" ? ` (made up to ${values.made_up_date})` : "";
  return text + madeUpTo;
}
