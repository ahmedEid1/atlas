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

export function NewProjectDialog() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function submit() {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, question }),
        });
        if (res.ok) {
          const project = (await res.json()) as { id: string };
          setOpen(false);
          router.push(`/projects/${project.id}`);
          return;
        }
        // Map known statuses; the API returns a zod-flatten on 400 — fall
        // through to a generic line rather than dump field-level structure
        // at the user.
        switch (res.status) {
          case 401:
            setError("Your session expired. Please sign in again.");
            break;
          case 400:
            setError("Title and question are required, and title can't exceed 120 chars / question 2000 chars.");
            break;
          default:
            setError(`Could not create the project (HTTP ${res.status}).`);
        }
      } catch {
        setError("Could not reach the server. Check your connection.");
      }
    });
  }

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
        </div>
        {error && (
          <p role="alert" aria-live="polite" className="text-destructive text-xs leading-snug">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button onClick={submit} disabled={isPending || !title || !question}>
            {isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
