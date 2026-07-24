import { useEffect, useMemo, useRef, useState } from "react";
import { getPersonalExportManifest } from "../api";
import { personalSiteDeploymentOptions, type DeploymentOption } from "../deployment-guidance";
import { DownloadIcon, ExternalIcon } from "../icons";
import {
  buildMediaArchivePlan,
  createPersonalImageArchiveZip,
  PERSONAL_IMAGE_ARCHIVE_BLOB_LIMIT_BYTES,
  PERSONAL_IMAGE_ARCHIVE_MAX_BYTES,
  PERSONAL_IMAGE_ARCHIVE_MAX_IMAGES,
  personalImageArchiveFilename,
  type PersonalImageArchivePlan,
  type PersonalImageArchiveProgress,
} from "../personal-image-archive";
import {
  collectPersonalArchive,
  type PersonalArchiveSnapshot,
  type PersonalExportProgress,
} from "../personal-export";
import { buildPortableSiteFiles } from "../portable-site";
import {
  createPortableSiteZip,
  portableSiteZipFilename,
  type PortableSiteZipProgress,
} from "../portable-site-zip";
import { Link } from "../router";
import type { PersonalExportManifest } from "../types";
import { isAbortError } from "../utils";

type ExportPhase = "idle" | "collecting" | "building" | "compressing" | "complete";
type ImageArchivePhase = "idle" | "collecting" | "ready" | "saving" | "complete";

interface ExportResult {
  fileCount: number;
  uncompressedBytes: number;
  zipBytes: number;
  downloadUrl: string;
  filename: string;
}

interface ImageArchiveResult {
  fileCount: number;
  downloadedBytes: number;
  archiveBytes: number;
  downloadUrl: string | null;
  filename: string;
}

export function PersonalSiteExportPage({ address }: { address: string }) {
  const [manifest, setManifest] = useState<PersonalExportManifest | null>(null);
  const [manifestError, setManifestError] = useState("");
  const [manifestLoading, setManifestLoading] = useState(true);
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [progress, setProgress] = useState<PersonalExportProgress | null>(null);
  const [zipProgress, setZipProgress] = useState<PortableSiteZipProgress | null>(null);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ExportResult | null>(null);
  const [imagePhase, setImagePhase] = useState<ImageArchivePhase>("idle");
  const [imageCollectProgress, setImageCollectProgress] = useState<PersonalExportProgress | null>(
    null,
  );
  const [imageProgress, setImageProgress] = useState<PersonalImageArchiveProgress | null>(null);
  const [imagePlan, setImagePlan] = useState<PersonalImageArchivePlan | null>(null);
  const [imageError, setImageError] = useState("");
  const [imageResult, setImageResult] = useState<ImageArchiveResult | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const imageControllerRef = useRef<AbortController | null>(null);
  const snapshotRef = useRef<PersonalArchiveSnapshot | null>(null);
  const downloadUrlRef = useRef<string | null>(null);
  const imageDownloadUrlRef = useRef<string | null>(null);
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
    snapshotRef.current = null;
    setManifest(null);
    setManifestError("");
    setManifestLoading(true);
    setPhase("idle");
    setProgress(null);
    setZipProgress(null);
    setError("");
    setResult(null);
    setImagePhase("idle");
    setImageCollectProgress(null);
    setImageProgress(null);
    setImagePlan(null);
    setImageError("");
    setImageResult(null);
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
      imageControllerRef.current?.abort();
      imageControllerRef.current = null;
      snapshotRef.current = null;
      if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
      downloadUrlRef.current = null;
      if (imageDownloadUrlRef.current) URL.revokeObjectURL(imageDownloadUrlRef.current);
      imageDownloadUrlRef.current = null;
    };
  }, [address]);

  const start = async () => {
    if ((phase !== "idle" && phase !== "complete") || imagePhase === "collecting") return;
    if (imagePhase === "saving") return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setPhase("collecting");
    setProgress(null);
    setZipProgress(null);
    setError("");
    if (downloadUrlRef.current) URL.revokeObjectURL(downloadUrlRef.current);
    downloadUrlRef.current = null;
    setResult(null);

    try {
      const snapshot =
        snapshotRef.current ??
        (await collectPersonalArchive(address, controller.signal, setProgress));
      snapshotRef.current = snapshot;
      controller.signal.throwIfAborted();
      setProgress(null);
      setPhase("building");
      const files = await buildPortableSiteFiles(snapshot, controller.signal);
      controller.signal.throwIfAborted();
      setZipProgress({ completedFiles: 0, totalFiles: files.size });
      setPhase("compressing");
      const archive = await createPortableSiteZip(
        files,
        snapshot.generatedAt,
        controller.signal,
        setZipProgress,
      );
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
        setZipProgress(null);
      } else {
        setError(cause instanceof Error ? cause.message : "The personal site could not be built.");
        setPhase("idle");
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  const prepareImages = async () => {
    if (
      imagePhase === "collecting" ||
      imagePhase === "saving" ||
      (phase !== "idle" && phase !== "complete")
    ) {
      return;
    }
    const controller = new AbortController();
    imageControllerRef.current?.abort();
    imageControllerRef.current = controller;
    setImagePhase("collecting");
    setImageCollectProgress(null);
    setImageProgress(null);
    setImageError("");
    setImagePlan(null);
    setImageResult(null);
    if (imageDownloadUrlRef.current) URL.revokeObjectURL(imageDownloadUrlRef.current);
    imageDownloadUrlRef.current = null;

    try {
      const snapshot =
        snapshotRef.current ??
        (await collectPersonalArchive(address, controller.signal, setImageCollectProgress));
      snapshotRef.current = snapshot;
      controller.signal.throwIfAborted();
      const plan = buildMediaArchivePlan(snapshot);
      setImagePlan(plan);
      setImageCollectProgress(null);
      setImagePhase("ready");
    } catch (cause) {
      if (isAbortError(cause)) {
        setImageCollectProgress(null);
        setImagePhase("idle");
      } else {
        setImageError(
          cause instanceof Error ? cause.message : "The archived image list could not be prepared.",
        );
        setImagePhase("idle");
      }
    } finally {
      if (imageControllerRef.current === controller) imageControllerRef.current = null;
    }
  };

  const saveImages = async () => {
    if (
      !imagePlan ||
      imagePlan.count < 1 ||
      imagePhase === "collecting" ||
      imagePhase === "saving"
    ) {
      return;
    }
    const filename = personalImageArchiveFilename(address);
    let writable: WritableStream<Uint8Array> | undefined;
    try {
      writable = await chooseImageArchiveDestination(filename);
    } catch (cause) {
      if (isAbortError(cause)) return;
      setImageError(
        cause instanceof Error ? cause.message : "The save destination could not be opened.",
      );
      return;
    }

    const controller = new AbortController();
    imageControllerRef.current?.abort();
    imageControllerRef.current = controller;
    setImagePhase("saving");
    setImageProgress({
      completedFiles: 0,
      totalFiles: imagePlan.count,
      downloadedBytes: 0,
      currentPath: null,
    });
    setImageError("");
    setImageResult(null);
    if (imageDownloadUrlRef.current) URL.revokeObjectURL(imageDownloadUrlRef.current);
    imageDownloadUrlRef.current = null;

    try {
      const archive = await createPersonalImageArchiveZip(
        imagePlan,
        controller.signal,
        setImageProgress,
        writable ? { writable } : undefined,
      );
      controller.signal.throwIfAborted();
      const downloadUrl = archive.blob ? URL.createObjectURL(archive.blob) : null;
      imageDownloadUrlRef.current = downloadUrl;
      setImageResult({
        fileCount: archive.fileCount,
        downloadedBytes: archive.downloadedBytes,
        archiveBytes: archive.archiveBytes,
        downloadUrl,
        filename,
      });
      setImagePhase("complete");
    } catch (cause) {
      if (isAbortError(cause)) {
        setImagePhase("ready");
        setImageProgress(null);
      } else {
        setImageError(
          cause instanceof Error ? cause.message : "The archived image ZIP could not be built.",
        );
        setImagePhase("ready");
      }
    } finally {
      if (imageControllerRef.current === controller) imageControllerRef.current = null;
    }
  };

  const cancel = () => controllerRef.current?.abort();
  const active = phase !== "idle" && phase !== "complete";
  const imageActive = imagePhase === "collecting" || imagePhase === "saving";
  const phaseLabel = exportStatusLabel(phase, progress);
  const phaseDetail = exportStatusDetail(phase, progress, zipProgress);
  const imagePercent = imageArchivePercent(imagePhase, imageCollectProgress, imageProgress);
  const imageStreamsToDisk = supportsImageArchiveFilePicker();
  const imageExceedsBrowserMemory =
    !imageStreamsToDisk &&
    imagePlan !== null &&
    imagePlan.knownBytes >= PERSONAL_IMAGE_ARCHIVE_BLOB_LIMIT_BYTES;

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
            <strong>The deployable site stays light; original images travel separately.</strong>
            <p>
              The site ZIP records every public archived field and immutable media URL. Use the
              original-image archive below when you also want the image files themselves.
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
            disabled={active || imageActive || manifestLoading || manifestError.length > 0}
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
            <span style={{ width: `${stagePercent(progress, zipProgress, phase)}%` }} />
          </div>
          <strong>{phaseLabel}</strong>
          <span>{phaseDetail}</span>
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

      <section className="personal-image-archive" aria-labelledby="image-archive-heading">
        <div className="personal-image-archive__intro">
          <div>
            <span className="eyebrow">Original image backup</span>
            <h2 id="image-archive-heading">Download your archived images</h2>
          </div>
          <p>
            One separate ZIP gathers this address’s related POAP artwork, Collection branding,
            public Moment images, link previews, and Capsule images. Duplicate files are stored
            once; video and audio are not included.
          </p>
        </div>

        {imagePlan ? (
          <div className="personal-image-plan" aria-label="Prepared image archive">
            <div>
              <strong>{imagePlan.count.toLocaleString("en")} unique images</strong>
              <span>
                {imagePlan.knownBytes > 0
                  ? `${formatBytes(imagePlan.knownBytes)} known`
                  : "File sizes are read while saving"}
                {imagePlan.unknownByteLengthCount > 0
                  ? ` · ${imagePlan.unknownByteLengthCount.toLocaleString("en")} sizes discovered while saving`
                  : ""}
              </span>
            </div>
            <ImageArchiveBreakdown plan={imagePlan} />
          </div>
        ) : null}

        <div className="personal-image-archive__actions">
          {imagePlan && imagePlan.count > 0 ? (
            <button
              className="button button--gold"
              type="button"
              disabled={active || imageActive || imageExceedsBrowserMemory}
              onClick={saveImages}
            >
              <DownloadIcon />
              {imagePhase === "complete" ? "Save another copy" : "Save all images ZIP"}
            </button>
          ) : (
            <button
              className="button button--gold"
              type="button"
              disabled={active || imageActive || manifestLoading || manifestError.length > 0}
              onClick={prepareImages}
            >
              <DownloadIcon />
              {imagePlan ? "Check image list again" : "Prepare image archive"}
            </button>
          )}
          {imageActive ? (
            <button
              className="button button--outline"
              type="button"
              onClick={() => imageControllerRef.current?.abort()}
            >
              Cancel safely
            </button>
          ) : imagePlan && imagePlan.count > 0 ? (
            <button
              className="button button--quiet"
              type="button"
              disabled={active}
              onClick={prepareImages}
            >
              Rebuild image list
            </button>
          ) : null}
        </div>

        <div className="personal-image-progress" aria-busy={imageActive}>
          <div
            className="personal-image-progress__track"
            role="progressbar"
            aria-label="Image archive progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(imagePercent)}
          >
            <span style={{ width: `${imagePercent}%` }} />
          </div>
          <strong aria-live="polite">
            {imageArchiveStatusLabel(imagePhase, imageCollectProgress, imagePlan)}
          </strong>
          <span>
            {imageArchiveStatusDetail(imagePhase, imageCollectProgress, imageProgress, imagePlan)}
          </span>
        </div>

        {imageExceedsBrowserMemory ? (
          <p className="personal-image-archive__error" role="note">
            This browser would need to hold at least {formatBytes(imagePlan?.knownBytes ?? 0)} in
            memory. Open this page in current desktop Chrome or Edge to stream the ZIP directly to
            disk.
          </p>
        ) : null}
        {imageError ? (
          <p className="personal-image-archive__error" role="alert">
            {imageError}
          </p>
        ) : null}
        {imageResult ? (
          <div className="personal-image-result" role="status">
            <div>
              <strong>
                {imageResult.downloadUrl ? "Your image ZIP is ready." : "Your image ZIP was saved."}
              </strong>
              <span>
                {imageResult.fileCount.toLocaleString("en")} images ·{" "}
                {formatBytes(imageResult.downloadedBytes)} downloaded ·{" "}
                {formatBytes(imageResult.archiveBytes)} ZIP
              </span>
            </div>
            {imageResult.downloadUrl ? (
              <a
                className="button button--gold"
                href={imageResult.downloadUrl}
                download={imageResult.filename}
              >
                <DownloadIcon />
                Download image ZIP
              </a>
            ) : null}
          </div>
        ) : null}

        <p className="personal-image-archive__note">
          No image bytes are fetched on page load or while preparing the list; they are requested
          only after you choose Save.{" "}
          {imageStreamsToDisk
            ? "This browser streams the ZIP directly to the selected file."
            : `This browser prepares up to ${formatBytes(PERSONAL_IMAGE_ARCHIVE_BLOB_LIMIT_BYTES)} in memory before offering the ZIP.`}{" "}
          A single archive supports fewer than {formatBytes(PERSONAL_IMAGE_ARCHIVE_MAX_BYTES)} and
          up to {PERSONAL_IMAGE_ARCHIVE_MAX_IMAGES.toLocaleString("en")} images; reaching either
          bound stops safely without presenting an incomplete ZIP.
        </p>
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

function ImageArchiveBreakdown({ plan }: { plan: PersonalImageArchivePlan }) {
  const labels: Record<string, string> = {
    poaps: "POAPs",
    collections: "Collections",
    moments: "Moments & links",
    capsules: "Capsules",
  };
  const entries = Object.entries(plan.breakdown).filter(([, value]) => value > 0);
  if (entries.length === 0) return null;

  return (
    <dl className="personal-image-plan__breakdown">
      {entries.map(([category, value]) => (
        <div key={category}>
          <dt>{labels[category] ?? category}</dt>
          <dd>{value.toLocaleString("en")}</dd>
        </div>
      ))}
    </dl>
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
  const headingId = `deployment-${option.id}-heading`;

  return (
    <article
      className={`deployment-card deployment-card--${option.id}`}
      aria-labelledby={headingId}
    >
      <div className="deployment-card__heading">
        <DeploymentBrandMark id={option.id} />
        <div>
          <span className="deployment-card__badge">{option.badge}</span>
          <h3 id={headingId} translate="no">
            {option.title}
          </h3>
        </div>
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
        <button
          className="button button--quiet"
          type="button"
          aria-label={
            copied ? `${option.title} prompt copied` : `Copy ${option.title} prompt for my agent`
          }
          aria-live="polite"
          onClick={onCopy}
        >
          {copied ? "Prompt copied" : "Copy for my agent"}
        </button>
      </div>
    </article>
  );
}

function DeploymentBrandMark({ id }: { id: DeploymentOption["id"] }) {
  const marks: Record<DeploymentOption["id"], string> = {
    cloudflare: "☁",
    vercel: "▲",
    filebase: "⬡",
    icp: "∞",
  };

  return (
    <span
      className={`deployment-brand-mark deployment-brand-mark--${id}`}
      data-deployment-brand={id}
      aria-hidden="true"
    >
      {marks[id]}
    </span>
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

function exportStatusDetail(
  phase: ExportPhase,
  progress: PersonalExportProgress | null,
  zipProgress: PortableSiteZipProgress | null,
): string {
  if (phase === "building") return "Creating the static viewer, data files and checksums.";
  if (phase === "compressing" && zipProgress) {
    return `${zipProgress.completedFiles.toLocaleString("en")} of ${zipProgress.totalFiles.toLocaleString("en")} files compressed`;
  }
  if (phase === "complete") return "The package is ready to download and deploy.";
  if (phase === "collecting" && progress?.retryAfterSeconds) {
    return `Continuing in about ${progress.retryAfterSeconds} seconds.`;
  }
  if (phase === "collecting" && progress) return progress.detail;
  return "No archive work starts until you press the button.";
}

function stagePercent(
  progress: PersonalExportProgress | null,
  zipProgress: PortableSiteZipProgress | null,
  phase: ExportPhase,
): number {
  if (phase === "building") return 92;
  if (phase === "compressing") {
    if (!zipProgress || zipProgress.totalFiles < 1) return 93;
    return 93 + (zipProgress.completedFiles / zipProgress.totalFiles) * 6;
  }
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

function imageArchiveStatusLabel(
  phase: ImageArchivePhase,
  collectProgress: PersonalExportProgress | null,
  plan: PersonalImageArchivePlan | null,
): string {
  if (phase === "collecting") return exportStatusLabel("collecting", collectProgress);
  if (phase === "saving") return "Saving archived originals…";
  if (phase === "complete") return "Image archive complete";
  if (phase === "ready") {
    return plan?.count ? "Image list ready — choose where to save it" : "No archived images found";
  }
  return "Ready when you are";
}

function imageArchiveStatusDetail(
  phase: ImageArchivePhase,
  collectProgress: PersonalExportProgress | null,
  progress: PersonalImageArchiveProgress | null,
  plan: PersonalImageArchivePlan | null,
): string {
  if (phase === "collecting" && collectProgress?.retryAfterSeconds) {
    return `Continuing in about ${collectProgress.retryAfterSeconds} seconds.`;
  }
  if (phase === "collecting" && collectProgress) return collectProgress.detail;
  if (phase === "saving" && progress) {
    const path = progress.currentPath?.split("/").at(-1);
    return `${progress.completedFiles.toLocaleString("en")} of ${progress.totalFiles.toLocaleString("en")} images · ${formatBytes(progress.downloadedBytes)}${path ? ` · ${path}` : ""}`;
  }
  if (phase === "complete") return "Every planned image passed validation and is in the ZIP.";
  if (phase === "ready" && plan?.count) {
    return "The next click starts the image requests. No image bytes have been prefetched.";
  }
  if (phase === "ready") return "This public archive does not currently contain related images.";
  return "Preparing the list reads structured archive data only; it does not load the images.";
}

function imageArchivePercent(
  phase: ImageArchivePhase,
  collectProgress: PersonalExportProgress | null,
  progress: PersonalImageArchiveProgress | null,
): number {
  if (phase === "ready" || phase === "complete") return 100;
  if (phase === "saving") {
    if (!progress || progress.totalFiles < 1) return 0;
    return Math.min(99, (progress.completedFiles / progress.totalFiles) * 100);
  }
  if (phase === "collecting") {
    return Math.min(94, stagePercent(collectProgress, null, "collecting"));
  }
  return 0;
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1_024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

interface ImageArchiveFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}

interface ImageArchivePickerWindow extends Window {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: Array<{
      description: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<ImageArchiveFileHandle>;
}

async function chooseImageArchiveDestination(
  filename: string,
): Promise<WritableStream<Uint8Array> | undefined> {
  const pickerWindow = window as ImageArchivePickerWindow;
  if (!pickerWindow.showSaveFilePicker) return undefined;
  const handle = await pickerWindow.showSaveFilePicker({
    suggestedName: filename,
    types: [
      {
        description: "ZIP archive",
        accept: { "application/zip": [".zip"] },
      },
    ],
  });
  return handle.createWritable();
}

function supportsImageArchiveFilePicker(): boolean {
  return (
    typeof window !== "undefined" &&
    Boolean((window as ImageArchivePickerWindow).showSaveFilePicker)
  );
}

function shortAddress(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
