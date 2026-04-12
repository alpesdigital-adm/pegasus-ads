#!/bin/bash
/usr/bin/docker stop pegasus-ads 2>/dev/null || true
/usr/bin/docker rm pegasus-ads 2>/dev/null || true
/usr/bin/docker run -d --name pegasus-ads --restart unless-stopped   --env-file /apps/pegasus/.env   --network easypanel   --label traefik.enable=true   --label 'traefik.http.routers.pegasus-http.rule=Host(`pegasus.alpesd.com.br`)'   --label traefik.http.routers.pegasus-http.entrypoints=http   --label 'traefik.http.routers.pegasus-https.rule=Host(`pegasus.alpesd.com.br`)'   --label traefik.http.routers.pegasus-https.entrypoints=https   --label traefik.http.routers.pegasus-https.tls=true   --label traefik.http.routers.pegasus-https.tls.certresolver=letsencrypt   --label traefik.http.services.pegasus-ads.loadbalancer.server.port=3000   pegasus-ads:latest
