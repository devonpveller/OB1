// Notifications (D13 item 7), the configuration store (D6 item 5) and the registries (D18).
import { z } from "../deps.ts";
import { REGISTRY, registryValue } from "../registry.ts";
import { Iso, Json, uuid } from "./common.ts";
import { FX } from "./fixtures.ts";

export const Notification = z.object({
  id: uuid(FX.notification),
  class: registryValue(REGISTRY.notificationClasses, "transient"),
  subject: z.string(),
  slug: z.string().nullable(),
  entity: z.string().nullable(),
  origin: registryValue(REGISTRY.origins, "workspace").nullable(),
  error: z.string().nullable(),
  first_seen: Iso,
  last_seen: Iso,
  count: z.number().int(),
}).openapi("Notification");

export const Notifications = z.object({
  notifications: z.array(Notification),
}).openapi("Notifications");

export const Setting = z.object({
  key: registryValue(REGISTRY.settings, "podcast.archive_destination"),
  value: Json.openapi({ description: "{\"mount\": <name>} or {\"path\": <directory>}" }),
  is_default: z.boolean(),
  version: z.number().int(),
  updated_at: Iso.nullable(),
  updated_by: z.string().nullable(),
  resolved: z.object({
    path: z.string().nullable().openapi({ description: "where a reader writes, inside this container" }),
    reachable: z.boolean(),
    via: z.string(),
  }),
}).openapi("Setting");

export const Settings = z.object({ settings: z.array(Setting) }).openapi("Settings");

export const SettingWrite = z.object({
  value: Json,
  by: z.string().optional(),
}).openapi("SettingWrite");

export const RegistryEntryRecord = z.object({
  key: z.string(),
  version: z.number().int(),
  label: z.string(),
  definition: Json,
  retired_at: Iso.nullable(),
  superseded_by: z.string().nullable(),
}).openapi("RegistryEntry");

export const RegistrySummary = z.object({
  name: z.string(),
  version: z.number().int(),
  owner: z.string(),
  description: z.string(),
  entries: z.number().int(),
}).openapi("RegistrySummary");

export const Registries = z.object({ registries: z.array(RegistrySummary) }).openapi("Registries");

export const RegistryDetail = z.object({
  name: z.string(),
  version: z.number().int(),
  owner: z.string(),
  description: z.string(),
  entries: z.array(RegistryEntryRecord),
}).openapi("RegistryDetail");
