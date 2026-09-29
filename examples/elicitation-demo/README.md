# Demo: a production database that asks before deleting

[`server.mjs`](./server.mjs) is a small MCP server with one tool, `drop_table`. Before acting it elicits a form from the user:

- **confirm** (checkbox): "I understand this permanently deletes production data"
- **backup** (choice): none / quick snapshot / full backup
- **ticket** (text): the approved change request

It then takes a different branch for every possible answer: dropped, aborted because the box was not ticked, declined, or cancelled. Nothing is really deleted; it only reports what it would do.

## Setup (once)

From the repository root:

```bash
npm install
npm run build:cli
```

Every command below is run from the repository root, and starts the demo server itself over stdio.

## 1. No API key: answer from defaults

```bash
node clients/cli/build/index.js node examples/elicitation-demo/server.mjs \
  --method tools/call --tool-name drop_table --tool-arg table=orders \
  --elicit defaults --elicit-default confirm=true backup=full ticket=CHG-1234
```

Result: `Dropped "orders" (42,118 rows). Backup: full. Ticket: CHG-1234.`

Change `confirm=true` to `confirm=false` and the server takes its abort branch instead.

## 2. With Jev: the same call, two users

Set your key first ([how to get one](../../README.md#connecting-to-jev)):

```bash
export TYPESAFE_API_KEY="ts-…"            # bash
$env:TYPESAFE_API_KEY = "ts-…"            # PowerShell
```

**Cautious operator**:

```bash
node clients/cli/build/index.js node examples/elicitation-demo/server.mjs \
  --method tools/call --tool-name drop_table --tool-arg table=orders \
  --elicit jev --elicit-policy @examples/elicitation-demo/policies/cautious.txt \
  --elicit-default ticket=CHG-1234
```

Expected: `Aborted: the user declined. "orders" is untouched.`

**Eager operator**: same command with `policies/eager.txt`.
Expected: `Dropped "orders" … Backup: snapshot …`. Jev also chose the backup option.

Each run prints one transcript line on **stderr** showing what Jev decided and how sure it was:

```json
{"elicitation":{"message":"This will permanently delete 42,118 rows…","mode":"jev","model":"jev-1.13.0","action":{"value":"decline","probability":0.94},"fields":[]}}
```

Jev's answers depend on the model, so your probabilities will differ. If one falls below the threshold (default `0.8`), the run exits with code `9`, marked ambiguous. Sharpen the policy text, or try `--elicit-threshold 0.7`.




