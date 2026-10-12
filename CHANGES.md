# Changes

## Unreleased

- Fixed bundled server-plugin startup by deriving owned task identity from `PASEO_HOME` (or the home directory) and the plugin ID instead of `import.meta.url`.

## 1.1.0 - Agent And User Activity Holds

- Removed the HTTP proxy, WebSocket observer, message allowlist, related settings/tests/docs and standalone review reports.
- Retained independent agent and user activity tasks: five-minute leases renewed every minute while needed, with no Fly.io token.
- User activity defaults to 10 minutes, configurable from 1 to 60 minutes or Disabled. Off clears remembered activity; disabled or expired activity cannot be revived by changing its duration.
- Browser trusted input, workspace/agent hooks, mobile foreground transitions and manual Keep awake remain. Page loads, initial mount, quiet connections, polling and reconnects do not grant activity holds.
- Corrected pending integration and unsupported-host status reporting.
- Added five-second SDK deadlines so stalled directory pages and refreshes can recover. Late subscription results are released and late snapshots cannot overwrite tracked work.
- Kept SDK 0.11.2 and the requirement `>=0.11.2 <0.12.0`. Connection/wake handling is left to a separate Service.

## Verification

Run `npm test` and `npm run typecheck`. Coverage includes lease renewal/release, independent task lifetimes, finite activity, input filtering, foreground transitions, settings ordering and SDK timeout recovery.

Live Sprite/Paseo/Android verification remains necessary. Agent discovery after restart needs a lifecycle hook or status RPC. Activity deadlines reset on cold restart, and not every native touch or question is observable.

## 1.0.0 - Waiting-Input Timeout

Added the configurable 10-minute default timeout for permission-blocked agents, followed by the normal 60-second grace period.
