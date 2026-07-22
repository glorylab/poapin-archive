import type { ReactNode } from "react";

export function GridSkeleton({ count = 12 }: { count?: number }) {
  return (
    <div className="drop-grid" role="status" aria-label="Loading POAPs" aria-busy="true">
      {Array.from({ length: count }, (_, index) => (
        <div className="skeleton-card" key={index}>
          <span className="skeleton skeleton--circle" />
          <span className="skeleton skeleton--title" />
          <span className="skeleton skeleton--line" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty-state">
      <img src="/brand/logo_poap.svg" alt="" width="72" height="92" />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <strong>We could not load this part of the archive.</strong>
      <span>{message}</span>
      {onRetry ? (
        <button className="button button--small" type="button" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
