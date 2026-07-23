/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as ack from "../ack.js";
import type * as admin from "../admin.js";
import type * as diag from "../diag.js";
import type * as inbox from "../inbox.js";
import type * as invite from "../invite.js";
import type * as lib_core from "../lib/core.js";
import type * as lib_ids from "../lib/ids.js";
import type * as send from "../send.js";
import type * as setup from "../setup.js";
import type * as testutil from "../testutil.js";
import type * as thread from "../thread.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  ack: typeof ack;
  admin: typeof admin;
  diag: typeof diag;
  inbox: typeof inbox;
  invite: typeof invite;
  "lib/core": typeof lib_core;
  "lib/ids": typeof lib_ids;
  send: typeof send;
  setup: typeof setup;
  testutil: typeof testutil;
  thread: typeof thread;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
