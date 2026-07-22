import { type AnchorHTMLAttributes, type MouseEvent, useEffect, useState } from "react";

type NavigateOptions = { replace?: boolean };

export function navigate(to: string, options: NavigateOptions = {}) {
  if (options.replace) window.history.replaceState(null, "", to);
  else window.history.pushState(null, "", to);
  window.dispatchEvent(new PopStateEvent("popstate"));

  const target = new URL(to, window.location.href);
  if (target.hash) {
    window.requestAnimationFrame(() => focusHashTarget(target.hash));
  } else {
    window.scrollTo({ top: 0, behavior: "auto" });
  }
}

export function useLocation() {
  const [location, setLocation] = useState(() => ({
    pathname: window.location.pathname,
    search: window.location.search,
    hash: window.location.hash,
  }));

  useEffect(() => {
    const update = () =>
      setLocation({
        pathname: window.location.pathname,
        search: window.location.search,
        hash: window.location.hash,
      });
    window.addEventListener("popstate", update);
    window.addEventListener("hashchange", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("hashchange", update);
    };
  }, []);

  return location;
}

export function Link({
  href,
  onClick,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (props.target !== undefined && props.target !== "_self") ||
      props.download !== undefined
    ) {
      return;
    }
    const target = new URL(href, window.location.href);
    if (target.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(`${target.pathname}${target.search}${target.hash}`);
  };

  return <a href={href} onClick={handleClick} {...props} />;
}

export function focusHashTarget(hash: string) {
  const rawId = hash.slice(1);
  if (!rawId) return;

  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
    // A malformed fragment should never break client-side navigation.
  }

  const target = document.getElementById(id);
  if (!target) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "start",
  });
}
