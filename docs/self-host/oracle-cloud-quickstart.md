# Atlas self-host quickstart (Oracle Cloud Always Free)

> Status: M3.5c (shipped 2026-05-24). Companion to the cloud stack documented in the
> root [`README.md`](../../README.md). Pick this path if you want to own your
> deployment end-to-end instead of relying on Vercel + Neon + R2 + Langfuse Cloud.

## What you get

- A single Oracle Cloud Ampere A1 VM — **4 ARM cores + 24 GB RAM, free forever**, no
  credit card required after the initial account verification.
- Atlas (Next.js) + Postgres 17 + MinIO + self-hosted Langfuse all running behind
  Caddy with auto-renewing Let's Encrypt TLS.
- ~5 minutes/month of maintenance once the cron jobs are wired up.

## What you still need (cloud, not self-hosted)

| Piece | Why | Free tier |
|---|---|---|
| Mistral API key | LLM + PDF OCR. Self-hosting LLM on Oracle's ARM free tier is not viable (no GPU). | `Experiment` tier on https://console.mistral.ai covers small-scale use. |
| Clerk Cloud (auth) | Atlas's auth/middleware uses `@clerk/nextjs`. Swapping to a self-hostable auth (e.g. NextAuth + Postgres) is a future M3.5d refactor — not in this scope. | Free 10K MAU. |
| (Optional) Trigger.dev Cloud | Background jobs. Atlas defaults to Trigger.dev Cloud; self-hosting it is documented as an advanced step at the bottom. | Free 500K runs/mo. |
| Domain name | TLS, Clerk redirects, OAuth callbacks. | ~€10/yr; you probably already have one. |

Total recurring cost: **$0/month** + domain renewal.

## Prerequisites

- Oracle Cloud account — sign up at https://cloud.oracle.com (phone + email
  verification, ~10 min). After verification, the Always Free tier is automatic.
- A domain you control + access to its DNS.
- An SSH key pair on your local machine (`ssh-keygen -t ed25519` if you don't have one).
- About 45-60 min for the full walkthrough.

---

## Step 1 — Provision the Ampere A1 instance (~10 min)

In the Oracle Cloud console (https://cloud.oracle.com):

1. **Menu → Compute → Instances → Create Instance.**
2. **Name:** `atlas`.
3. **Image:** click *Edit* on the image row → *Change image* → pick **Canonical
   Ubuntu 22.04 (Minimal)** for `aarch64`.
4. **Shape:** click *Edit* → *Change shape* → **Ampere → VM.Standard.A1.Flex** →
   OCPUs: **4**, Memory: **24 GB**. (This is the maximum Always-Free allocation;
   you can split it across multiple smaller VMs later if you prefer.)
5. **Networking:** keep the default VCN/subnet, *Assign a public IPv4 address* ✓.
6. **SSH key:** *Paste public keys* → paste the contents of your `~/.ssh/id_ed25519.pub`.
7. **Boot volume:** leave default (50 GB; Always Free includes 200 GB total block storage).
8. Click **Create**. Wait ~60 seconds for state to flip from PROVISIONING to RUNNING.
9. Copy the **Public IPv4 Address** from the instance details page — you'll need it next.

### Open the firewall

By default the Always-Free VCN only allows SSH (:22). You need to open :80 and :443.

1. From the instance page, click the **Subnet** link → **Default Security List**.
2. **Add Ingress Rule** ×2:
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port Range **80**.
   - Source CIDR `0.0.0.0/0`, IP Protocol **TCP**, Destination Port Range **443**.
3. SSH into the instance and **also** open the host firewall (Ubuntu's `iptables`
   ships with a deny-all default on Oracle images — this catches everyone the first time):
   ```bash
   ssh ubuntu@<your-public-ip>
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
   sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
   sudo netfilter-persistent save
   ```

---

## Step 2 — Point DNS at the instance

In your DNS provider (Cloudflare, Namecheap, Route53, whatever):

- `A` record: `your-domain.com` → `<your-public-ip>`
- `A` record: `langfuse.your-domain.com` → `<your-public-ip>` (only if you want
  the tracing dashboard on its own subdomain)

Wait 5-30 min for propagation. Verify with `dig +short your-domain.com` from
your laptop — should print the Oracle IP. If you don't get this right *before*
the first boot, Caddy's ACME challenge will fail and you'll be debugging TLS.

---

## Step 3 — Install Docker on the VM

```bash
ssh ubuntu@<your-public-ip>

sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu

# Log out and back in so the group change applies.
exit
ssh ubuntu@<your-public-ip>

docker --version             # sanity check
docker compose version       # should be >=2.x
```

Optional but recommended:

```bash
# Set up automatic security updates so you don't have to patch manually.
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure --priority=low unattended-upgrades

# Configure Docker log rotation so containers don't fill the disk.
sudo tee /etc/docker/daemon.json > /dev/null <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
EOF
sudo systemctl restart docker
```

---

## Step 4 — Clone Atlas and configure

```bash
sudo mkdir -p /opt/atlas
sudo chown ubuntu:ubuntu /opt/atlas
cd /opt/atlas

git clone https://github.com/ahmedEid1/atlas.git
cd atlas/infra/self-host

cp .env.prod.example .env.prod

# Generate strong secrets — paste each value into .env.prod where the comment says.
openssl rand -base64 32        # use for *_PASSWORD, *_NEXTAUTH_SECRET, *_SALT
openssl rand -hex 32           # use for LANGFUSE_ENCRYPTION_KEY (must be 64 hex chars)

nano .env.prod                 # set DOMAIN, ACME_EMAIL, all CHANGE_ME_* values,
                               # CLERK_*, MISTRAL_API_KEY, TRIGGER_*.
```

Things to double-check before bringing up the stack:

- `DOMAIN` matches what your DNS points at.
- `DATABASE_URL` password matches `POSTGRES_PASSWORD` (they appear twice on purpose;
  if they drift, Atlas can't connect to its own DB).
- `LANGFUSE_ENCRYPTION_KEY` is exactly 64 hex chars. The Langfuse container
  refuses to start otherwise.
- The Clerk dashboard for this app lists `https://your-domain.com` as an allowed
  origin and `https://your-domain.com/api/webhooks/clerk` as the webhook URL.

---

## Step 5 — Bring up the stack

```bash
cd /opt/atlas/atlas/infra/self-host

# First boot — the Atlas image has to build (~5-8 min on Ampere A1).
docker compose -f docker-compose.prod.yml up -d --build

# Tail the Atlas logs to watch migrations + first-boot init.
docker compose -f docker-compose.prod.yml logs -f atlas
```

Expect this rough sequence in the logs:

1. Postgres healthcheck goes green (~5 s)
2. MinIO healthcheck goes green (~5 s)
3. `prisma migrate deploy` runs and applies every migration in `prisma/migrations/`
4. `next start` boots on :3000
5. Caddy fetches the LE cert (~30 s on the first run; nothing on subsequent boots
   because certs are stored in the `caddydata` volume)

Once everything is up:

```bash
docker compose -f docker-compose.prod.yml ps   # all services should be "Up (healthy)"
```

### Create the S3 bucket

MinIO doesn't auto-create the `atlas-corpus` bucket. Do it once:

```bash
docker compose -f docker-compose.prod.yml exec minio sh -c \
  "mc alias set local http://localhost:9000 $S3_ACCESS_KEY_ID $S3_SECRET_ACCESS_KEY && \
   mc mb -p local/atlas-corpus"
```

(Or use the MinIO console — temporarily expose port 9001 by editing the compose
file, or add a `minio.{$DOMAIN}` route in the Caddyfile.)

---

## Step 6 — Verify

- Visit `https://your-domain.com` — should show the Atlas sign-in screen.
- Sign up with Clerk, create a project, upload a small PDF, click *Start Review*.
- Watch the progress in the UI; expect ~2-4 min for a single-paper review on Ampere A1.
- Visit `https://langfuse.your-domain.com` — log in with the
  `LANGFUSE_INIT_USER_EMAIL` / `LANGFUSE_INIT_USER_PASSWORD` from `.env.prod`.
  Every LLM call from the review should appear as a trace.

If the review fails:

- Check `docker compose logs atlas` for app errors.
- Check `docker compose logs langfuse-worker` if traces aren't appearing.
- If Trigger.dev jobs aren't running, confirm `TRIGGER_PROJECT_REF` /
  `TRIGGER_SECRET_KEY` point at a deployed Trigger.dev project (`pnpm trigger:deploy`
  from your laptop after editing `.env.prod`).

---

## Maintenance

### Weekly — backups

Edit the host crontab:

```bash
crontab -e
```

Add:

```
0 3 * * * cd /opt/atlas/atlas/infra/self-host && ./backup-postgres.sh >> /var/log/atlas-backup.log 2>&1
```

The script (`infra/self-host/backup-postgres.sh`) writes timestamped gzipped dumps
to `./backups/` and prunes anything older than 14 days. Restore with:

```bash
gunzip -c backups/atlas-2026-05-24_030000Z.sql.gz | \
  docker compose exec -T postgres psql -U atlas -d atlas
```

For off-site backup, `rsync` the `./backups` folder somewhere (B2, R2, an
external host you trust).

### Monthly — updates

```bash
cd /opt/atlas/atlas
git pull
cd infra/self-host
docker compose -f docker-compose.prod.yml pull          # pulls upstream images
docker compose -f docker-compose.prod.yml up -d --build # rebuilds Atlas, applies migrations
```

Compose does a rolling restart per service. Total downtime is typically <30 s.

### Disk usage

ARM A1 ships with a 50 GB boot volume. Watch it with `df -h`. The Always-Free
allowance gives you up to 200 GB of block storage — if you outgrow 50 GB,
expand the boot volume from the console (no instance restart needed for the
expand step; you still need to run `growpart` + `resize2fs` after).

---

## Trigger.dev self-host (optional, advanced)

By default this setup uses Trigger.dev Cloud — free 500K runs/mo, more than enough
for everything short of a public launch. If you want full sovereignty:

- Follow https://github.com/triggerdotdev/self-hosted-trigger.dev.
- It adds ~5 more services (the trigger orchestrator + its own Postgres + Redis +
  Electric). Run it alongside Atlas's compose (separate `docker-compose.yml`; the
  shared Docker network handles cross-stack DNS).
- Add a `trigger.{$DOMAIN}` route to the Atlas `Caddyfile`, pointing at the
  trigger orchestrator service.
- Set `TRIGGER_API_URL=https://trigger.your-domain.com` in `.env.prod` and
  re-deploy your trigger tasks (`pnpm trigger:deploy --self-hosted`).

Out of scope for this quickstart — covered in the upstream Trigger.dev cookbook.

---

## Cost

| Item | Cost |
|---|---|
| Oracle Cloud Ampere A1 (4 OCPU + 24 GB RAM + 50 GB block) | **$0/month forever** |
| Domain | ~€10/year |
| Mistral API (LLM + OCR) | $0 on Experiment tier; ~$0.02/review on paid |
| Clerk Cloud (auth) | $0 (10K MAU free) |
| Trigger.dev Cloud (jobs) | $0 (500K runs/mo free) |
| **Total** | **$0/mo + domain** |

For comparison, the equivalent stack on cloud-managed services starts to cost
real money once you exceed any of: Vercel's 100 GB-h function time, Neon's 0.5 GB
storage, R2's 10 GB egress, or Langfuse Cloud's 50K observations/mo. This
self-host setup is the escape valve for any of those.

---

## When to NOT self-host

- You want <10 min setup → use the cloud stack documented in the root README.
- You only run occasional demos → Vercel Hobby is plenty.
- You're worried about Oracle Cloud's terms-of-service changes (rare but possible
  — they have reclaimed idle Always-Free VMs in the past) → use the cloud stack
  and treat the Oracle option as a 60-min DR plan.

## When self-host wins

- You're consistently hitting Vercel function timeout limits.
- You're hitting Neon's 0.5 GB ceiling or Langfuse's 50K obs/mo cap.
- Data sovereignty requirements (EU research labs, regulated industries).
- You want to be able to say "I own my deployment end-to-end."

---

## File reference

Everything lives under `infra/self-host/`:

| File | Purpose |
|---|---|
| `docker-compose.prod.yml` | The full stack (Caddy, Atlas, Postgres, MinIO, Langfuse). |
| `Caddyfile` | Reverse-proxy + auto-TLS config. Uses `{$DOMAIN}` from env. |
| `Dockerfile` | Multi-stage Node-22 build for the Atlas app. No Python (Mistral OCR). |
| `.env.prod.example` | Production env template — `cp` to `.env.prod` and edit. |
| `backup-postgres.sh` | Cron-runnable Postgres dump with 14-day retention. |
