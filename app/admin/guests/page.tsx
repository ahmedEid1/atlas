import { notFound } from "next/navigation";
import Link from "next/link";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { isAdminEmail } from "@/lib/admin";

/**
 * Server-only operator view of guest provisioning activity.
 *
 * Reads `User where isGuest = true` from the last 7 days, buckets them
 * by the hour of `createdAt`, and renders a single descending-time
 * table. Lets the operator see at a glance whether `/api/demo/start`
 * is being scripted by a bot vs producing the usual organic trickle.
 *
 * Auth model: requireUser + isAdminEmail. Any signed-in user whose
 * `clerkUser.primaryEmailAddress` is NOT in the `ADMIN_EMAILS` env list
 * gets a 404 (we deliberately don't leak the existence of /admin/*
 * routes via a 403). Unset `ADMIN_EMAILS` means nobody — every request
 * 404s, which is the safe default for a fresh deploy.
 *
 * Pair with `DEMO_DISABLED=1` to halt provisioning while investigating
 * a spike (see app/api/demo/start/route.ts).
 */

export const dynamic = "force-dynamic";

const LOOKBACK_HOURS = 7 * 24;

export default async function GuestsAdminPage() {
  const user = await requireUser().catch(() => null);
  if (!user) notFound();
  if (!isAdminEmail(user.email)) notFound();

  // `dynamic = "force-dynamic"` above means this server component runs
  // on every request — `Date.now()` is request-scoped, not build-time,
  // so the react-hooks/purity rule's concern doesn't apply here.
  // eslint-disable-next-line react-hooks/purity
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const guests = await db.user.findMany({
    where: { isGuest: true, createdAt: { gte: since } },
    select: { id: true, clerkId: true, email: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  // Bucket by yyyy-mm-dd HH:00. JS Date → ISO string slice to the hour.
  const buckets = new Map<string, number>();
  for (const g of guests) {
    const key = g.createdAt.toISOString().slice(0, 13) + ":00";
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const bucketRows = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1));

  const total = guests.length;
  const peakHour = bucketRows.reduce(
    (max, row) => (row[1] > max[1] ? row : max),
    ["—", 0] as [string, number],
  );

  return (
    <main id="main" className="max-w-5xl mx-auto px-6 py-12 space-y-8">
      <header className="space-y-2">
        <p className="eyebrow text-[var(--thoth-stone)]">Operator view</p>
        <h1 className="font-display text-3xl font-medium text-[var(--thoth-blue-ink)]">
          Guest provisioning — last 7 days
        </h1>
        <p className="text-sm text-[var(--thoth-stone)]">
          Reads <code className="font-mono">User where isGuest = true</code>{" "}
          since {since.toISOString().slice(0, 16).replace("T", " ")} UTC.
          Pair with <code className="font-mono">DEMO_DISABLED=1</code> in the
          deploy env to halt new provisioning if needed (see{" "}
          <Link
            href="https://github.com/ahmedEid1/thoth/blob/master/app/api/demo/start/route.ts"
            target="_blank"
            rel="noopener noreferrer"
            className="text-[var(--thoth-blue)] hover:underline underline-offset-4"
          >
            <code className="font-mono">app/api/demo/start/route.ts</code>
          </Link>
          ).
        </p>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Metric label="Guests (7d)" value={String(total)} />
        <Metric label="Peak hour" value={`${peakHour[1]} @ ${peakHour[0]}`} />
        <Metric
          label="Cleanup horizon"
          value="24h (cron every 6h)"
        />
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow text-[var(--thoth-stone)]">By hour (descending)</h2>
        {bucketRows.length === 0 ? (
          <p className="text-sm text-[var(--thoth-stone)] italic">
            No guests provisioned in the lookback window.
          </p>
        ) : (
          <div className="border border-[var(--thoth-rule)] rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--thoth-blue-mist)] text-[var(--thoth-blue-ink)]">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">UTC hour</th>
                  <th className="text-right px-3 py-2 font-medium">Guests</th>
                  <th className="text-left px-3 py-2 font-medium">Bar</th>
                </tr>
              </thead>
              <tbody>
                {bucketRows.map(([hour, count]) => (
                  <tr key={hour} className="border-t border-[var(--thoth-rule)]">
                    <td className="px-3 py-2 font-mono text-[var(--thoth-blue-ink)]">{hour}</td>
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-[var(--thoth-blue-ink)]">
                      {count}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2 rounded bg-[var(--thoth-blue)]"
                        style={{ width: `${Math.min(count, 20) * 12}px` }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="eyebrow text-[var(--thoth-stone)]">Most recent (top 25)</h2>
        {guests.length === 0 ? null : (
          <div className="border border-[var(--thoth-rule)] rounded-md overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-[var(--thoth-blue-mist)] text-[var(--thoth-blue-ink)]">
                <tr>
                  <th className="text-left px-3 py-2 font-medium">Created (UTC)</th>
                  <th className="text-left px-3 py-2 font-medium">Email</th>
                  <th className="text-left px-3 py-2 font-medium">Local id</th>
                  <th className="text-left px-3 py-2 font-medium">Clerk id</th>
                </tr>
              </thead>
              <tbody>
                {guests.slice(0, 25).map((g) => (
                  <tr key={g.id} className="border-t border-[var(--thoth-rule)]">
                    <td className="px-3 py-2 font-mono text-[var(--thoth-blue-ink)]">
                      {g.createdAt.toISOString().slice(0, 19).replace("T", " ")}
                    </td>
                    <td className="px-3 py-2 text-[var(--thoth-blue-ink)]">{g.email}</td>
                    <td className="px-3 py-2 font-mono text-[var(--thoth-stone)] text-xs">{g.id}</td>
                    <td className="px-3 py-2 font-mono text-[var(--thoth-stone)] text-xs">{g.clerkId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-[var(--thoth-rule)] rounded-md p-4">
      <p className="eyebrow text-[var(--thoth-stone)]">{label}</p>
      <p className="font-display text-2xl text-[var(--thoth-blue-ink)] mt-1">{value}</p>
    </div>
  );
}
