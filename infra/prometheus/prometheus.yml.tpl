global:
  scrape_interval: 30s
  scrape_timeout: 10s
  external_labels:
    service: pegasus-ads
    env: prod

scrape_configs:
  - job_name: pegasus-ads
    metrics_path: /api/metrics
    scheme: http
    static_configs:
      - targets:
          - pegasus-ads-green:3000
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/scrape-token

  - job_name: prometheus
    static_configs:
      - targets: ["localhost:9090"]
