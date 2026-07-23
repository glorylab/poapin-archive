#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { buildMomentsMediaPlan } from "./lib/plan.mjs";
import { captureMomentsMedia, verifyMomentsMedia } from "./lib/capture.mjs";
import { buildMomentsMediaRecoveryPlan } from "./lib/recovery.mjs";
import { finalizeMomentsMediaRecovery, recoverMomentsMedia } from "./lib/recovery-executor.mjs";

const HELP = `POAPin Archive — capture original POAP Moments media into immutable R2 objects

Usage:
  node tools/moments-media/cli.mjs plan \\
    --input data/moments/moments-YYYY-MM-DD-v1 \\
    --snapshot-id moments-YYYY-MM-DD-v1

  node tools/moments-media/cli.mjs capture \\
    --input data/moments/moments-YYYY-MM-DD-v1 \\
    --snapshot-id moments-YYYY-MM-DD-v1 \\
    --bridge-url https://TEMPORARY-BRIDGE.workers.dev \\
    --public-bucket poapin-archive \\
    --private-bucket poapin-moments-backups

  node tools/moments-media/cli.mjs recovery-plan \\
    --input data/moments/moments-YYYY-MM-DD-v1 \\
    --snapshot-id moments-YYYY-MM-DD-v1

  node tools/moments-media/cli.mjs recover \\
    --input data/moments/moments-YYYY-MM-DD-v1 \\
    --snapshot-id moments-YYYY-MM-DD-v1 \\
    --bridge-url https://TEMPORARY-BRIDGE.workers.dev \\
    --public-bucket poapin-archive \\
    --private-bucket poapin-moments-backups

  node tools/moments-media/cli.mjs recovery-finalize \\
    --input data/moments/moments-YYYY-MM-DD-v1 \\
    --snapshot-id moments-YYYY-MM-DD-v1

  node tools/moments-media/cli.mjs verify [same target options]

Commands:
  plan       Select one canonical original gateway per normalized media row and
             compute the fail-closed public/private routing plan.
  capture    Download one bounded temporary object at a time, inspect/hash it,
             upload it immutably, checkpoint, and remove the temporary bytes.
  recovery-plan
             Classify unresolved rows into fixed original/derivative recovery
             candidates without changing the append-only capture checkpoint.
  recover    Execute that fixed plan with a separate append-only checkpoint,
             resumable multipart uploads, and fail-closed derivative labeling.
  recovery-finalize
             Rebuild the D1 media manifest, proof, and capture report from the
             immutable capture and recovery journals without network access.
  verify     HEAD every object selected by the adjacent D1 media proof and
             write pass 1 or a pass-1-hash-bound pass 2 remote report.

Options:
  --input <directory>        Verified Moments snapshot root.
  --snapshot-id <id>         Immutable Moments snapshot ID.
  --bridge-url <origin>      Temporary HTTPS R2 bridge origin.
  --public-bucket <name>     Public media bucket (normally poapin-archive).
  --private-bucket <name>    Private preservation bucket.
  --concurrency <n>          Capture 1-8 (default 3); verify 1-12 (default 6).
  --attempts <n>             Network attempts from 1-10 (default 4).
  --max-object-bytes <n>     Single object limit (default 100000000).
  --max-recovery-object-bytes <n>
                             Multipart/derivative bound (default 5000000000).
  --multipart-part-bytes <n> Multipart part size (default 16777216).
  --checkpoint <path>        Override the command's append-only checkpoint.
  --capture-checkpoint <path>
                             Override the immutable first-pass checkpoint.
  --recovery-checkpoint <path>
                             Override recovery checkpoint for recover/finalize/verify.
  --recovery-plan <path>     Override recovery plan for recover/finalize/verify.
  --output <path>            Override recovery plan output (recovery-plan only).
  --manifest <path>          Override the D1 media manifest/proof selection.
  --previous-verification-report <path>
                             Required pass-1 report when producing pass 2.
  --report <path>            Write this command's report to a unique path.
  --help                     Show this help.

The bridge secret is read only from MOMENTS_R2_BRIDGE_SECRET. It is never
accepted as a CLI option or written to reports. The bridge has no object-body
read, list, arbitrary overwrite, or completed-object delete capability.

For a media-bound D1 build, run verify once with a unique --report path. Run it
again with another --report path and
--previous-verification-report <pass-1.json>. The proof selects capture-only
(recovery is exactly null) or recovery-finalized (both recovery digests are
mandatory); verify never chooses a mode from missing files. Pass both reports
to build-d1 in pass-1, pass-2 order.
`;

export function parseMomentsMediaOptions(argv) {
  const command = argv[0];
  if (!command || ["--help", "-h"].includes(command)) return { help: true };
  if (
    !["plan", "capture", "recovery-plan", "recover", "recovery-finalize", "verify"].includes(
      command,
    )
  ) {
    throw new Error(
      "Command must be plan, capture, recovery-plan, recover, recovery-finalize, or verify.",
    );
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    strict: true,
    allowPositionals: false,
    options: {
      input: { type: "string" },
      "snapshot-id": { type: "string" },
      "bridge-url": { type: "string" },
      "public-bucket": { type: "string" },
      "private-bucket": { type: "string" },
      concurrency: { type: "string" },
      attempts: { type: "string", default: "4" },
      "max-object-bytes": { type: "string", default: "100000000" },
      "max-recovery-object-bytes": { type: "string", default: "5000000000" },
      "multipart-part-bytes": { type: "string", default: "16777216" },
      checkpoint: { type: "string" },
      "capture-checkpoint": { type: "string" },
      "recovery-checkpoint": { type: "string" },
      "recovery-plan": { type: "string" },
      output: { type: "string" },
      manifest: { type: "string" },
      "previous-verification-report": { type: "string" },
      report: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) return { help: true };
  for (const name of ["input", "snapshot-id"]) {
    if (!values[name]) throw new Error(`--${name} is required.`);
  }
  const result = {
    help: false,
    command,
    input: values.input,
    snapshotId: values["snapshot-id"],
  };
  if (command === "plan") return result;
  if (command === "recovery-plan") {
    return {
      ...result,
      checkpointPath: values["capture-checkpoint"] ?? values.checkpoint,
      output: values.output,
      reportPath: values.report,
    };
  }
  if (command === "recovery-finalize") {
    return {
      ...result,
      captureCheckpointPath: values["capture-checkpoint"],
      recoveryPlanPath: values["recovery-plan"],
      checkpointPath: values["recovery-checkpoint"] ?? values.checkpoint,
      manifestPath: values.manifest,
      reportPath: values.report,
    };
  }
  for (const name of ["bridge-url", "public-bucket", "private-bucket"]) {
    if (!values[name]) throw new Error(`--${name} is required for ${command}.`);
  }
  return {
    ...result,
    bridgeUrl: values["bridge-url"],
    publicBucket: values["public-bucket"],
    privateBucket: values["private-bucket"],
    concurrency: boundedInteger(
      values.concurrency ?? (command === "verify" ? "6" : command === "recover" ? "1" : "3"),
      "--concurrency",
      1,
      command === "verify" ? 12 : command === "recover" ? 4 : 8,
    ),
    attempts: boundedInteger(values.attempts, "--attempts", 1, 10),
    maximumObjectBytes: boundedInteger(
      values["max-object-bytes"],
      "--max-object-bytes",
      1,
      100_000_000,
    ),
    ...(command === "recover"
      ? {
          maximumRecoveryObjectBytes: boundedInteger(
            values["max-recovery-object-bytes"],
            "--max-recovery-object-bytes",
            1,
            5_000_000_000_000,
          ),
          multipartPartBytes: boundedInteger(
            values["multipart-part-bytes"],
            "--multipart-part-bytes",
            5_242_880,
            100_000_000,
          ),
          captureCheckpointPath: values["capture-checkpoint"],
          recoveryPlanPath: values["recovery-plan"],
        }
      : command === "verify"
        ? {
            recoveryPlanPath: values["recovery-plan"],
            previousVerificationReportPath: values["previous-verification-report"],
          }
        : {}),
    checkpointPath:
      command === "recover"
        ? (values["recovery-checkpoint"] ?? values.checkpoint)
        : command === "verify"
          ? (values["capture-checkpoint"] ?? values.checkpoint)
          : values.checkpoint,
    recoveryCheckpointPath: values["recovery-checkpoint"],
    manifestPath: values.manifest,
    reportPath: values.report,
  };
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseMomentsMediaOptions(argv);
  } catch (error) {
    console.error(`Error: ${error.message}`);
    console.error("Run with --help for usage.");
    return 2;
  }
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.command === "plan") {
    const result = await buildMomentsMediaPlan(options);
    console.error(
      `Planned ${result.report.counts.planned.toLocaleString("en-US")} media rows: ` +
        `${result.report.counts.public.toLocaleString("en-US")} public, ` +
        `${result.report.counts.private.toLocaleString("en-US")} private, ` +
        `${result.report.counts.sourceMissing.toLocaleString("en-US")} without a canonical source.`,
    );
    console.error(`Report: ${result.reportPath}`);
    return 0;
  }
  if (options.command === "recovery-plan") {
    const result = await buildMomentsMediaRecoveryPlan(options);
    console.error(
      `Classified ${result.report.counts.unresolved.toLocaleString("en-US")} unresolved rows: ` +
        `${result.report.counts.originalCandidates.toLocaleString("en-US")} with an original recovery candidate, ` +
        `${result.report.counts.derivativeOnly.toLocaleString("en-US")} derivative-only, ` +
        `${result.report.counts.metadataOnly.toLocaleString("en-US")} metadata-only.`,
    );
    console.error(`Report: ${result.reportPath}`);
    return 0;
  }
  if (options.command === "recovery-finalize") {
    try {
      const report = await finalizeMomentsMediaRecovery(options);
      console.error(
        `${report.complete ? "Complete" : "Incomplete"} recovery finalization: ` +
          `${report.recovery.terminal.toLocaleString("en-US")}/` +
          `${report.recovery.planned.toLocaleString("en-US")} terminal.`,
      );
      console.error(`Report: ${options.reportPath ?? "media/capture-report.json"}`);
      return report.complete ? 0 : 1;
    } catch (error) {
      console.error(`Moments media recovery-finalize stopped: ${error.message}`);
      return 1;
    }
  }

  const controller = new AbortController();
  let interrupted = false;
  const stop = () => {
    if (interrupted) return;
    interrupted = true;
    controller.abort();
    console.error("Interrupt received; active checkpoint writes will settle.");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let lastProgress = 0;
  try {
    const operation =
      options.command === "capture"
        ? captureMomentsMedia
        : options.command === "recover"
          ? recoverMomentsMedia
          : verifyMomentsMedia;
    const report = await operation({
      ...options,
      signal: controller.signal,
      onProgress(progress) {
        if (progress.settled !== progress.total && progress.settled - lastProgress < 25) return;
        lastProgress = progress.settled;
        console.error(
          `${options.command} ${progress.settled.toLocaleString("en-US")}/${progress.total.toLocaleString("en-US")}`,
        );
      },
    });
    console.error(
      `${report.complete ? "Complete" : "Incomplete"}: ${JSON.stringify(report.counts)}.`,
    );
    return interrupted ? 130 : report.complete ? 0 : 1;
  } catch (error) {
    console.error(`Moments media ${options.command} stopped: ${error.message}`);
    return interrupted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

function boundedInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) process.exitCode = await main();
