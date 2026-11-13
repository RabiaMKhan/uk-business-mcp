/**
 * Client for postcodes.io (free, no API key).
 * Docs: https://postcodes.io/docs
 *
 * Note: `region` is only set for England. Scotland, Wales and Northern Ireland return null.
 */
import { z } from "zod";
import { UserFacingError, fetchWithTimeout } from "./http.js";

const BASE_URL = "https://api.postcodes.io";
const SERVICE = "postcodes.io";

// Outward code (A9, A99, AA9, AA99, A9A, AA9A) + inward code (9AA), with no space.
const POSTCODE_PATTERN = /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/;

export interface PostcodeInfo {
  postcode: string;
  country: string;
  region: string | null;
  localAuthority: string | null;
  ward: string | null;
  constituency: string | null;
  latitude: number | null;
  longitude: number | null;
}

const LookupSchema = z.object({
  result: z.object({
    postcode: z.string(),
    country: z.string(),
    region: z.string().nullish(),
    admin_district: z.string().nullish(),
    admin_ward: z.string().nullish(),
    parliamentary_constituency: z.string().nullish(),
    latitude: z.number().nullish(),
    longitude: z.number().nullish(),
  }),
});

function compact(input: string): string {
  return input.replace(/\s+/g, "").toUpperCase();
}

export function isUkPostcode(input: string): boolean {
  return POSTCODE_PATTERN.test(compact(input));
}

/** Returns details for a postcode, or null if postcodes.io doesn't know it. */
export async function lookupPostcode(input: string): Promise<PostcodeInfo | null> {
  const postcode = compact(input);
  if (!POSTCODE_PATTERN.test(postcode)) {
    throw new UserFacingError(`"${input}" is not a valid UK postcode. Use a full postcode, e.g. "SW1A 1AA".`);
  }

  const url = new URL(`/postcodes/${encodeURIComponent(postcode)}`, BASE_URL);
  const res = await fetchWithTimeout(url, SERVICE, { headers: { Accept: "application/json" } });

  if (res.status === 404) return null;
  if (res.status === 429) throw new UserFacingError("postcodes.io rate limit reached. Wait a minute and try again.");
  if (!res.ok) throw new UserFacingError(`postcodes.io returned HTTP ${res.status}. Please try again later.`);

  const { result: r } = LookupSchema.parse(await res.json());
  return {
    postcode: r.postcode,
    country: r.country,
    region: r.region ?? null,
    localAuthority: r.admin_district ?? null,
    ward: r.admin_ward ?? null,
    constituency: r.parliamentary_constituency ?? null,
    latitude: r.latitude ?? null,
    longitude: r.longitude ?? null,
  };
}
