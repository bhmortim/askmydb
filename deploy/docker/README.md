# Resilient LLM-share deployment (Docker)

Runs the askmydb auth proxy + a Cloudflare tunnel as always-on containers, so a
friend can use your LM Studio over the internet without you babysitting a
terminal. Your GPU box (running LM Studio) and the Docker host can be different
machines on the same LAN.

## What runs where

```
Friend's askmydb ──HTTPS──▶ llm.yourdomain.com (Cloudflare)
                                   │
                        Docker host │  (always-on containers)
                        ┌──────────▼───────────┐
                        │ cloudflared           │  serves the hostname
                        │      │ http://proxy:1235
                        │ proxy (auth: key)     │  requires the shared key
                        └──────────┬───────────┘
                                   │ http://<gpu-box>:1234
                          LM Studio on your GPU box
```

## One-time setup

1. **Create the tunnel** (on any machine with `cloudflared` logged in):
   ```
   cloudflared tunnel create askmydb-llm
   cloudflared tunnel route dns askmydb-llm llm.yourdomain.com
   ```
   This writes `~/.cloudflared/<TUNNEL-ID>.json`.

2. **Make LM Studio reachable from the Docker host.** On the GPU box, serve it on
   the LAN: `lms server start --port 1234 --bind 0.0.0.0` (or the "Serve on Local
   Network" toggle). Lock it down so **only the Docker host** can reach it — e.g.
   on Windows (run as Administrator):
   ```
   New-NetFirewallRule -DisplayName "LM Studio (docker host only)" -Direction Inbound `
     -Action Allow -Protocol TCP -LocalPort 1234 -RemoteAddress <DOCKER-HOST-IP>
   ```
   and scope/disable any broader LM Studio inbound rules.

3. **Assemble this folder on the Docker host:**
   - `docker-compose.yml` (this dir)
   - `share-llm.js` (copy from the repo's `tools/share-llm.js`)
   - `config.yml` (from `config.example.yml`, with your tunnel id + hostname)
   - `creds.json` (the `<TUNNEL-ID>.json` from step 1)
   - `.env` (from `.env.example`: the shared key + your GPU box URL)

4. **Start it:**
   ```
   docker compose up -d
   docker compose logs -f          # watch it register
   ```

## Give your friend access

Their askmydb `config.json`:
```json
{ "llm": { "baseUrl": "https://llm.yourdomain.com/v1", "apiKey": "<the shared key>", "model": "<your model id>" } }
```

## Operating it

- **Restart / update:** `docker compose up -d` (pulls new images if any).
- **Rotate the key:** edit `.env`, then `docker compose up -d` — and update the
  friend's config with the new key.
- **Resilience:** both containers use `restart: unless-stopped`, so they come back
  after a crash or a host reboot. (LM Studio itself must be running on the GPU box
  — that's the one piece that depends on that machine being up.)

> Never point the tunnel straight at LM Studio (port 1234). The proxy — which
> requires the key — must be the only thing the tunnel reaches.
