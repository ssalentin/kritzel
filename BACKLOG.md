# Backlog

Ideas and feature requests that aren't scoped work yet. The kritzel-development
team's lead triages these into missions/slices when there's room; nothing here
is a commitment or a priority order.

- **Camera selection (local + network).** Let the user choose which camera feeds
  the viewer, instead of the hardcoded `/dev/video2` default in
  `scripts/start.sh`. Should cover both local `/dev/video*` devices and cameras
  reachable over the network (e.g. discoverable via Tailscale), not just local
  ones. Raised by Sebastian via advisor-lead@kernel on 2026-10-15. Not blocking
  the initial pipeline build; natural home is wherever the capture-side work
  ends up (capture-build, as of this writing).
