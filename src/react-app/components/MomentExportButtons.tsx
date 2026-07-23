import { useEffect, useRef, useState } from "react";
import { DownloadIcon } from "../icons";
import {
  downloadMomentAuthorExport,
  type MomentExportFormat,
  type MomentExportProgress,
} from "../moment-export";
import { isAbortError } from "../utils";

export function MomentExportButtons({ address }: { address: string }) {
  const [activeFormat, setActiveFormat] = useState<MomentExportFormat | null>(null);
  const [progress, setProgress] = useState<MomentExportProgress | null>(null);
  const [message, setMessage] = useState("");
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    setActiveFormat(null);
    setProgress(null);
    setMessage("");
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [address]);

  const startExport = async (format: MomentExportFormat) => {
    if (activeFormat) return;
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    setActiveFormat(format);
    setProgress(null);
    setMessage("");

    try {
      const count = await downloadMomentAuthorExport(
        address,
        format,
        controller.signal,
        setProgress,
      );
      if (!controller.signal.aborted) {
        setMessage(
          `${count.toLocaleString("en")} created moment${count === 1 ? "" : "s"} downloaded.`,
        );
      }
    } catch (cause) {
      if (!isAbortError(cause)) {
        setMessage(cause instanceof Error ? cause.message : "The export could not be prepared.");
      }
    } finally {
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        setActiveFormat(null);
      }
    }
  };

  const progressLabel = activeFormat
    ? progress
      ? progress.retryAfterSeconds
        ? `The archive is busy · continuing automatically in about ${progress.retryAfterSeconds} seconds`
        : `Preparing ${activeFormat.toUpperCase()} · ${progress.records.toLocaleString("en")} moments read`
      : `Starting ${activeFormat.toUpperCase()} export…`
    : message;

  return (
    <div className="moment-export-actions">
      <div className="moment-export-actions__buttons">
        <button
          className="button button--gold"
          type="button"
          disabled={activeFormat !== null}
          onClick={() => startExport("json")}
        >
          <DownloadIcon />
          {activeFormat === "json" ? "Preparing JSON…" : "Download JSON"}
        </button>
        <button
          className="button button--outline"
          type="button"
          disabled={activeFormat !== null}
          onClick={() => startExport("csv")}
        >
          <DownloadIcon />
          {activeFormat === "csv" ? "Preparing CSV…" : "Download CSV"}
        </button>
      </div>
      <span className="moment-export-actions__status" role="status" aria-live="polite">
        {progressLabel}
      </span>
    </div>
  );
}
