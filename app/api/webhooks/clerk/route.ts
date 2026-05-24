import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";

// Webhook payload uses snake_case (see @clerk/backend UserJSON).
type UserEventData = {
  id: string;
  email_addresses: Array<{ id: string; email_address: string }>;
  primary_email_address_id: string | null;
  public_metadata?: Record<string, unknown> | null;
};

function primaryEmail(data: UserEventData): string {
  const primary = data.email_addresses.find((e) => e.id === data.primary_email_address_id);
  return primary?.email_address ?? data.email_addresses[0]?.email_address ?? `${data.id}@pending.local`;
}

function isGuestFromMetadata(data: UserEventData): boolean {
  return data.public_metadata?.isGuest === true;
}

export async function POST(req: NextRequest) {
  try {
    const evt = await verifyWebhook(req);

    if (evt.type === "user.created" || evt.type === "user.updated") {
      const data = evt.data as UserEventData;
      const isGuest = isGuestFromMetadata(data);
      const email = primaryEmail(data);
      await db.user.upsert({
        where: { clerkId: data.id },
        create: { clerkId: data.id, email, isGuest },
        update: { email, isGuest },
      });
    } else if (evt.type === "user.deleted") {
      const data = evt.data as { id: string };
      await db.user.delete({ where: { clerkId: data.id } }).catch(() => null);
    }

    return new Response("ok", { status: 200 });
  } catch (err) {
    console.error("[clerk webhook] verify failed", err);
    return new Response("bad signature", { status: 400 });
  }
}
