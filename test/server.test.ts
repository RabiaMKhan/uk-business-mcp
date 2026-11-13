/**
 * Tests the server the way a real MCP client uses it:
 * a Client connects through an in-memory transport, lists tools and calls them.
 * `fetch` is mocked, so tests are fast, need no API key and don't depend on the real APIs.
 * All company and officer data below is made up.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, mock, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { API_KEY_ENV } from "../src/companiesHouse.js";
import { createServer } from "../src/server.js";

const CH_HOST = "api.company-information.service.gov.uk";
const PC_HOST = "api.postcodes.io";
const TEST_KEY = "test-key-123";
const EXPECTED_AUTH = `Basic ${Buffer.from(`${TEST_KEY}:`).toString("base64")}`;

// ---------- Fake API responses ----------

const COMPANY = {
  company_number: "12345678",
  company_name: "EXAMPLE TRADING LTD",
  company_status: "active",
  type: "ltd",
  date_of_creation: "2015-06-01",
  registered_office_address: {
    address_line_1: "1 Example Street",
    locality: "London",
    postal_code: "SW1A 1AA",
    country: "England",
  },
  sic_codes: ["62012"],
  accounts: { next_due: "2026-03-31", overdue: true, last_accounts: { made_up_to: "2024-06-30" } },
  confirmation_statement: { next_due: "2027-06-15", overdue: false },
  has_charges: false,
  has_insolvency_history: false,
  links: { self: "/company/12345678" }, // extra field: should be ignored
};

const OVERSEAS = {
  company_number: "FC012345",
  company_name: "OVERSEAS EXAMPLE INC",
  company_status: "open", // the normal live status for overseas companies
  type: "oversea-company",
  registered_office_address: { address_line_1: "100 Main Street", locality: "New York", country: "United States" },
};

const SEARCH = {
  total_results: 1234,
  items: [
    {
      company_number: "12345678",
      title: "EXAMPLE TRADING LTD",
      company_status: "active",
      company_type: "ltd",
      date_of_creation: "2015-06-01",
      address_snippet: "1 Example Street, London, SW1A 1AA",
    },
    { company_number: "SC654321", title: "EXAMPLE TRADING (SCOTLAND) LTD", company_status: "dissolved", company_type: "ltd" },
  ],
};

const OFFICERS = {
  total_results: 3,
  active_count: 2,
  resigned_count: 1,
  items: [
    {
      name: "SMITH, Jane",
      officer_role: "director",
      appointed_on: "2015-06-01",
      date_of_birth: { month: 3, year: 1980 },
      address: { address_line_1: "22 Private Road", locality: "Leeds" },
      nationality: "British",
    },
    {
      name: "KHAN, Ali",
      officer_role: "secretary",
      appointed_on: "2018-01-15",
      date_of_birth: { month: 7, year: 1975 },
      address: { address_line_1: "9 Hidden Lane", locality: "Leeds" },
    },
    { name: "BROWN, Sam", officer_role: "director", appointed_on: "2015-06-01", resigned_on: "2020-12-31" },
  ],
};

const FILINGS = {
  total_count: 25,
  items: [
    {
      date: "2025-03-20",
      category: "accounts",
      description: "accounts-with-accounts-type-micro-entity",
      description_values: { made_up_date: "2024-06-30" },
    },
    {
      date: "2024-06-20",
      category: "confirmation-statement",
      description: "confirmation-statement-with-no-updates",
      description_values: { made_up_date: "2024-06-01" },
    },
    {
      date: "2024-02-01",
      category: "officers",
      description: "appoint-person-director-company-with-name-date",
      description_values: { officer_name: "Jane Smith", appointment_date: "2024-01-01", other_value: "not shown" },
    },
    { date: "2010-01-01", category: "miscellaneous", description: "legacy", description_values: { description: "Old paper filing" } },
  ],
};

const POSTCODE = {
  status: 200,
  result: {
    postcode: "SW1A 1AA",
    country: "England",
    region: "London",
    admin_district: "Westminster",
    admin_ward: "St James's",
    parliamentary_constituency: "Cities of London and Westminster",
    latitude: 51.50101,
    longitude: -0.141563,
    eastings: 529090, // extra field: should be ignored
  },
};

// ---------- Fake fetch ----------

interface SeenRequest {
  url: URL;
  headers: Headers;
}
type FakeRoute = (url: URL) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const defaultRoute: FakeRoute = (url) => {
  if (url.hostname === CH_HOST) {
    switch (url.pathname) {
      case "/search/companies":
        return url.searchParams.get("q") === "example" ? json(SEARCH) : json({ total_results: 0, items: [] });
      case "/company/12345678":
        return json(COMPANY);
      case "/company/FC012345":
        return json(OVERSEAS);
      case "/company/12345678/officers":
        return json(OFFICERS);
      case "/company/12345678/filing-history":
        return json(FILINGS);
      default:
        return json({ errors: [{ error: "company-profile-not-found" }] }, 404);
    }
  }
  if (url.hostname === PC_HOST) {
    return url.pathname === "/postcodes/SW1A1AA" ? json(POSTCODE) : json({ status: 404, error: "Postcode not found" }, 404);
  }
  return json({ error: "unexpected host" }, 500);
};

let route: FakeRoute = defaultRoute;
let requests: SeenRequest[] = [];
let client: Client;
const originalKey = process.env[API_KEY_ENV];

function text(result: unknown): string {
  const r = result as CallToolResult;
  return r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

function call(name: string, args: Record<string, unknown>) {
  return client.callTool({ name, arguments: args });
}

beforeEach(async () => {
  route = defaultRoute;
  requests = [];
  process.env[API_KEY_ENV] = TEST_KEY;
  mock.method(console, "error", () => {}); // keep expected error logs out of test output
  mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requests.push({ url, headers: new Headers(init?.headers) });
    return route(url);
  });

  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterEach(async () => {
  await client.close();
  mock.restoreAll();
  if (originalKey === undefined) delete process.env[API_KEY_ENV];
  else process.env[API_KEY_ENV] = originalKey;
});

// ---------- Tests ----------

describe("tools/list", () => {
  test("exposes the 6 tools, all read-only with descriptions", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "get_company",
      "get_company_location",
      "get_filing_history",
      "get_officers",
      "lookup_postcode",
      "search_companies",
    ]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true, `${tool.name} should be read-only`);
      assert.ok(tool.description, `${tool.name} needs a description`);
    }
  });

  test("sends usage instructions to the client", () => {
    assert.match(client.getInstructions() ?? "", /search_companies first/);
  });

  test("output schemas use anyOf, not type arrays, for nullable fields (portable to more clients)", async () => {
    const { tools } = await client.listTools();
    const withOutput = tools.filter((t) => t.outputSchema);
    assert.equal(withOutput.length, 2);
    for (const tool of withOutput) {
      const schema = JSON.stringify(tool.outputSchema);
      assert.doesNotMatch(schema, /"type":\[/, `${tool.name} outputSchema has a type array`);
      assert.match(schema, /"anyOf"/);
    }
  });
});

describe("search_companies", () => {
  test("lists matches with number, status, type and address", async () => {
    const result = await call("search_companies", { query: "example", limit: 2 });
    assert.equal(result.isError, undefined);
    const out = text(result);
    assert.match(out, /Found 1,234 companies for "example" \(showing 2\)/);
    assert.match(out, /1\. EXAMPLE TRADING LTD \(12345678\) — Active, Private limited company, incorporated 2015-06-01/);
    assert.match(out, /1 Example Street, London, SW1A 1AA/);
    assert.match(out, /2\. EXAMPLE TRADING \(SCOTLAND\) LTD \(SC654321\) — Dissolved/);
  });

  test("sends the API key as Basic auth, and the query and limit as params", async () => {
    await call("search_companies", { query: "example", limit: 2 });
    const [req] = requests;
    assert.ok(req);
    assert.equal(req.url.hostname, CH_HOST);
    assert.equal(req.headers.get("authorization"), EXPECTED_AUTH);
    assert.equal(req.url.searchParams.get("q"), "example");
    assert.equal(req.url.searchParams.get("items_per_page"), "2");
  });

  test("no matches is a normal (non-error) result", async () => {
    const result = await call("search_companies", { query: "nothing like this" });
    assert.equal(result.isError, undefined);
    assert.match(text(result), /No companies found/);
  });
});

describe("get_company", () => {
  test("returns text and structured content, with an overdue-accounts warning", async () => {
    const result = await call("get_company", { company_number: "12345678" });
    assert.equal(result.isError, undefined);
    assert.match(text(result), /EXAMPLE TRADING LTD \(12345678\)/);
    assert.match(text(result), /- Accounts are overdue \(were due 2026-03-31\)\./);
    assert.deepEqual(result.structuredContent, {
      companyNumber: "12345678",
      name: "EXAMPLE TRADING LTD",
      status: "Active",
      type: "Private limited company",
      incorporatedOn: "2015-06-01",
      dissolvedOn: null,
      registeredOffice: "1 Example Street, London, SW1A 1AA, England",
      postcode: "SW1A 1AA",
      sicCodes: ["62012"],
      accountsNextDue: "2026-03-31",
      accountsOverdue: true,
      lastAccountsMadeUpTo: "2024-06-30",
      confirmationStatementNextDue: "2027-06-15",
      confirmationStatementOverdue: false,
      hasCharges: false,
      hasInsolvencyHistory: false,
      warnings: ["Accounts are overdue (were due 2026-03-31)."],
    });
  });

  test("normalises the company number (spaces, case, missing leading zeros)", async () => {
    await call("get_company", { company_number: " 1234 5678 " });
    await call("get_company", { company_number: "sc 654321" });
    await call("get_company", { company_number: "445790" });
    assert.deepEqual(
      requests.map((r) => r.url.pathname),
      ["/company/12345678", "/company/SC654321", "/company/00445790"],
    );
  });

  test("unknown company number gives a helpful isError result", async () => {
    const result = await call("get_company", { company_number: "99999999" });
    assert.equal(result.isError, true);
    assert.match(text(result), /No company found with number 99999999/);
  });

  test("invalid company number is rejected before any network call", async () => {
    const result = await call("get_company", { company_number: "ABC" });
    assert.equal(result.isError, true);
    assert.match(text(result), /not a valid UK company number/);
    assert.equal(requests.length, 0);
  });

  test("'open' (overseas companies) counts as live: no 'not active' warning", async () => {
    const result = await call("get_company", { company_number: "FC012345" });
    assert.equal(result.isError, undefined);
    assert.deepEqual((result.structuredContent as { warnings: string[] }).warnings, []);
  });

  test("a company in liquidation gets a 'not active' warning", async () => {
    route = (url) =>
      url.pathname === "/company/12345678" ? json({ ...COMPANY, company_status: "liquidation" }) : defaultRoute(url);
    const result = await call("get_company", { company_number: "12345678" });
    assert.match(text(result), /Company status is "Liquidation", not active\./);
  });

  test("path tricks are rejected by input validation", async () => {
    const outcome = await call("get_company", { company_number: "../search" })
      .then((r) => r.isError === true)
      .catch(() => true);
    assert.equal(outcome, true);
    assert.equal(requests.length, 0);
  });
});

describe("API key and error handling", () => {
  test("missing key gives a clear isError result and makes no request", async () => {
    delete process.env[API_KEY_ENV];
    const result = await call("get_company", { company_number: "12345678" });
    assert.equal(result.isError, true);
    assert.match(text(result), /COMPANIES_HOUSE_API_KEY/);
    assert.equal(requests.length, 0);
  });

  test("rejected key (401) gives a safe message that does not contain the key", async () => {
    route = () => json({ error: "Invalid Authorization" }, 401);
    const result = await call("get_company", { company_number: "12345678" });
    assert.equal(result.isError, true);
    assert.match(text(result), /rejected the API key/);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(TEST_KEY));
  });

  test("rate limit (429) tells the model to wait", async () => {
    route = () => json({}, 429);
    const result = await call("search_companies", { query: "example" });
    assert.equal(result.isError, true);
    assert.match(text(result), /rate limit/);
  });

  test("network failure gives isError, not a crash", async () => {
    route = () => {
      throw new TypeError("fetch failed");
    };
    const result = await call("get_company", { company_number: "12345678" });
    assert.equal(result.isError, true);
    assert.match(text(result), /Companies House could not be reached/);
  });

  test("unexpected API shape gives a safe message (no internals leaked)", async () => {
    route = () => json({ company_name: 42 });
    const result = await call("get_company", { company_number: "12345678" });
    assert.equal(result.isError, true);
    assert.match(text(result), /Companies House sent data in an unexpected format/);
    assert.doesNotMatch(text(result), /company_name|invalid_type/);
  });

  test("timeout gives a 'timed out' message", async () => {
    route = () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    const result = await call("get_company", { company_number: "12345678" });
    assert.equal(result.isError, true);
    assert.match(text(result), /Companies House timed out\. Please try again\./);
  });

  test("timeout while reading the response body also says 'timed out'", async () => {
    route = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
          },
        }),
        { status: 200 },
      );
    const result = await call("get_company", { company_number: "12345678" });
    assert.equal(result.isError, true);
    assert.match(text(result), /Companies House timed out/);
  });

  test("a body that is not JSON gives a safe message", async () => {
    route = () => new Response("<html>Service unavailable</html>", { status: 200 });
    const result = await call("get_company", { company_number: "12345678" });
    assert.equal(result.isError, true);
    assert.match(text(result), /Companies House sent a response that could not be read/);
  });
});

describe("get_officers", () => {
  test("lists active officers only by default", async () => {
    const out = text(await call("get_officers", { company_number: "12345678" }));
    assert.match(out, /Company 12345678: 2 active and 1 resigned officers\./);
    assert.match(out, /1\. SMITH, Jane — Director, appointed 2015-06-01/);
    assert.match(out, /2\. KHAN, Ali — Secretary, appointed 2018-01-15/);
    assert.doesNotMatch(out, /BROWN/);
  });

  test("include_resigned also lists resigned officers", async () => {
    const out = text(await call("get_officers", { company_number: "12345678", include_resigned: true }));
    assert.match(out, /3\. BROWN, Sam — Director, appointed 2015-06-01, resigned 2020-12-31/);
  });

  test("never returns dates of birth, home addresses or nationality (privacy)", async () => {
    const result = await call("get_officers", { company_number: "12345678", include_resigned: true });
    const all = JSON.stringify(result);
    for (const personal of ["1980", "1975", "Private Road", "Hidden Lane", "British", "date_of_birth"]) {
      assert.ok(!all.includes(personal), `output should not contain "${personal}"`);
    }
  });

  test("reads the next page when the first 100 records have too few active officers", async () => {
    const pastDirectors = Array.from({ length: 100 }, (_, i) => ({
      name: `PAST, Person ${i}`,
      officer_role: "director",
      appointed_on: "2000-01-01",
      resigned_on: "2001-01-01",
    }));
    route = (url) => {
      if (url.pathname !== "/company/12345678/officers") return defaultRoute(url);
      const items =
        url.searchParams.get("start_index") === "0"
          ? pastDirectors
          : [{ name: "CURRENT, Director", officer_role: "director", appointed_on: "2020-01-01" }];
      return json({ total_results: 101, active_count: 1, resigned_count: 100, items });
    };
    const out = text(await call("get_officers", { company_number: "12345678" }));
    assert.match(out, /Company 12345678: 1 active and 100 resigned officers\./);
    assert.match(out, /1\. CURRENT, Director — Director, appointed 2020-01-01/);
    assert.deepEqual(
      requests.map((r) => r.url.searchParams.get("start_index")),
      ["0", "100"],
    );
  });

  test("stops after 5 pages (500 records) and says not all were checked", async () => {
    route = (url) => {
      const start = Number(url.searchParams.get("start_index"));
      const items = Array.from({ length: 100 }, (_, i) => ({
        name: `PAST, Person ${start + i}`,
        officer_role: "director",
        resigned_on: "2001-01-01",
      }));
      return json({ total_results: 1000, active_count: 0, resigned_count: 1000, items });
    };
    const out = text(await call("get_officers", { company_number: "12345678" }));
    assert.equal(requests.length, 5);
    assert.match(out, /Only the first 500 of 1000 officer records were checked/);
  });

  test("no officer list for a company that exists is a normal result, not 'not found'", async () => {
    route = (url) => (url.pathname === "/company/12345678/officers" ? json({}, 404) : defaultRoute(url));
    const result = await call("get_officers", { company_number: "12345678" });
    assert.equal(result.isError, undefined);
    assert.match(text(result), /Companies House has no officer records for company 12345678/);
  });

  test("unknown company number still gives 'No company found'", async () => {
    const result = await call("get_officers", { company_number: "99999999" });
    assert.equal(result.isError, true);
    assert.match(text(result), /No company found with number 99999999/);
    assert.deepEqual(
      requests.map((r) => r.url.pathname),
      ["/company/99999999/officers", "/company/99999999"],
    );
  });
});

describe("get_filing_history", () => {
  test("lists filings in plain words", async () => {
    const out = text(await call("get_filing_history", { company_number: "12345678", limit: 4 }));
    assert.match(out, /Filing history for 12345678, showing 4 of 25:/);
    assert.match(out, /2025-03-20 · Accounts · Accounts with accounts type micro entity \(made up to 2024-06-30\)/);
    assert.match(out, /2024-06-20 · Confirmation statement · Confirmation statement with no updates/);
    assert.match(out, /2010-01-01 · Miscellaneous · Old paper filing/);
  });

  test("fills in who and when from the filing's values, and leaves other values out", async () => {
    const out = text(await call("get_filing_history", { company_number: "12345678" }));
    assert.match(
      out,
      /2024-02-01 · Officers · Appoint person director company with name date \(officer: Jane Smith, appointed: 2024-01-01\)/,
    );
    assert.doesNotMatch(out, /not shown/);
  });

  test("passes the category filter to the API", async () => {
    await call("get_filing_history", { company_number: "12345678", category: "accounts" });
    assert.equal(requests[0]?.url.searchParams.get("category"), "accounts");
  });

  test("no filing history for a company that exists is a normal result, not 'not found'", async () => {
    route = (url) => (url.pathname === "/company/12345678/filing-history" ? json({}, 404) : defaultRoute(url));
    const result = await call("get_filing_history", { company_number: "12345678" });
    assert.equal(result.isError, undefined);
    assert.match(text(result), /Companies House has no filing history for company 12345678/);
  });
});

describe("lookup_postcode", () => {
  test("returns text and structured content, and normalises the postcode", async () => {
    const result = await call("lookup_postcode", { postcode: "sw1a 1aa" });
    assert.equal(result.isError, undefined);
    assert.equal(requests[0]?.url.pathname, "/postcodes/SW1A1AA");
    assert.match(text(result), /Area: Westminster, London, England/);
    assert.deepEqual(result.structuredContent, {
      postcode: "SW1A 1AA",
      country: "England",
      region: "London",
      localAuthority: "Westminster",
      ward: "St James's",
      constituency: "Cities of London and Westminster",
      latitude: 51.50101,
      longitude: -0.141563,
    });
  });

  test("never sends the Companies House key to postcodes.io", async () => {
    await call("lookup_postcode", { postcode: "SW1A 1AA" });
    assert.equal(requests[0]?.url.hostname, PC_HOST);
    assert.equal(requests[0]?.headers.get("authorization"), null);
  });

  test("works without the Companies House key", async () => {
    delete process.env[API_KEY_ENV];
    const result = await call("lookup_postcode", { postcode: "SW1A 1AA" });
    assert.equal(result.isError, undefined);
  });

  test("unknown postcode gives a helpful isError result", async () => {
    const result = await call("lookup_postcode", { postcode: "ZZ99 9ZZ" });
    assert.equal(result.isError, true);
    assert.match(text(result), /was not found/);
  });

  test("badly formed postcode is rejected before any network call", async () => {
    const result = await call("lookup_postcode", { postcode: "12345" });
    assert.equal(result.isError, true);
    assert.match(text(result), /not a valid UK postcode/);
    assert.equal(requests.length, 0);
  });
});

describe("get_company_location", () => {
  test("combines the company's registered office with postcode details", async () => {
    const out = text(await call("get_company_location", { company_number: "12345678" }));
    assert.match(out, /EXAMPLE TRADING LTD \(12345678\)/);
    assert.match(out, /Registered office: 1 Example Street, London, SW1A 1AA, England/);
    assert.match(out, /Area: Westminster, London, England/);
    assert.match(out, /Coordinates: 51.50101, -0.141563/);
    assert.deepEqual(
      requests.map((r) => r.url.hostname),
      [CH_HOST, PC_HOST],
    );
  });

  test("if postcodes.io fails, still returns the company and its address", async () => {
    route = (url) => (url.hostname === PC_HOST ? json({}, 429) : defaultRoute(url));
    const result = await call("get_company_location", { company_number: "12345678" });
    assert.equal(result.isError, undefined);
    assert.match(text(result), /Registered office: 1 Example Street, London, SW1A 1AA, England/);
    assert.match(text(result), /Area details are not available right now: postcodes.io rate limit reached/);
  });

  test("company with no UK postcode is a normal result with the address only", async () => {
    const result = await call("get_company_location", { company_number: "FC012345" });
    assert.equal(result.isError, undefined);
    assert.match(text(result), /100 Main Street, New York, United States/);
    assert.match(text(result), /No UK postcode on record/);
    assert.equal(requests.length, 1);
  });
});
