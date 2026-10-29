#!/usr/bin/env bash
# Install trusted host tooling only. Does not restart or reconfigure the app.
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
printf 'DEPLOY_HELPER_INSTALLED: app and proxy were not restarted or reconfigured.\n'
