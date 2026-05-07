# Production Deployment Notes

This folder contains examples for the final production launch on one EC2 instance.

## EC2 layout

```text
/opt/ticket-api
  docker-compose.yml
  .env
  data/database.sqlite

/opt/sentry
  self-hosted Sentry stack
```

Keep the API `.env` only on EC2. Do not commit real secrets.

## Manual API deploy

```bash
sudo mkdir -p /opt/ticket-api
sudo chown -R "$USER":"$USER" /opt/ticket-api
git clone https://github.com/phone292025/high-demand-ticket-reservation-backend.git /opt/ticket-api
cd /opt/ticket-api
cp .env.example .env
mkdir -p data
docker compose up -d --build
docker compose run --rm api node dist/scripts/run-migrations.js
```

Seed only when the production database is empty:

```bash
docker compose run --rm api node dist/scripts/seed.js
```

Back up SQLite before major deploys:

```bash
cp /opt/ticket-api/data/database.sqlite /opt/ticket-api/data/database.sqlite.backup.$(date +%Y%m%d%H%M%S)
```

Do not run `docker compose down -v` in production because it can delete persistent data.

## Nginx and HTTPS

Copy the Nginx examples into `/etc/nginx/sites-available/`, replace placeholder domains, enable them, then run Certbot.

```bash
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d your-name.int.yt
sudo certbot --nginx -d sentry-your-name.int.yt
```

Expected public routes:

```text
https://your-name.int.yt/api/v1
https://your-name.int.yt/docs
https://sentry-your-name.int.yt
```
