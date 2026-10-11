# Production feature configuration

The web client is deployed on Vercel, while the API is an Express service described by `render.yaml`. Server-only credentials must be configured on the API service, not in `VITE_*` variables.

## Password recovery (Brevo email OTP)

- The user enters their email, receives a six-digit code, then submits that code with a new password. The code is cryptographically generated, stored only as a peppered HMAC digest, expires in 10 minutes, allows at most five wrong attempts, and is invalidated when used.
- Requests for known and unknown accounts return the same generic confirmation. Brevo delivery rejection is reported as an error instead; the temporary code is invalidated and the backend does not pretend that delivery succeeded.
- Set `BREVO_API_KEY` in the Render API service environment. The server sends through Brevo's transactional HTTP endpoint (`POST https://api.brevo.com/v3/smtp/email`) using the `api-key` header; SMTP is not used. Keep the API key secret and do not add it to Vercel client variables.
- Set `PASSWORD_RESET_PEPPER` to a long, random server-only secret. The Render blueprint generates one when it creates the service. Do not change it after codes are issued; it is used to verify the stored digests.
- `PASSWORD_RESET_FROM` is the verified Brevo sender address and defaults to `vupriseofficial@gmail.com`. Configure it on the Render backend only, never in a `VITE_*` variable. Brevo must show this sender as verified and allow transactional email sending for the account.
- `CLIENT_URL` remains the deployed frontend origin (`https://nexora-lac-three.vercel.app`) for the application, but the OTP flow does not place a reset token or link in email.
- If Brevo rejects the sender, recipient, or request, the API returns an error and invalidates the temporary code. Backend logs contain only a safe error category, not the recipient, OTP, API key, request headers, or provider response body.
- A successful Brevo API response means the provider accepted the send request, not that the message reached the recipient's inbox. Verify actual delivery to an intended recipient before treating end-to-end delivery as confirmed.
- On Render, configure `BREVO_API_KEY`, `PASSWORD_RESET_FROM=vupriseofficial@gmail.com`, and `PASSWORD_RESET_PEPPER`; retain the existing `CLIENT_URL=https://nexora-lac-three.vercel.app` application setting. Redeploy the backend after changing environment values. The client only needs its existing API URL; the Brevo key must never be configured in Vercel.

## Direct video uploads

- Configure `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, and `CLOUDINARY_API_SECRET` on the Render API service. The API key and cloud name are returned to an authenticated browser as provider identifiers; the API secret is only used on the server to sign a per-upload authorization.
- The browser uploads video bytes directly to Cloudinary. The API receives only a small signing request and a small publish request; video bytes are never posted to Render. The existing image and text post routes remain available.
- The application accepts MP4, WebM, or MOV sources up to 250 MB and validates the stored Cloudinary resource format, byte count, owner/session context, and actual source duration before publishing. The selected trim range must be at most 35 seconds; the published Cloudinary delivery URL applies that range server-side, so client duration values are not trusted for the saved media.
- In Cloudinary Console, keep the account's maximum upload size at or below 250 MB (or the lower limit of your plan) and monitor storage/transformation quotas. Cloudinary account/plan limits are the provider-side protection during transfer; the application also rejects and deletes oversized uploaded resources when finalizing.
- Deploy the MongoDB `VideoUploadSession` collection and the unique sparse `Post.videoUploadSession` index. Mongoose creates declared indexes when automatic index creation is enabled; where it is disabled, run `VideoUploadSession.createIndexes()` and `Post.createIndexes()` once using the API's normal MongoDB credentials.
- Abandoned assets are removed by a periodic cleanup task after 24 hours. Verify that the Render service remains running long enough for the cleanup schedule, or schedule the same exported cleanup function as a Render cron job for stricter cleanup guarantees.
- FFmpeg is no longer needed by the video publish path; it is not required by the API deployment.

## Group and upload storage

Group profiles and group messages use the existing MongoDB connection. Group messages are scoped to group membership on every read and write, and are indexed by group and creation time for pagination. The connection model uses a canonical pair-key unique index to prevent duplicate requests in opposing directions. Mongoose builds these declared indexes when automatic index creation is enabled; for managed production databases where `autoIndex` is disabled, deploy and run `Connection.createIndexes()` and `GroupMessage.createIndexes()` once using the API's normal MongoDB credentials. Configure the existing Cloudinary credentials for persistent production media storage; otherwise images are stored in the API's local `uploads` directory and may not survive an ephemeral-host restart.
