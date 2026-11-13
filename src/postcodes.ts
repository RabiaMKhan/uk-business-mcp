/**
 * Client for postcodes.io (free, no API key).
 * Docs: https://postcodes.io/docs
 *
 * Note: `region` is only set for England. Scotland, Wales and Northern Ireland return null.
 */
import { z } from "zod";
import { compact } from "./format.js";
import { UserFacingError, getJson } from "./http.js";

const BASE_URL = "https://api.postcodes.io";
const SERVICE = "postcodes.io";

// Outward code (A9, A99, AA9, AA99, A9A, AA9A) + inward code (9AA), with no space.
const POSTCODE_PATTERN = /^[A-Z]{1,2}[0-9][A-Z0-9]?[0-9][A-Z]{2}$/;

/**
 * What a postcode lookup returns. lookup_postcode also uses this as its outputSchema,
 * so the type and the schema can't drift apart.
 * `.describe()` before `.nullable()` makes the JSON Schema an `anyOf` instead of a
 * type array (["string","null"]), which more MCP clients accept.
 */
export const PostcodeInfoSchema = z.object({
  postcode: z.string(),
  country: z.string(),
  region: z.string().describe("Region (England only)").nullable(),
  localAuthority: z.string().describe("Local authority (council) area").nullable(),
  ward: z.string().describe("Electoral ward").nullable(),
  constituency: z.string().describe("Parliamentary constituency").nullable(),
  latitude: z.number().describe("Latitude").nullable(),
  longitude: z.number().describe("Longitude").nullable(),
});
export type PostcodeInfo = z.infer<typeof PostcodeInfoSchema>;

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
  const data = await getJson(url, LookupSchema, {
    service: SERVICE,
    statusMessages: { 429: "postcodes.io rate limit reached. Wait a minute and try again." },
  });
  if (data === null) return null;

  const r = data.result;
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
