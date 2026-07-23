import { defineSchema } from "convex/server";

// Minimal bootstrap schema so `convex dev` can create the deployment.
// The real agents/threads/messages tables + indexes are authored during
// implementation from docs/spec/*.md and packages/schema/src/protocol.ts.
export default defineSchema({});
