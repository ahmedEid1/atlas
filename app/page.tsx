import Link from "next/link";
import { Show } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="min-h-screen grid place-items-center px-6">
      <div className="max-w-2xl text-center space-y-6">
        <h1 className="text-4xl font-semibold tracking-tight">Atlas</h1>
        <p className="text-lg text-muted-foreground">
          A GDPR-safe agentic workspace for systematic literature reviews.
        </p>
        <div className="flex gap-3 justify-center">
          <Show when="signed-out">
            <Button render={<Link href="/sign-up" />}>Get started</Button>
            <Button variant="outline" render={<Link href="/sign-in" />}>Sign in</Button>
          </Show>
          <Show when="signed-in">
            <Button render={<Link href="/dashboard" />}>Open dashboard</Button>
          </Show>
        </div>
      </div>
    </main>
  );
}
