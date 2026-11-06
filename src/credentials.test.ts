import test from "node:test";
import assert from "node:assert/strict";
import { parseCredentials, sha256hex } from "./credentials.ts";

const H_A1 = sha256hex("alice-client-1");
const H_A2 = sha256hex("alice-client-2");
const H_B = sha256hex("bob-client");

const FILE = `
# user   token          default-space  groups           bearer-hashes
alice    sb_tok_alice   alpha          agents,writers   ${H_A1},${H_A2}
bob      sb_tok_bob     beta           agents           ${H_B}
scan     sb_tok_scan    -              -                -   # the technical user
`;

test("credentials: the file parses into users with groups, default space and bearers", () => {
  const { credentials, problems } = parseCredentials(FILE);
  assert.deepEqual(problems, []);
  assert.equal(credentials.users.size, 3);
  const alice = credentials.users.get("alice")!;
  assert.equal(alice.token, "sb_tok_alice");
  assert.equal(alice.defaultSpace, "alpha");
  assert.deepEqual(alice.groups, ["agents", "writers"]);
  assert.equal(alice.bearerHashes.length, 2);
  const scan = credentials.users.get("scan")!;
  assert.equal(scan.defaultSpace, null);
  assert.deepEqual(scan.groups, []);
  assert.deepEqual(scan.bearerHashes, []);
  assert.deepEqual(alice.emails, [], "a line of five fields has no e-mail address");
});

test("credentials: a bearer is looked up by its hash; an unknown or empty bearer finds nobody", () => {
  const { credentials } = parseCredentials(FILE);
  assert.equal(credentials.byBearer("alice-client-2")?.user, "alice");
  assert.equal(credentials.byBearer("bob-client")?.user, "bob");
  assert.equal(credentials.byBearer("bob-client "), null);
  assert.equal(credentials.byBearer(""), null);
  assert.equal(credentials.byBearer(H_B), null, "the hash itself is not a bearer");
});

test("credentials: duplicates and malformed hashes are reported", () => {
  const { problems } = parseCredentials(`alice t a - ${H_A1}\nalice t a - -\nbob t b - ${H_A1}\ncarol t c - abc\ndave t\n`);
  assert.equal(problems.length, 4);
  assert.match(problems[0], /appears twice/);
  assert.match(problems[1], /already used by "alice"/);
  assert.match(problems[2], /not a hex SHA-256/);
  assert.match(problems[3], /5 or 6 fields/);
});

test("credentials: the optional sixth field holds the user's e-mail addresses; an address is looked up in any case", () => {
  const { credentials, problems } = parseCredentials(`alice t a agents ${H_A1} Alice@Example.org,alice@other.example\nbob t b agents - -\ncarol t c - - carol@example.org # by Access only\nscan t - - -\n`);
  assert.deepEqual(problems, []);
  assert.deepEqual(credentials.users.get("alice")!.emails, ["alice@example.org", "alice@other.example"]);
  assert.deepEqual(credentials.users.get("bob")!.emails, []);
  assert.equal(credentials.byEmail("alice@example.org")?.user, "alice");
  assert.equal(credentials.byEmail("ALICE@OTHER.EXAMPLE")?.user, "alice");
  assert.equal(credentials.byEmail("carol@example.org")?.user, "carol");
  assert.equal(credentials.byEmail("bob@example.org"), null);
  assert.equal(credentials.byEmail("alice"), null, "a user name is not an address");
  assert.equal(credentials.byEmail("-"), null);
  assert.equal(credentials.byEmail(""), null);
  assert.equal(credentials.byBearer("alice-client-1")?.user, "alice", "bearers are unchanged beside it");
});

test("credentials: an address on two lines, a field that is no address and a seventh field are reported", () => {
  const { credentials, problems } = parseCredentials("alice t a - - alice@example.org\nbob t b - - Alice@Example.org\ncarol t c - - carol\ndave t d - - dave@example.org extra\n");
  assert.equal(problems.length, 3);
  assert.match(problems[0], /line 2: e-mail address already used by "alice"/);
  assert.match(problems[1], /line 3: "carol" is not an e-mail address/);
  assert.match(problems[2], /line 4: .*got 7/);
  assert.equal(credentials.byEmail("alice@example.org")?.user, "alice", "the first line keeps the address");
});
