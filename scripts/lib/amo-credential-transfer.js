import { spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";

const repository = "solitude0429/CHZZK";
const addon = "chzzk@solitude0429.local";

function github(args, input) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|HOMEDRIVE|HOMEPATH|ProgramFiles|ProgramFiles\(x86\))$/i.test(
        key,
      ),
    ),
  );
  const result = spawnSync("gh", args, {
    input,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error("GITHUB_REQUEST_FAILED");
  return result.stdout;
}

async function authorizedVersions(issuer, secret, fetchImpl) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: issuer, iat: now, exp: now + 60, jti: randomUUID() })}`;
  const jwt = `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
  const response = await fetchImpl(
    `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(addon)}/versions/?filter=all_with_unlisted&page_size=1`,
    {
      method: "GET",
      headers: { Authorization: `JWT ${jwt}` },
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (response.status !== 200) {
    await response.body?.cancel();
    return false;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error("AMO_RESPONSE_REJECTED");
    chunks.push(chunk);
  }
  const json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return Array.isArray(json.results) && json.results.some((version) => version.channel === "unlisted");
}

export async function transferAmoCredentials(
  { issuer, secret, apply = false },
  { fetchImpl = fetch, gh = github } = {},
) {
  const status = {
    providerVerified: false,
    storedCount: 0,
    metadataVerified: false,
    signingVerified: false,
    oldRevoked: false,
    status: "failed",
  };
  try {
    if (![issuer, secret].every((v) => typeof v === "string" && /^[\x21-\x7e]{8,1024}$/.test(v)))
      return status;
    status.providerVerified = await authorizedVersions(issuer, secret, fetchImpl);
    if (!status.providerVerified) return status;
    if (!apply) return { ...status, status: "validated_only" };
    const user = JSON.parse(gh(["api", "user"]));
    const repo = JSON.parse(gh(["api", `repos/${repository}`]));
    if (
      user.login !== repository.split("/")[0] ||
      repo.full_name !== repository ||
      repo.permissions?.admin !== true ||
      !Number.isSafeInteger(repo.id)
    )
      return status;
    const environment = JSON.parse(gh(["api", `repos/${repository}/environments/firefox-signing/secrets`]));
    if (!Array.isArray(environment.secrets) || environment.secrets.some((s) => /^AMO_JWT_/.test(s.name)))
      return status;
    for (const state of ["in_progress", "queued", "waiting", "pending", "requested"]) {
      const runs = JSON.parse(gh(["api", `repos/${repository}/actions/runs?status=${state}&per_page=1`]));
      if (runs.total_count !== 0) return status;
    }
    for (const [name, value] of [
      ["AMO_JWT_ISSUER", issuer],
      ["AMO_JWT_SECRET", secret],
    ]) {
      const fresh = JSON.parse(gh(["api", `repos/${repository}`]));
      if (fresh.id !== repo.id || fresh.full_name !== repository || fresh.permissions?.admin !== true) {
        throw new Error("REPOSITORY_CHANGED");
      }
      gh(["secret", "set", name, "--repo", repository], value);
      status.storedCount += 1;
    }
    const readback = JSON.parse(gh(["api", `repos/${repository}/actions/secrets`]));
    status.metadataVerified = ["AMO_JWT_ISSUER", "AMO_JWT_SECRET"].every((name) =>
      readback.secrets?.some((s) => s.name === name),
    );
    status.status = status.metadataVerified ? "stored_signing_unverified" : "metadata_unverified";
  } catch {
    status.status = status.storedCount ? "partial_update_stop" : "failed";
  }
  return status;
}
