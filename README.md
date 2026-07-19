# vi3na1bita-friends

Social layer (friends / chat / push / game invites) for vi3na1bita ecosystem.

- Deployed to Yandex Object Storage prefix `/Friends/`.
- Two layers: `friends-core.js` (data, no DOM) and `friends-ui.js` (UI).
- `friendId` is assigned only by `vi3-signaling` after server-side Yandex OAuth verification.
- The host passes a short-lived signed social session to `FriendsCore`; the Yandex OAuth token never enters this repository.
- Identity always comes from the host. Requests without a valid social session are rejected.
- Presence and push polling run only while Friends is active and visible. Chat/voice polling runs only while its modal is open.
- Production authentication uses `ALLOW_LEGACY_AUTH=0`; legacy `clientSecret` authentication is unsupported.
