import assert from "node:assert/strict";
import test from "node:test";
import { transferAmoCredentials } from "../../scripts/lib/amo-credential-transfer.js";

const input = { issuer: "synthetic-issuer", secret: "synthetic-secret", apply: true };
function dependencies({ rejectWrite = 0, active = false, provider = true } = {}) {
  const writes = [];
  return {
    writes,
    fetchImpl: async (url, options) => {
      assert.equal(new URL(url).hostname, "addons.mozilla.org");
      assert.equal(options.redirect, "error");
      assert.equal(options.method, "GET");
      return new Response(JSON.stringify({ results: [{ channel: "unlisted" }] }), {
        status: provider ? 200 : 401,
      });
    },
    gh: (args, body) => {
      assert.equal(
        args.some((a) => a.includes(input.secret)),
        false,
      );
      if (args[0] === "secret") {
        writes.push({ args, body });
        if (writes.length === rejectWrite) throw new Error(input.secret);
        return "";
      }
      if (args[1] === "user") return JSON.stringify({ login: "solitude0429" });
      if (args[1] === "repos/solitude0429/CHZZK")
        return JSON.stringify({ id: 1, full_name: "solitude0429/CHZZK", permissions: { admin: true } });
      if (args[1].includes("environments/")) return JSON.stringify({ secrets: [] });
      if (args[1].includes("actions/runs")) return JSON.stringify({ total_count: active ? 1 : 0 });
      return JSON.stringify({ secrets: [{ name: "AMO_JWT_ISSUER" }, { name: "AMO_JWT_SECRET" }] });
    },
  };
}

test("passes credentials only in stdin and reports no signing or revocation claim", async () => {
  const deps = dependencies();
  const result = await transferAmoCredentials(input, deps);
  assert.equal(result.status, "stored_signing_unverified");
  assert.equal(deps.writes.length, 2);
  assert.equal(deps.writes[1].body, input.secret);
  assert.equal(result.signingVerified, false);
  assert.equal(result.oldRevoked, false);
  assert.equal(JSON.stringify(result).includes(input.secret), false);
});
test("a partial two-secret update stays incomplete and hides raw errors", async () => {
  const result = await transferAmoCredentials(input, dependencies({ rejectWrite: 2 }));
  assert.equal(result.status, "partial_update_stop");
  assert.equal(result.storedCount, 1);
  assert.equal(JSON.stringify(result).includes(input.secret), false);
});
test("failed authentication, active runs and validation-only mode never write", async () => {
  for (const options of [{ provider: false }, { active: true }, {}]) {
    const deps = dependencies(options);
    await transferAmoCredentials({ ...input, apply: Object.keys(options).length > 0 }, deps);
    assert.equal(deps.writes.length, 0);
  }
});
