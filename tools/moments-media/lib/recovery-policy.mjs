const CAPTURE_RECOVERY_STATUSES = new Set(["failed", "oversize", "source_missing"]);
const PERMANENT_SOURCE_HTTP_STATUSES = new Set([403, 404, 410]);

export function momentsMediaNeedsRecovery(planRow, captureRecord) {
  if (!captureRecord) return false;
  return Boolean(
    CAPTURE_RECOVERY_STATUSES.has(captureRecord.status) ||
    (planRow?.publicEligible === true && captureRecord.status !== "public_stored"),
  );
}

export function momentsCaptureFailureRequiresRetry(record) {
  return Boolean(
    record?.status === "failed" &&
    !(
      record.errorCode === "SOURCE_HTTP_ERROR" &&
      PERMANENT_SOURCE_HTTP_STATUSES.has(record.httpStatus)
    ),
  );
}
