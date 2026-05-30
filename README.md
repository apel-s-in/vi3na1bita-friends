# vi3na1bita-friends

Social layer (friends / chat / push / game invites) for vi3na1bita ecosystem.

- Deployed to Yandex Object Storage prefix `/Friends/`.
- Two layers: `friends-core.js` (data, no DOM) and `friends-ui.js` (UI).
- `friendId = "ya_" + sha256(yandexId)`. One Yandex account = one friend.
- Identity always comes from the host (no direct OAuth/token access).
- Presence and chat are polled only on demand, never in background.
