import { transferAmoCredentials } from "./lib/amo-credential-transfer.js";

// This consumer accepts credentials only over a private stdin pipe from the
// separate Windows prompt. Never invoke it with credentials in argv or env.
try {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 4096) throw new Error("INPUT_REJECTED");
  }
  const values = JSON.parse(input);
  input = "";
  const result = await transferAmoCredentials(values);
  values.issuer = "";
  values.secret = "";
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode =
    result.status === "stored_signing_unverified" || result.status === "validated_only" ? 0 : 1;
} catch {
  process.stdout.write('{"status":"failed_details_suppressed"}\n');
  process.exitCode = 1;
}
