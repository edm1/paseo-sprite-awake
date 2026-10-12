# Paseo Sprite Awake

Keep a Fly.io Sprite awake during Paseo agent work or recent user activity, then allow sleep.

## Install

Targets Paseo 0.11.2; requires `>=0.11.2 <0.12.0`, a persistent daemon Sprite Service and the local Tasks API at `/.sprite/api.sock`. No Fly.io token is needed. The plugin does not change daemon ports or open a network listener.

```sh
npm ci
npm test
npm run typecheck
paseo plugin install /absolute/path/to/paseo-sprite-awake
```

Enable the plugin, then open Settings > Plugins > Paseo Sprite Awake.

## Behaviour

In Auto mode:

- Working agents keep the Sprite awake, with a 60-second grace period after the last one stops.
- Unanswered permission requests stop counting after 10 minutes. No timeout (stay awake) removes that limit.
- Browser clicks, typing and scrolling, workspace/agent actions, mobile returns from background and the manual Keep awake action grant 10 minutes from the last interaction.

Durations are configurable. Disabled prevents user activity holds. Always keeps the agent hold active; Off releases both tasks and clears remembered activity.

The agent and user activity holds use separate tasks. Each has a five-minute lease renewed every minute while needed. Activity expiry cannot release agent protection. Other Sprite activity may still prevent suspension.

Page loads, initial client mount, quiet connections, relay presence, polling and reconnects do not grant activity holds. For native browsing or setup, use Keep Sprite awake for the activity window in the Command Center, or Keep awake now in plugin settings.

## Check And Remove

The settings screen reports confirmed tasks, the activity deadline, heartbeats and errors. On a live Sprite, check that sustained work renews its lease, activity expiry releases only the activity task, and Off releases both owned tasks. To remove:

```sh
paseo plugin disable paseo-sprite-awake
paseo plugin remove paseo-sprite-awake
```

## Limits

Waking a suspended Sprite belongs to the deployment's separate connection Service, not this plugin. After restart, agent discovery waits for a lifecycle hook or status RPC to supply the SDK; the previous lease may expire before then. Activity deadlines reset on cold restart. Native touches and questions not exposed as permission state are not fully observed.

Local tests do not replace live Sprite/Paseo/Android verification.

MIT licence.
