# Paseo Sprite Awake

A [Paseo](https://github.com/getpaseo/paseo) plugin that keeps your [Fly.io Sprite](https://sprites.dev) awake while agents are working or you're actively using Paseo.

It prevents your Sprite from going to sleep mid-task, while still allowing it to suspend when idle.

## Install

Requires Paseo 0.11.x (minimum 0.11.2) running as a persistent Sprite Service.

Install directly from GitHub:

```bash
paseo plugin install github:edm1/paseo-sprite-awake
```

Or enter `github:edm1/paseo-sprite-awake` under **Settings → Plugins** in Paseo.

If the repository is private, your Sprite will need GitHub access.

Once installed, enable the plugin and open **Settings → Plugins → Paseo Sprite Awake** to configure it.

## How it works

- **Agent activity:** Keeps the Sprite awake while agents are working, with a 60-second grace period afterwards.
- **User activity:** Keeps the Sprite awake for 10 minutes after interactions such as typing, clicking or returning to the app.
- **Permission requests:** Stops keeping the Sprite awake after 10 minutes of unanswered permission requests, unless configured otherwise.
- **Manual control:** Keep the Sprite awake when needed from Paseo.

Choose between Auto, Always and Off modes. Timeouts can be adjusted in the plugin settings.

The plugin uses the Sprite's local Tasks API. No Fly.io API token or additional network ports are needed.

## Updates

```bash
paseo plugin update paseo-sprite-awake
```

## Uninstall

```bash
paseo plugin remove paseo-sprite-awake
```

## Notes

The plugin manages sleep prevention, not waking a Sprite that's already suspended. That is handled separately by your Sprite's connection service.

MIT licensed.
