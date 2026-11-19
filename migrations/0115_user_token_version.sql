-- Server-side session revocation. Every access and refresh token carries
-- the user's token_version at the time it was issued (claim `tv`), and
-- requireAuth / POST /auth/refresh / the socket handshake reject tokens
-- whose `tv` no longer matches. Logging out bumps the version, so a stolen
-- refresh token stops working immediately instead of staying valid until it
-- expires. Starts at 0, which is also what tokens issued before this
-- migration (no `tv` claim) are treated as, so existing sessions carry on.
ALTER TABLE users
  ADD COLUMN token_version INT NOT NULL DEFAULT 0;
