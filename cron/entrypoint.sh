#!/bin/sh
set -e

# Bake CRON_SECRET into crontab if set
if [ -n "$CRON_SECRET" ]; then
  sed -i "s|http://0.0.0.0:3000/api/cron/|http://0.0.0.0:3000/api/cron/|g" /etc/crontabs/root
  # Add auth header to wget calls
  sed -i "s|wget -qO-|wget -qO- --header=\"Authorization: Bearer $CRON_SECRET\"|g" /etc/crontabs/root
fi

# Start crond in background
crond -b -l 2

# Start the app
exec node server.js
