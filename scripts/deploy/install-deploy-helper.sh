#!/usr/bin/env bash
# Install trusted deployment tooling and configure the physical-path launcher.
# Does not restart the app or change backend credentials/Caddy configuration.
set -euo pipefail
if [[ $EUID != 0 ]]; then
  printf 'Run this installer as root.\n' >&2
  exit 2
fi
helper_source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test -f "$helper_source_dir/deploy-release.py"
test -x /usr/bin/python3
test -x /opt/community-connect/node/bin/node
test -x /opt/community-connect/node/bin/npm
test -d /opt/community-connect/app
test -f /etc/community-connect/backend.env
id community-connect >/dev/null 2>&1
install -d -o root -g root -m 0755 /usr/local/lib/community-connect-deploy /opt/community-connect/releases
install -d -o root -g root -m 0700 /var/lib/community-connect-deploy /var/lib/community-connect-deploy/incoming
install -o root -g root -m 0755 "$helper_source_dir/deploy-release.py" /usr/local/lib/community-connect-deploy/deploy-release.py.new
mv -f -- /usr/local/lib/community-connect-deploy/deploy-release.py.new /usr/local/lib/community-connect-deploy/deploy-release.py
cat > /usr/local/sbin/community-connect-deploy.new <<'WRAPPER'
#!/bin/sh
exec /usr/bin/python3 /usr/local/lib/community-connect-deploy/deploy-release.py "$@"
WRAPPER
chown root:root /usr/local/sbin/community-connect-deploy.new
chmod 0755 /usr/local/sbin/community-connect-deploy.new
mv -f -- /usr/local/sbin/community-connect-deploy.new /usr/local/sbin/community-connect-deploy
cat > /usr/local/sbin/community-connect-run.new <<'LAUNCHER'
#!/bin/sh
set -eu
resolved_entrypoint=$(readlink -f -- /opt/community-connect/app/calling-server.mjs)
test -f "$resolved_entrypoint"
exec /opt/community-connect/node/bin/node --env-file=/etc/community-connect/backend.env "$resolved_entrypoint"
LAUNCHER
chown root:root /usr/local/sbin/community-connect-run.new
chmod 0755 /usr/local/sbin/community-connect-run.new
mv -f -- /usr/local/sbin/community-connect-run.new /usr/local/sbin/community-connect-run
install -d -o root -g root -m 0755 /etc/systemd/system/community-connect.service.d
cat > /etc/systemd/system/community-connect.service.d/50-verified-launcher.conf.new <<'UNIT'
[Service]
ExecStart=
ExecStart=/usr/local/sbin/community-connect-run
UNIT
chown root:root /etc/systemd/system/community-connect.service.d/50-verified-launcher.conf.new
chmod 0644 /etc/systemd/system/community-connect.service.d/50-verified-launcher.conf.new
mv -f -- /etc/systemd/system/community-connect.service.d/50-verified-launcher.conf.new /etc/systemd/system/community-connect.service.d/50-verified-launcher.conf
systemctl daemon-reload
printf 'DEPLOY_HELPER_INSTALLED: trusted launcher configured; app and proxy not restarted; backend credentials untouched.\n'
