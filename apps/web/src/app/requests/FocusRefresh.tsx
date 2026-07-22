"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-fetches the server-rendered order list when the window regains focus. */
export function FocusRefresh() {
  const router = useRouter();
  useEffect(() => {
    const onFocus = () => router.refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [router]);
  return null;
}
