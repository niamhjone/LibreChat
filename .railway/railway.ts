// FORK: Railway infrastructure for this fork's test site. See "Deployment" in FORK.md.
import { defineRailway, github, mongo, preserve, project, service, volume } from 'railway/iac';

export default defineRailway(() => {
  const db = mongo('mongo');
  // Railway creates the volume with the database. Mongo refuses to build indexes with under 500 MB
  // free, and LibreChat exits at startup when they fail, so the 500 MB default is too small.
  const dbVolume = volume('mongo-volume', {
    sizeMB: 5000,
    region: 'us-west2',
    allowOnlineResize: true,
  });

  const librechat = service('librechat', {
    source: github('jasonsims/LibreChat', { branch: 'deploy' }),
    build: { builder: 'DOCKERFILE', dockerfilePath: 'Dockerfile' },
    // Railway's defaults (restart on failure, never sleep) are stored as unset, so they aren't
    // written here. Keep sleep off: a cold start stalls each persona's first page load.
    deploy: { restartPolicyMaxRetries: 5 },
    // Exactly one replica: LibreChat's job and stream stores are in memory (no Redis).
    regions: { 'us-west2': 1 },
    healthcheck: '/health',
    healthcheckTimeout: 300,
    env: {
      MONGO_URI: db.env.MONGO_URL,
      // Matches the Dockerfile's EXPOSE and the public domain's target port.
      PORT: '3080',
      DOMAIN_CLIENT: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      DOMAIN_SERVER: 'https://${{RAILWAY_PUBLIC_DOMAIN}}',
      TRUST_PROXY: '1',
      NO_INDEX: 'true',

      // Email and password only, open sign-up, no email verification. The bots depend on this.
      ALLOW_EMAIL_LOGIN: 'true',
      ALLOW_REGISTRATION: 'true',
      ALLOW_UNVERIFIED_EMAIL_LOGIN: 'true',
      ALLOW_SOCIAL_LOGIN: 'false',
      ALLOW_SOCIAL_REGISTRATION: 'false',
      ALLOW_PASSWORD_RESET: 'false',

      // No Meilisearch service, so conversation search stays off.
      SEARCH: 'false',
      // Without Redis the agent scheduler only starts when told this is the sole replica (see regions).
      SCHEDULES_SINGLE_PROCESS: 'true',

      ANTHROPIC_API_KEY: preserve(),
      ANTHROPIC_MODELS: 'claude-haiku-5-5,claude-haiku-4-5,claude-sonnet-5-5,claude-opus-5-5',

      // Secrets are set once by hand (FORK.md) and kept out of source.
      JWT_SECRET: preserve(),
      JWT_REFRESH_SECRET: preserve(),
      CREDS_KEY: preserve(),
      CREDS_IV: preserve(),
      // Pendo's track event shared secret. Optional: without it the server sends no Track Events.
      PENDO_TRACK_EVENT_SECRET: preserve(),
    },
  });

  return project('librechat', { resources: [librechat, db, dbVolume] });
});
