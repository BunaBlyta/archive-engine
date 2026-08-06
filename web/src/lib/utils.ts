import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function formatDateShort(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(value));
}

export function formatRelativeDate(value: string) {
  const date = new Date(value);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const daysAgo = Math.round((startOfDay(new Date()).getTime() - startOfDay(date).getTime()) / 86_400_000);

  if (daysAgo === 0) return "Today";
  if (daysAgo === 1) return "Yesterday";
  if (daysAgo >= 2 && daysAgo <= 6) return `${daysAgo} days ago`;
  if (daysAgo === 7) return "One week ago";
  return formatDateShort(value);
}

export function displayName(
  user: { email?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined
) {
  if (!user) return "Unknown";
  const name = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return name || user.email || "Unknown";
}

export function initials(
  user: { email?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined
) {
  if (!user) return "?";
  const first = user.firstName?.trim()?.[0];
  const last = user.lastName?.trim()?.[0];
  if (first && last) return `${first}${last}`.toUpperCase();
  return (user.email ?? "?").slice(0, 2).toUpperCase();
}

export function formatBytes(bytes: number) {
  if (bytes === 0) return "0 B";

  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;

  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}
