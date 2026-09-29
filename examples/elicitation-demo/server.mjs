#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 Victor. Part of the Jev elicitation autopilot; see NOTICE.
/**
 * Demo MCP server for `--elicit`: a pretend production database whose
 * destructive tool asks the user for confirmation before acting.
 *
 * `drop_table` elicits a form (a confirmation checkbox, a backup choice and a
 * change ticket) and takes a different branch for each possible answer —
 * accepted, accepted without ticking the box, declined, cancelled. Those
 * branches are exactly what an unattended test could never reach before.
 * Nothing is actually deleted: the tool only reports what it would have done.
 *
 * Runs over stdio on the legacy protocol era (server→client elicitation).
 */
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

/** Fake row counts, so the confirmation message is concrete. */
const TABLES = { orders: 42_118, customers: 9_310, audit_log: 1_204_551 };

const server = new McpServer({ name: "prod-db-demo", version: "1.0.0" });

function text(message) {
  return { content: [{ type: "text", text: message }] };
}

server.registerTool(
  "drop_table",
  {
    description:
      "Permanently delete a table from the production database. Asks the user to confirm first.",
    inputSchema: { table: z.string().describe("Name of the table to drop") },
  },
  async ({ table }) => {
    const rows = TABLES[table];
    if (rows === undefined) {
      return {
        ...text(
          `Unknown table "${table}". Known: ${Object.keys(TABLES).join(", ")}.`,
        ),
        isError: true,
      };
    }

    const answer = await server.server.elicitInput({
      message: `This will permanently delete ${rows.toLocaleString("en-US")} rows from "${table}" in PRODUCTION. This cannot be undone. Continue?`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: {
            type: "boolean",
            title: "I understand this permanently deletes production data",
          },
          backup: {
            type: "string",
            title: "Backup before deleting",
            oneOf: [
              { const: "none", title: "No backup" },
              { const: "snapshot", title: "Quick snapshot" },
              { const: "full", title: "Full backup" },
            ],
          },
          ticket: {
            type: "string",
            title: "Change ticket",
            description: "The approved change request, e.g. CHG-1234",
          },
        },
        required: ["confirm", "backup", "ticket"],
      },
    });

    if (answer.action === "decline") {
      return text(`Aborted: the user declined. "${table}" is untouched.`);
    }
    if (answer.action === "cancel") {
      return text(`Cancelled: no decision was made. "${table}" is untouched.`);
    }
    const { confirm, backup, ticket } = answer.content ?? {};
    if (confirm !== true) {
      return text(
        `Aborted: the confirmation box was not ticked. "${table}" is untouched.`,
      );
    }
    return text(
      `Dropped "${table}" (${rows.toLocaleString("en-US")} rows). Backup: ${backup}. Ticket: ${ticket}.`,
    );
  },
);

await server.connect(new StdioServerTransport());
