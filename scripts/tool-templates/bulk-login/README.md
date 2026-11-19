# bulk-login tool template

Logs in a list of **dedicated test accounts** against a test environment you own,
with bounded concurrency and a global request-rate cap. It reads JSON from stdin
and writes a JSON summary to stdout; it never prints passwords or tokens.

Use it when a task genuinely repeats logins (for example, seeding test accounts
or checking a login regression across roles). Do not use it to attack, scrape or
brute-force a system you do not own.

## Install into a workspace

```bash
mkdir -p .pilot/tools/bulk-login
cp scripts/tool-templates/bulk-login/* .pilot/tools/bulk-login/
```

Then ask Pilot to call `register_tool` with `name: "bulk-login"`. Registration
runs `test.js`; only a passing test approves the tool. Any edit to `tool.json`,
`main.js` or `test.js` revokes approval until it is registered again.

## Authorized targets

`main.js` refuses any `baseUrl` that is not localhost and not listed in
**Settings → 测试目标**. Add your test origin, for example:

```
https://test.example.com
```

`localhost` / `127.0.0.1` / `::1` are always allowed so the tool can drive a
local dev server Pilot started.

## Input

```json
{
  "baseUrl": "https://test.example.com",
  "loginPath": "/login",
  "accounts": [
    { "username": "qa-user-1", "password": "..." },
    { "username": "qa-user-2", "password": "..." }
  ],
  "concurrency": 2,
  "requestsPerSecond": 2,
  "captcha": true
}
```

- `concurrency`: 1–8, default 2.
- `requestsPerSecond`: global cap, 0.2–20, default 2.
- `usernameField` / `passwordField`: body field names, defaults `username` /
  `password`.
- `captcha`: when true, uses the **test** captcha configured in Settings. In
  `header` mode it sends `X-Pilot-Test-Captcha` (or
  `PILOT_TEST_CAPTCHA_HEADER`); in `fixture` mode it adds the value to the
  `captchaField` body field (default `captcha`). The value comes from
  `PILOT_TEST_CAPTCHA` and is never embedded in the tool.

## Output

```json
{
  "total": 3,
  "succeeded": 2,
  "failed": 1,
  "results": [
    { "username": "qa-user-1", "ok": true, "status": 200 },
    { "username": "qa-user-2", "ok": false, "status": 401, "error": "login rejected" }
  ]
}
```

## Boundaries

- Credentials are accepted at run time only. Do not put real user credentials in
  the repository or in `tool.json`.
- This tool does not solve, train or bypass CAPTCHA. The captcha path exists only
  for an authorized test environment that accepts a fixed fixture or test header.
- Keep the rate cap conservative. A high concurrency against a shared test system
  is indistinguishable from abuse.
