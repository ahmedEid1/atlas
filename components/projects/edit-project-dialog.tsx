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

type EditProject = {
  id: string;
  title: string;
  question: string;
  searchScope: SearchScope;
  searchProviders: string[];
  searchYearStart: number | null;
  searchYearEnd: number | null;
  searchMaxHits: number;
  skipDiscoveryGate: boolean;
};

/**
 * Edit existing project settings. Mirrors NewProjectDialog's shape +
 * field set, pre-filled from the current row, but POSTs PATCH (M38)
 * instead of create. Used by the "Edit" button on the project detail
 * page header.
 *
 * Why a separate component (vs. reusing NewProjectDialog with a mode
 * prop): the create + edit flows differ subtly — create defaults
 * scope to uploaded_only, edit pre-fills from the row; create
 * navigates to the new project, edit refreshes the current page;
 * create's submit text is "Create", edit's is "Save". Forking a
 * sibling component is clearer than a two-mode super-component.
 */
export function EditProjectDialog({ project }: { project: EditProject }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(project.title);
  const [question, setQuestion] = useState(project.question);
  const [scope, setScope] = useState<SearchScope>(project.searchScope);
  const [providers, setProviders] = useState<Set<Provider>>(
    new Set(project.searchProviders.filter((p): p is Provider =>
      p === "openalex" || p === "arxiv" || p === "exa",
    )),
  );
  const [yearStart, setYearStart] = useState<string>(
    project.searchYearStart === null ? "" : String(project.searchYearStart),
  );
  const [yearEnd, setYearEnd] = useState<string>(
    project.searchYearEnd === null ? "" : String(project.searchYearEnd),
  );
  const [maxHits, setMaxHits] = useState<string>(String(project.searchMaxHits));
  const [skipDiscoveryGate, setSkipDiscoveryGate] = useState<boolean>(project.skipDiscoveryGate);
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
          skipDiscoveryGate,
        };
        if (scope !== "uploaded_only") {
          body.searchProviders = [...providers];
          const ys = Number.parseInt(yearStart, 10);
          body.searchYearStart = Number.isFinite(ys) ? ys : null;
          const ye = Number.parseInt(yearEnd, 10);
          body.searchYearEnd = Number.isFinite(ye) ? ye : null;
          const mh = Number.parseInt(maxHits, 10);
          if (Number.isFinite(mh)) body.searchMaxHits = mh;
        }
        const res = await fetch(`/api/projects/${project.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) {
          setOpen(false);
          router.refresh();
          return;
        }
        switch (res.status) {
          case 401:
            setError("Your session expired. Please sign in again.");
            break;
          case 400:
            setError("Some fields are invalid (title ≤120 chars, question ≤2000, max hits ≤100, year-start ≤ year-end).");
            break;
          case 404:
            setError("Project not found — it may have been deleted.");
            break;
          default:
            setError(`Could not save (HTTP ${res.status}).`);
        }
      } catch {
        setError("Could not reach the server. Check your connection.");
      }
    });
  }

  const outboundLocked = scope !== "uploaded_only" && providers.size === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="outline" />}>Edit</DialogTrigger>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit project</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="edit-title">Title</Label>
            <Input id="edit-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="edit-question">Research question</Label>
            <Textarea id="edit-question" value={question} onChange={(e) => setQuestion(e.target.value)} rows={4} />
          </div>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">Where should Thoth find papers?</legend>
            <div className="space-y-1.5 text-sm">
              <label className="flex items-start gap-2">
                <input type="radio" name="edit-scope" checked={scope === "uploaded_only"}
                  onChange={() => setScope("uploaded_only")} className="mt-0.5" />
                <span>
                  <span className="font-medium">Uploaded PDFs only</span>
                  <span className="block text-xs text-muted-foreground">
                    Classic mode — you provide the corpus by uploading PDFs.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="edit-scope" checked={scope === "outbound"}
                  onChange={() => setScope("outbound")} className="mt-0.5" />
                <span>
                  <span className="font-medium">Outbound search</span>
                  <span className="block text-xs text-muted-foreground">
                    Agent discovers + acquires papers from academic indices. No upload needed.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2">
                <input type="radio" name="edit-scope" checked={scope === "hybrid"}
                  onChange={() => setScope("hybrid")} className="mt-0.5" />
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
            <>
              <fieldset className="space-y-2 border rounded p-3">
                <legend className="text-xs font-medium px-1">Search providers</legend>
                <p className="text-xs text-muted-foreground">
                  At least one is required. OpenAlex + arXiv are free. Exa needs <code className="font-mono">EXA_API_KEY</code> on the deploy.
                </p>
                <div className="space-y-1.5 text-sm">
                  {(["openalex", "arxiv", "exa"] as Provider[]).map((p) => (
                    <label key={p} className="flex items-center gap-2">
                      <input type="checkbox" checked={providers.has(p)} onChange={() => toggleProvider(p)} />
                      <span className="font-mono text-xs">{p}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <fieldset className="space-y-3 border rounded p-3">
                <legend className="text-xs font-medium px-1">Search tuning</legend>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label htmlFor="edit-year-start" className="text-xs">From year</Label>
                    <Input id="edit-year-start" inputMode="numeric" placeholder="e.g. 2018"
                      value={yearStart} onChange={(e) => setYearStart(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="edit-year-end" className="text-xs">To year</Label>
                    <Input id="edit-year-end" inputMode="numeric" placeholder="e.g. 2025"
                      value={yearEnd} onChange={(e) => setYearEnd(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="edit-max-hits" className="text-xs">Max hits per run (1-100)</Label>
                  <Input id="edit-max-hits" inputMode="numeric" placeholder="50"
                    value={maxHits} onChange={(e) => setMaxHits(e.target.value)} />
                </div>
                <label className="flex items-start gap-2 pt-1 text-sm">
                  <input type="checkbox" checked={skipDiscoveryGate}
                    onChange={(e) => setSkipDiscoveryGate(e.target.checked)} className="mt-0.5" />
                  <span>
                    <span className="font-medium">Skip discovery approval</span>
                    <span className="block text-xs text-muted-foreground">
                      Auto-approve discovered papers — the agent doesn&apos;t pause for review between the discoverer and fetcher.
                    </span>
                  </span>
                </label>
              </fieldset>
            </>
          )}
        </div>
        {error && (
          <p role="alert" aria-live="polite" className="text-destructive text-xs leading-snug">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button onClick={submit} disabled={isPending || !title || !question || outboundLocked}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
