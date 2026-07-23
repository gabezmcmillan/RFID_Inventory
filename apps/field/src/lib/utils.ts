import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind/NativeWind class names with conflict resolution. The shadcn
 * convention: `clsx` for conditional classes, `tailwind-merge` to drop the
 * losing side of conflicting utilities (e.g. `p-2 p-4` → `p-4`).
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
