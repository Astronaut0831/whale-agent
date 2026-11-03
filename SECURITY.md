# Security

## Reporting

Do not open a public issue for a vulnerability. Report privately to the repository owner, with:

- affected component (adapter / memory / bridge / GUI plugin)
- reproduction steps
- whether it exposes data, tokens, or the host filesystem

## Secrets

Never commit:

- `config.json`
- `data/`
- DSH profiles
- logs / SQLite / backup bundles
- `.env`

`config.example.json` contains placeholders only. If a real key was ever committed or shared, rotate it at the provider; deleting the file is not enough.

## Local exposure

- bridge/adapter/memory services are loopback by default
- `/api/gui/input` requires the GUI token and loopback
- `/run` is owner-only, writes only under the configured workspace, and has a 15s timeout
- normal headless profile has no filesystem tools
- `whale-headless-task` is the only profile with workspace fs tools

## Supported

This is a personal, Windows-first project. Security fixes target the current `main` branch; legacy `server.js` is unsupported unless explicitly started with `WHALE_LEGACY=1`.
