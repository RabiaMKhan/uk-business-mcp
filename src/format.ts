/**
 * Turns API codes into plain words for the model and the user.
 */
import type { Address } from "./companiesHouse.js";
import type { PostcodeInfo } from "./postcodes.js";

/** Removes all spaces and makes it upper case: " sw1a 1aa " → "SW1A1AA". */
export function compact(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

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

// The filing `description_values` we show, with their labels. Other values are left out
// (data minimisation: only what helps explain the filing).
const FILING_VALUE_LABELS: Record<string, string> = {
  made_up_date: "made up to ",
  officer_name: "officer: ",
  appointment_date: "appointed: ",
  termination_date: "terminated: ",
  change_date: "changed: ",
  old_address: "old address: ",
  new_address: "new address: ",
  charge_number: "charge: ",
  charge_creation_date: "charge created: ",
  new_date: "new date: ",
};

/**
 * Filing description code → words, plus the values that fill it in. For example
 * "appoint-person-director-company-with-name-date" + { officer_name, appointment_date }
 * → "Appoint person director company with name date (officer: Jane Smith, appointed: 2024-01-01)".
 */
export function describeFiling(description: string | undefined, values: Record<string, unknown> | undefined): string {
  const legacyText = typeof values?.description === "string" ? values.description : undefined;
  const text = !description || description === "legacy" ? (legacyText ?? "No description") : readable(description);

  const details: string[] = [];
  for (const [key, label] of Object.entries(FILING_VALUE_LABELS)) {
    const value = values?.[key];
    if (typeof value === "string" && value.trim()) details.push(`${label}${value.trim()}`);
  }
  return details.length ? `${text} (${details.join(", ")})` : text;
}
