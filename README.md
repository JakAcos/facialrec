![Facial Recognition Poster](https://raw.githubusercontent.com/Shetshay/facialrec/master/facialrec_poster.png)

# FacialRec

Cloud file storage that needs two things before it shows a single file:
your Google account, and a live check of your face.

## How it fits together

```
Browser (Next.js, hosted on Railway)
   |  sign-in, queries, mutations (realtime)
   v
Convex  ---- database, Google sign-in, every backend rule
   |                   |
   | signed URLs       | server-to-server, shared secret
   v                   v
Railway bucket      Face service (Python, hosted on Railway)
(files and videos)  detects, measures and embeds faces
```

| Folder | What it is |
|---|---|
| `web/` | Next.js app. `web/convex/` holds the whole backend as TypeScript functions. |
| `face-service/` | Stateless Python service that turns camera frames into measurements. |

Why it is split this way:

- **Convex is the only place that makes decisions.** The browser cannot be
  trusted and the face service only measures, so every rule (who owns a file,
  whether a face matched, how much storage is left) lives in `web/convex/`.
- **File bytes never pass through a server.** Convex signs a short-lived URL
  and the browser uploads to and downloads from the bucket directly.
- **The face service keeps nothing.** It receives frames, returns numbers and
  forgets them. Only Convex stores face data, encrypted.

## How the face check works

1. After Google sign-in the session is still locked. The backend refuses
   every file request until the face check passes
   (`web/convex/lib/access.ts`).
2. Convex issues a challenge: look straight, then turn your head left or
   right. The server picks the direction at random.
3. The browser tracks the face with MediaPipe to coach the user ("move
   closer", "turn left") and takes one frame per pose. This step is only for
   guidance.
4. Convex sends the frames to the face service, which reports for each one:
   how many faces, which way the head is turned, a liveness score, and a
   512-number ArcFace embedding.
5. Convex decides (`web/convex/lib/faceDecision.ts`):
   - each frame shows exactly one clear face
   - the head really turned the way the challenge asked
   - the anti-spoofing model thinks the straight-on frame is a live face
   - all frames show the same person
   - the embeddings match the enrolled templates
6. On success that login session is unlocked for 12 hours. Five failed
   attempts in ten minutes lock the account for the rest of that window.

Enrollment is the same flow with three poses (straight, left, right). The
three embeddings are stored AES-256-GCM encrypted. Photos are never stored.

### Why a head turn

A printed photo or a still image on a screen cannot turn its head. Tilting a
flat photo squeezes the whole face evenly, so the nose stays centred between
the eyes, and the measured turn stays at zero. A real head moves the nose
relative to the eyes. The test suite proves both cases.

### Accuracy

`face-service/eval/lfw_eval.py` runs the exact production pipeline over the
public LFW benchmark. The measured error rates for each match threshold are
in [`face-service/eval/LFW_REPORT.md`](face-service/eval/LFW_REPORT.md).

### Known limits

- A good video replay of the owner turning their head the right way could
  pass the head-turn test. The anti-spoofing model is the defence against
  screens, and it is not perfect. This is a strong second factor on top of
  Google sign-in, not a replacement for it.
- There is no recovery path if your face stops matching (for example after
  a big change in appearance). Replace your enrolled face from the Account
  page while you are still signed in.
- The pretrained InsightFace models are licensed for non-commercial research
  use only.

## Running it locally

You need Node 22, Python 3.12 with [uv](https://docs.astral.sh/uv/), ffmpeg,
a Convex account and a Railway project with a bucket.

```bash
# Backend and website
cd web
npm install
npx convex dev            # creates web/.env.local and pushes the functions
npm run dev               # http://localhost:3000

# Face service
cd face-service
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements-dev.txt
.venv/bin/python scripts/download_models.py models
FACE_SERVICE_SECRET=dev-secret .venv/bin/uvicorn app.main:app --port 8000
```

Convex runs in the cloud, so it can only reach a face service that has a
public URL. The simplest setup is to point the dev deployment at the face
service on Railway.

Convex environment variables are set by `web/scripts/setup-convex-env.mjs`
(the header of that file lists its inputs). Browser access to the bucket is
allowed by `web/scripts/set-bucket-cors.mjs`.

## Tests

```bash
cd web
npm test                  # backend rules, with a simulated Convex
npm run test:e2e          # real browser, real camera pipeline (see below)
npm run typecheck && npm run lint

cd face-service
.venv/bin/python -m pytest
.venv/bin/python eval/lfw_eval.py   # accuracy report, takes a while
```

The end-to-end tests drive Chrome with a video file standing in for the
webcam, so frames go through the real path: camera, in-browser tracker,
Convex, the face service on Railway and the bucket. They need
`E2E_FACE_VIDEO`, a short private video of one person looking at the camera
and turning their head (default `~/facialrec-data/face_enroll.mov`). That
video is never committed.

They cover: enrolling, uploading and previewing files, folders, moving,
renaming, zip download, locking, signing back in, a different live person
being rejected, a still photo being rejected (both by the page and by the
server when the page is bypassed), and account deletion.

Google blocks automated browsers, so the tests sign in with a password
login that only exists when `ENABLE_TEST_LOGIN=true`. That is set on the dev
deployment and never on production.

## Deploying

- **Convex:** `cd web && npx convex deploy`
- **Railway `web` service:** root directory `/web`, with
  `NEXT_PUBLIC_CONVEX_URL` set to the production Convex URL.
- **Railway `face` service:** root directory `/face-service`, built from its
  Dockerfile, with `FACE_SERVICE_SECRET` set to the same value as in Convex.
- **Google OAuth:** the authorised redirect URI is
  `https://<deployment>.convex.site/api/auth/callback/google`.
