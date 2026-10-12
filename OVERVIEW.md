# Paseo Sprite Awake

A Paseo 0.11.2 plugin for Fly.io Sprites. It keeps working agents awake and grants a bounded hold after explicit user activity. Auto, Always and Off are host settings.

Agent and activity holds use separate five-minute tasks, renewed every minute while needed through the local Tasks API. No Fly.io token, network listener or page-load wake signal is used.

See [README.md](README.md) for installation, settings and deployment limits. Connection/wake handling belongs to a separate Service.
