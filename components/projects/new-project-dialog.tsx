"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type SearchScope = "uploaded_only" | "outbound" | "hybrid";
type Provider = "openalex" | "arxiv" | "exa";

export function NewProjectDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [scope, setScope] = useState<SearchScope>("uploaded_only");
  const [providers, setProviders] = useState<Set<Provider>>(new Set(["openalex", "arxiv"]));
  const [yearStart, setYearStart] = useState<string>("");
  const [yearEnd, setYearEnd] = useState<string>("");
  const [maxHits, setMaxHits] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function toggleProvider(p: Provider) {
    setProviders((s) => {
      const next = new Set(s);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const body: Record<string, unknown> = {
          title,
          question,
          searchScope: scope,
        };
        if (scope !== "uploaded_only") {
          body.searchProviders = [...providers];
          // Year-range + maxHits are optional. Empty string = "let the
          // server default it" (don't send the field). NaN guard catches
          // garbage input — the server-side Zod schema would reject it
          // anyway but we avoid the round-trip.
          const ys = Number.parseInt(yearStart, 10);
          if (Number.isFinite(ys)) body.searchYearStart = ys;
          const ye = Number.parseInt(yearEnd, 10);
          if (Number.isFinite(ye)) body.searchYearEnd = ye;
          const mh = Number.parseInt(maxHits, 10);
          if (Number.isFinite(mh)) body.searchMaxHits = mh;
        }
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          const project = (await res.json()) as { id: string };
          setOpen(false);
          router.push(`/projects/${project.id}`);
          return;
        }
        switch (res.status) {
          case 401:
            setError("Your session expired. Please sign in again.");
            break;
          case 400:
            setError("Title and question are required (title ≤120 chars, question ≤2000 chars). Pick at least one search provider if outbound mode is selected.");
            break;
          default:
            setError(`Could not create the project (HTTP ${res.status}).`);
        }
      } catch {
        setError("Could not reach the server. Check your connection.");
      }
    });
  }

  const outboundLocked =
    scope !== "uploaded_only" && providers.size === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button />}>New project</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>New SLR project</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="question">Research question</Label>
            <Textarea id="question" value={question} onChange={(e) => setQuestion(e.target.value)} rows={4} />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Where should Thoth find papers?</legend>
            <div className="space-y-1.5 text-sm">
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="searchScope"
                  checked={scope === "uploaded_only"}
                  onChange={() => setScope("uploaded_only")}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Uploaded PDFs only</span>
                  <span className="block text-xs text-muted-foreground">
                    Classic mode — you provide the corpus by uploading PDFs.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="searchScope"
                  checked={scope === "outbound"}
                  onChange={() => setScope("outbound")}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Outbound search</span>
                  <span className="block text-xs text-muted-foreground">
                    Agent discovers + acquires papers from academic indices. No upload needed.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input
                  type="radio"
                  name="searchScope"
                  checked={scope === "hybrid"}
                  onChange={() => setScope("hybrid")}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">Hybrid</span>
                  <span className="block text-xs text-muted-foreground">
                    Both — uploaded PDFs are scored alongside discovered ones.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          {scope !== "uploaded_only" && (
            <fieldset className="space-y-2 border rounded p-3">
              <legend className="text-xs font-medium px-1">Search providers</legend>
              <p className="text-xs text-muted-foreground">
                At least one is required. OpenAlex + arXiv are free. Exa needs <code className="font-mono">EXA_API_KEY</code> on the deploy.
              </p>
              <div className="space-y-1.5 text-sm">
                {(["openalex", "arxiv", "exa"] as Provider[]).map((p) => (
                  <label key={p} className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={providers.has(p)}
                      onChange={() => toggleProvider(p)}
                    />
                    <span className="font-mono text-xs">{p}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {scope !== "uploaded_only" && (
            <fieldset className="space-y-3 border rounded p-3">
              <legend className="text-xs font-medium px-1">Search tuning (optional)</legend>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor="year-start" className="text-xs">From year</Label>
                  <Input
                    id="year-start"
                    inputMode="numeric"
                    placeholder="e.g. 2018"
                    value={yearStart}
                    onChange={(e) => setYearStart(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="year-end" className="text-xs">To year</Label>
                  <Input
                    id="year-end"
                    inputMode="numeric"
                    placeholder="e.g. 2025"
                    value={yearEnd}
                    onChange={(e) => setYearEnd(e.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-1">
                <Label htmlFor="max-hits" className="text-xs">Max hits per run (default 50, ceiling 100)</Label>
                <Input
                  id="max-hits"
                  inputMode="numeric"
                  placeholder="50"
                  value={maxHits}
                  onChange={(e) => setMaxHits(e.target.value)}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Year range filters published papers across all providers. Max hits caps how many papers reach the screener; lower = cheaper, higher = broader.
              </p>
            </fieldset>
          )}
        </div>
        {error && (
          <p role="alert" aria-live="polite" className="text-destructive text-xs leading-snug">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={isPending || !title || !question || outboundLocked}
          >
            {isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
