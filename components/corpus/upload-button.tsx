"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function UploadButton({ projectId }: { projectId: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("projectId", projectId);
    fd.set("file", file);
    const res = await fetch("/api/corpus/upload", { method: "POST", body: fd });
    setBusy(false);
    if (res.ok) router.refresh();
  }

  return (
    <>
      <input ref={inputRef} type="file" accept="application/pdf" hidden onChange={onPick} />
      <Button onClick={() => inputRef.current?.click()} disabled={busy}>
        {busy ? "Uploading…" : "Upload PDF"}
      </Button>
    </>
  );
}
