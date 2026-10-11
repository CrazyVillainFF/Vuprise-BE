# Production feature configuration

The web client is deployed on Vercel, while the API is an Express service described by `render.yaml`. Server-only credentials must be configured on the API service, not in `VITE_*` variables.

## Password recovery (Resend)

- Set `RESEND_API_KEY` in the Render API service environment. Keep it secret and do not add it to Vercel client variables.
- Set `PASSWORD_RESET_PEPPER` to a long, random server-only secret. The Render blueprint generates one when it creates the service.
- Set `CLIENT_URL` to `https://nexora-lac-three.vercel.app` (the blueprint default) or the actual client origin.
- The sender is `onboarding@resend.dev`. Resend restricts this sender to permitted test recipients until a sending domain is verified; this project does not claim unrestricted delivery.

## Video processing

The API requires `ffmpeg` and `ffprobe` in `PATH`. The Render build command installs FFmpeg. For another host, install FFmpeg or set `FFMPEG_PATH` and `FFPROBE_PATH`. Videos are probed and transcoded on the API; the server rejects any requested clip longer than 35 seconds.

## Group and upload storage

Group and post records use the existing MongoDB connection. Configure the existing Cloudinary credentials for persistent production media storage; otherwise media is stored in the API's local `uploads` directory and may not survive an ephemeral-host restart.
