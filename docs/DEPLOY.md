# Deploying this

## GitHub Pages cannot host this service

Worth stating plainly, because it is the obvious next move and it does not work.

Pages is a static file host. It serves HTML, CSS, JavaScript and images from a
directory — it never runs a process. This service is a process: it listens on a
port, holds a job queue in memory, retries failed generations on a timer, and
writes audio to disk. There is no arrangement of files that makes Pages do any of
that.

That is also why the site itself needs this service at all. `Petting-` is a static
export on Pages precisely because it has no server, which is what leaves it with
nowhere to keep an API key and no way to call an endpoint that refuses
cross-origin requests.

**Pages hosts the studio page. Something else has to host this.** The studio page
is already deployed with the rest of the site at `/studio/` — that part of the plan
works, and is done.

## Render — the shortest path

You already run `song-` there, so the account and the muscle memory exist.
`render.yaml` in this repo is set up the same way.

1. Render dashboard → **New** → **Blueprint** → pick this repo.
2. It reads `render.yaml` and creates the service.
3. Set the two secrets it deliberately does not commit:
   - `ACE_API_KEY` — your acemusic.ai key
   - `OPERATOR_TOKEN` — `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
4. Set `ALLOWED_ORIGINS` to `https://youssefalw2001.github.io` (add
   `http://localhost:3000` while developing).
5. Deploy, then open `/studio/` on the site and connect with the Render URL and the
   token.

### Two things about Render's free plan that will bite

**The filesystem is ephemeral.** `data/` is wiped on every deploy and every restart.
That means finished songs and the answers behind them disappear — for a service
whose whole job is producing something a customer paid for, that is a real problem
and not a theoretical one.

Three ways out, in increasing order of effort:

- **Download takes promptly.** Fine while volume is low. The studio has a Download
  button for exactly this. Fragile as a policy.
- **Attach a Render disk** (paid). One setting, mounted at `/data`; set
  `DATA_DIR=/data`. The honest answer once real customers exist.
- **Push audio to object storage** (S3, R2) after generation. The right shape
  eventually; more code than it's worth today.

**Free services sleep after inactivity.** First request after idling takes ~50
seconds to wake. Harmless for an operator tool — the studio will just look slow to
connect once — but do not read that first slow response as the ACE endpoint being
down.

## Anywhere else

There's a `Dockerfile`, so Fly.io, Railway, a VPS or a Raspberry Pi all work:

```bash
docker build -t tails-song-api .
docker run -p 8787:8787 --env-file .env -v "$PWD/data:/app/data" tails-song-api
```

The volume mount is the part that matters — without it you have the same ephemeral
disk problem as Render's free plan, just locally.

## Running it on your own machine

Genuinely reasonable for a while. The studio page on the live site can talk to
`http://localhost:8787` because the *browser* makes the request, not the server —
so the service only has to be reachable from your laptop, not from the internet.

```bash
npm install && npm run build && npm start
```

Then connect the studio to `http://localhost:8787`. Nothing is exposed, the key
never leaves your machine, and `data/` persists. The cost is that songs can only be
generated while your laptop is on, which is fine until it isn't.

One caveat: a page served over `https://` calling `http://localhost` is allowed by
browsers (localhost is a trusted origin), but a page served over `https://` calling
`http://some-other-host` is blocked as mixed content. So local works; a plain-HTTP
box on your network does not.

## When you move to your own GPU

Nothing about the deployment changes. Set:

```
MUSIC_PROVIDER=selfhosted
SELFHOSTED_BASE_URL=http://your-gpu-box:8001
SELFHOSTED_API_KEY=...
SELFHOSTED_AUDIO_FORMAT=wav
```

The ACE-Step server needs the GPU; this service does not, and can stay on a small
box. See the licensing note in [ACE-MUSIC-API.md](ACE-MUSIC-API.md#the-business-problem-nobody-upstream-answered)
for why that move matters before you charge anyone.
