"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

type Item = {
  id: string;
  source: string;
  status: "PENDING" | "PARSING" | "PARSED" | "FAILED";
  parsedMarkdown: string | null;
  failureReason: string | null;
};

const STATUS_VARIANT: Record<Item["status"], "default" | "secondary" | "destructive" | "outline"> = {
  PENDING: "outline",
  PARSING: "secondary",
  PARSED: "default",
  FAILED: "destructive",
};

export function CorpusItemList({ items }: { items: Item[] }) {
  const router = useRouter();

  useEffect(() => {
    const anyActive = items.some((i) => i.status === "PENDING" || i.status === "PARSING");
    if (!anyActive) return;
    const t = setInterval(() => router.refresh(), 2000);
    return () => clearInterval(t);
  }, [items, router]);

  if (items.length === 0) {
    return <p className="text-muted-foreground text-sm">No documents yet. Upload a PDF to get started.</p>;
  }

  return (
    <ul className="space-y-3">
      {items.map((it) => (
        <li key={it.id}>
          <ItemCard item={it} />
        </li>
      ))}
    </ul>
  );
}

function ItemCard({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <p className="font-mono text-xs truncate">{item.source}</p>
          {item.failureReason && (
            <p className="text-destructive text-xs mt-1">{item.failureReason}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <Badge variant={STATUS_VARIANT[item.status]}>{item.status.toLowerCase()}</Badge>
          {item.status === "PARSED" && (
            <button className="text-sm underline" onClick={() => setOpen((v) => !v)}>
              {open ? "Hide" : "View"}
            </button>
          )}
        </div>
      </div>
      {open && item.parsedMarkdown && (
        <pre className="mt-4 max-h-96 overflow-auto rounded bg-muted p-3 text-xs whitespace-pre-wrap">
          {item.parsedMarkdown}
        </pre>
      )}
    </Card>
  );
}
