import { useEffect, useMemo, useRef, useState } from "react";
import { getPersonalExportManifest } from "../api";
import { personalSiteDeploymentOptions, type DeploymentOption } from "../deployment-guidance";
import { DownloadIcon, ExternalIcon } from "../icons";
import { collectPersonalArchive, type PersonalExportProgress } from "../personal-export";
import { buildPortableSiteFiles } from "../portable-site";
import { createPortableSiteZip, portableSiteZipFilename } from "../portable-site-zip";
import { Link } from "../router";
import type { PersonalExportManifest } from "../types";
import { isAbortError } from "../utils";

type ExportPhase = "idle" | "collecting" | "building" | "compressing" | "complete";

interface ExportResult {
  fileCount: number;
  uncompressedBytes: number;
  zipBytes: number;
  downloadUrl: string;
  filename: string;
}

export function PersonalSiteExportPage({ address }: { address: string }) {
  const [manifest, setManifest] = useState<PersonalExportManifest | null>(null);
  const [manifestError, setManifestError] = useState("");
  const [manifestLoading, setManifestLoading] = useState(true);
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [progress, setProgress] = useState<PersonalExportProgress | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ExportResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const deploymentOptions = useMemo(() => personalSiteDeploymentOptions(address), [address]);

  useEffect(() => {
    const existing = document.head.querySelector<HTMLMetaElement>('meta[name="robots"]');
    const robots = existing ?? document.createElement("meta");
    const previousContent = existing?.content;
    if (!existing) {
      robots.name = "robots";
      document.head.appendChild(robots);
    }
    robots.content = "noindex,nofollow";
    document.title = `Build ${shortAddress(address)}’s personal POAP site · POAPin`;
    return () => {
      if (existing) robots.content = previousContent ?? "";
      else robots.remove();
    };
  }, [address]);

  useEffect(() => {
    const controller = new AbortController();
    setManifest(null);
    setManifestError("");
    setManifestLoading(true);
    getPersonalExportManifest(address, controller.signal)
      .then(setManifest)
      .catch((cause: unknown) => {
        if (isAbortError(cause)) return;
        setManifestError(cause instanceof Error ? cause.message : "Could not read export totals.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setManifestLoading(false);
      });
    return () => {
      controller.abort();
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
    };
  }, [address]);

  const start = async () => {
    if (phase !== "idle" && phase !== "complete") return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setPhase("collecting");
    setProgress(null);
    setError("");
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    downloadUrlRef.current = null;
    setResult(null);

    try {
      const snapshot = await collectPersonalArchive(address, controller.signal, setProgress);
      controller.signal.throwIfAborted();
      setPhase("building");
      const files = await buildPortableSiteFiles(snapshot, controller.signal);
      controller.signal.throwIfAborted();
      setPhase("compressing");
      const archive = await createPortableSiteZip(files, snapshot.generatedAt, controller.signal);
      controller.signal.throwIfAborted();
      const downloadUrl = URL.createObjectURL(archive.blob);
      downloadUrlRef.current = downloadUrl;
      setResult({
        fileCount: archive.fileCount,
        uncompressedBytes: archive.uncompressedBytes,
        zipBytes: archive.blob.size,
        downloadUrl,
        filename: portableSiteZipFilename(address),
      });
      setPhase("complete");
    } catch (cause) {
      if (isAbortError(cause)) {
        setPhase("idle");
        setProgress(null);
      } else {
        setError(cause instanceof Error ? cause.message : "The personal site could not be built.");
        setPhase("idle");
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  const cancel = () => controllerRef.current?.abort();
  const active = phase !== "idle" && phase !== "complete";
  const phaseLabel = exportStatusLabel(phase, progress);

  return (
    <main className="personal-site-page shell" id="main-content" tabIndex={-1}>
      <Link className="back-link" href={`/address/${address}`}>
        ← Back to this address
      </Link>

      <section className="personal-site-hero glass-panel">
        <div className="personal-site-hero__copy">
          <span className="eyebrow">A portable home for your memories</span>
          <h1>Turn this address into a personal POAP site.</h1>
          <code>{address}</code>
          <p>
            One ZIP brings together the fixed POAP holdings snapshot, public authored and tagged
            Moments, standalone public Capsules, historically owned Collections, and Collections
            connected through held Drops. It deploys without a framework.
          </p>
        </div>
        <div className="personal-site-hero__mark" aria-hidden="true">
          <span>POAP</span>
          <strong>→</strong>
          <span>WEB</span>
        </div>
      </section>

      <section className="personal-site-summary" aria-labelledby="site-package-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Before you build</span>
            <h2 id="site-package-heading">What goes into the package</h2>
          </div>
        </div>
        <div className="personal-site-summary__grid">
          <ExportMetric
            label="POAP holdings"
            value={manifest?.counts.holdings}
            loading={manifestLoading}
          />
          <ExportMetric
            label="Public authored Moments"
            value={manifest?.counts.authoredMoments}
            loading={manifestLoading}
          />
          <ExportMetric
            label="Public tagged Moments"
            value={manifest?.counts.taggedMoments}
            loading={manifestLoading}
          />
          <ExportMetric
            label="Public Capsules"
            value={manifest?.counts.ownedCapsules}
            loading={manifestLoading}
          />
          <ExportMetric
            label="Historically owned Collections"
            value={manifest?.counts.ownedCollections}
            loading={manifestLoading}
          />
        </div>
        {manifestError ? (
          <p className="personal-site-summary__error" role="status">
            {manifestError}
          </p>
        ) : null}
        <div className="personal-site-policy">
          <div>
            <strong>Structured data is complete; media stays online.</strong>
            <p>
              The ZIP records every public archived field and immutable media URL. It does not copy
              multi-gigabyte images, audio, or video, so the site stays inexpensive and deployable.
            </p>
          </div>
          <div>
            <strong>Nothing plays or loads by itself.</strong>
            <p>
              The generated site only requests artwork or Moment media after a visitor explicitly
              asks for it. Video and audio never autoplay.
            </p>
          </div>
        </div>
        <div className="personal-site-warning" role="note">
          <strong>Publishing changes discoverability.</strong>
          <span>
            All included records are public, but deploying this ZIP gives them one memorable public
            URL. The generated site defaults to noindex, yet anyone with its URL can view its JSON
            data.
          </span>
        </div>
      </section>

      <section className="personal-site-builder" aria-labelledby="builder-heading">
        <div>
          <span className="eyebrow">Built on this device</span>
          <h2 id="builder-heading">Create the deployable ZIP</h2>
          <p>
            Keep this tab open. Large addresses are read in small, snapshot-bound pages and can take
            several minutes; the exporter slows down and retries automatically when needed.
          </p>
        </div>
        <div className="personal-site-builder__actions">
          <button
            className="button button--gold"
            type="button"
            disabled={active || manifestLoading || manifestError.length > 0}
            onClick={start}
          >
            <DownloadIcon />
            {phase === "complete" ? "Rebuild package" : "Build personal-site ZIP"}
          </button>
          {active ? (
            <button className="button button--outline" type="button" onClick={cancel}>
              Cancel safely
            </button>
          ) : null}
        </div>
        <div className="personal-site-progress" aria-live="polite" aria-busy={active}>
          <div className="personal-site-progress__track">
            <span style={{ width: `${stagePercent(progress, phase)}%` }} />
          </div>
          <strong>{phaseLabel}</strong>
          {progress?.retryAfterSeconds ? (
            <span>Continuing in about {progress.retryAfterSeconds} seconds.</span>
          ) : progress ? (
            <span>{progress.detail}</span>
          ) : (
            <span>No archive work starts until you press the button.</span>
          )}
        </div>
        {error ? (
          <p className="personal-site-builder__error" role="alert">
            {error}
          </p>
        ) : null}
        {result ? (
          <div className="personal-site-result" role="status">
            <div>
              <strong>Your ZIP is ready.</strong>
              <span>
                {result.fileCount} files · {formatBytes(result.zipBytes)} compressed ·{" "}
                {formatBytes(result.uncompressedBytes)} before compression
              </span>
            </div>
            <a className="button button--gold" href={result.downloadUrl} download={result.filename}>
              <DownloadIcon />
              Download ZIP
            </a>
          </div>
        ) : null}
      </section>

      <section className="personal-site-deploy" aria-labelledby="deploy-heading">
        <div className="section-heading">
          <div>
            <span className="eyebrow">From ZIP to URL</span>
            <h2 id="deploy-heading">Choose the path that feels simplest</h2>
          </div>
          <p className="personal-site-deploy__lead">
            Cloudflare is the quickest default. Every card also has a prompt you can hand to an
            agent running somewhere else.
          </p>
        </div>
        <div className="deployment-grid">
          {deploymentOptions.map((option) => (
            <DeploymentCard
              option={option}
              copied={copied === option.id}
              onCopy={() => copyPrompt(option, setCopied)}
              key={option.id}
            />
          ))}
        </div>
      </section>
    </main>
  );
}

function ExportMetric({
  label,
  value,
  loading,
}: {
  label: string;
  value: number | undefined;
  loading: boolean;
}) {
  return (
    <div className="personal-site-metric">
      <strong>{loading ? "…" : (value?.toLocaleString("en") ?? "—")}</strong>
      <span>{label}</span>
    </div>
  );
}

function DeploymentCard({
  option,
  copied,
  onCopy,
}: {
  option: DeploymentOption;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <article className={`deployment-card deployment-card--${option.id}`}>
      <div className="deployment-card__heading">
        <span>{option.badge}</span>
        <h3>{option.title}</h3>
      </div>
      <p>{option.description}</p>
      <ol>
        {option.steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <div className="deployment-card__actions">
        <a
          className="button button--outline"
          href={option.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {option.actionLabel}
          <ExternalIcon />
        </a>
        <button className="button button--quiet" type="button" onClick={onCopy}>
          {copied ? "Prompt copied" : "Copy for my agent"}
        </button>
      </div>
    </article>
  );
}

async function copyPrompt(option: DeploymentOption, setCopied: (value: string | null) => void) {
  try {
    await navigator.clipboard.writeText(option.prompt);
    setCopied(option.id);
    window.setTimeout(() => setCopied(null), 3_000);
  } catch {
    setCopied(null);
  }
}

function exportStatusLabel(phase: ExportPhase, progress: PersonalExportProgress | null): string {
  if (phase === "building") return "Writing checksummed static files…";
  if (phase === "compressing") return "Compressing the ZIP on this device…";
  if (phase === "complete") return "ZIP built — choose Download ZIP";
  if (phase === "collecting" && progress) {
    const labels: Record<PersonalExportProgress["stage"], string> = {
      manifest: "Verifying snapshots",
      holdings: "Reading POAP holdings",
      moments: "Reading public authored Moments",
      "tagged-moments": "Reading public tagged Moments",
      capsules: "Reading public Capsules",
      drops: "Completing referenced public Drop details",
      memberships: "Matching held Drops to Collections",
      "owned-collections": "Finding historically owned Collections",
      profiles: "Reading Collection profiles",
      "owned-collection-data": "Archiving owned Collection data",
    };
    return labels[progress.stage];
  }
  return "Ready when you are";
}

function stagePercent(progress: PersonalExportProgress | null, phase: ExportPhase): number {
  if (phase === "building") return 92;
  if (phase === "compressing") return 97;
  if (phase === "complete") return 100;
  if (!progress) return 0;
  const order: Record<PersonalExportProgress["stage"], [number, number]> = {
    manifest: [2, 5],
    holdings: [5, 30],
    moments: [30, 44],
    "tagged-moments": [44, 53],
    capsules: [53, 57],
    memberships: [57, 68],
    "owned-collections": [68, 72],
    profiles: [72, 82],
    "owned-collection-data": [82, 88],
    drops: [88, 90],
  };
  const [start, end] = order[progress.stage];
  if (!progress.total || progress.total <= 0) return end;
  return Math.min(end, start + ((end - start) * progress.current) / progress.total);
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function shortAddress(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
