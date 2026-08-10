import type { Pagination } from "../api/types";
import { Button } from "./ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";

export function Pager({
  pagination,
  count,
  onPage,
}: {
  pagination: Pagination | null;
  count: number;
  onPage: (offset: number) => void | Promise<void>;
}) {
  if (!pagination) return null;

  return (
    <div className="flex items-center justify-between border-t border-neutral-100 px-2 py-3 text-sm text-neutral-600">
      <span>
        {count === 0
          ? "No results"
          : `Showing ${pagination.offset + 1} to ${pagination.offset + count}`}
      </span>
      <div className="flex gap-1">
        <Button variant="secondary" size="icon" disabled={pagination.offset === 0} onClick={() => onPage(Math.max(0, pagination.offset - pagination.limit))} aria-label="Previous page">
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button variant="secondary" size="icon" disabled={pagination.nextOffset === null} onClick={() => pagination.nextOffset !== null && onPage(pagination.nextOffset)} aria-label="Next page">
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
