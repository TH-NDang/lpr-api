import {
  pgTable,
  serial,
  text,
  varchar,
  timestamp,
  boolean,
  integer,
  jsonb,
  real,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

export const detectionSourceEnum = pgEnum("detection_source", [
  "upload",
  "camera",
  "import",
  "api",
]);
export const entryTypeEnum = pgEnum("entry_type", ["entry", "exit", "unknown"]);
export const vehicleCategoryEnum = pgEnum("vehicle_category", [
  "car",
  "truck",
  "motorcycle",
  "bus",
  "special",
  "other",
]);

// --- Auth Tables ---

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").notNull(),
  updatedAt: timestamp("updated_at").notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at"),
  updatedAt: timestamp("updated_at"),
});

// --- License Plate Tables ---

export const licensePlates = pgTable("license_plates", {
  id: serial("id").primaryKey(),
  plateNumber: varchar("plateNumber", { length: 20 }).notNull().unique(),
  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const licensePlatesRelations = relations(licensePlates, ({ many }) => ({
  detectionResults: many(detectedPlateResults),
}));

export const detections = pgTable("detections", {
  id: serial("id").primaryKey(),
  source: detectionSourceEnum("source").default("upload"),
  imageUrl: text("imageUrl").notNull(),
  processedImageUrl: text("processedImageUrl"),
  detectionTime: timestamp("detectionTime", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  processTimeMs: integer("processTimeMs"),
  cameraId: integer("cameraId").references(() => cameras.id, {
    onDelete: "set null",
  }),
  locationId: integer("locationId").references(() => locations.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const detectionsRelations = relations(detections, ({ one, many }) => ({
  detectedPlates: many(detectedPlateResults),
  camera: one(cameras, {
    fields: [detections.cameraId],
    references: [cameras.id],
  }),
  location: one(locations, {
    fields: [detections.locationId],
    references: [locations.id],
  }),
  parkingEntries: many(parkingEntries),
}));

export const detectedPlateResults = pgTable("detected_plate_results", {
  id: serial("id").primaryKey(),
  detectionId: integer("detectionId")
    .notNull()
    .references(() => detections.id, { onDelete: "cascade" }),
  licensePlateId: integer("licensePlateId").references(() => licensePlates.id, {
    onDelete: "set null",
  }),

  plateNumber: varchar("plateNumber", { length: 20 }).notNull(),
  normalizedPlate: varchar("normalizedPlate", { length: 20 }),

  confidenceDetection: real("confidenceDetection").notNull(),
  boundingBox: jsonb("boundingBox").notNull(),
  ocrEngineUsed: varchar("ocrEngineUsed", { length: 50 }),
  typeVehicle: vehicleCategoryEnum("typeVehicle"),
  provinceCode: varchar("provinceCode", { length: 10 }),
  provinceName: varchar("provinceName", { length: 100 }),
  plateType: varchar("plateType", { length: 50 }),
  detectedColor: varchar("detectedColor", { length: 30 }),
  isValidFormat: boolean("isValidFormat"),
  formatDescription: text("formatDescription"),

  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const detectedPlateResultsRelations = relations(
  detectedPlateResults,
  ({ one, many }) => ({
    detection: one(detections, {
      fields: [detectedPlateResults.detectionId],
      references: [detections.id],
    }),
    licensePlate: one(licensePlates, {
      fields: [detectedPlateResults.licensePlateId],
      references: [licensePlates.id],
    }),
    parkingEntries: many(parkingEntries),
  })
);

export const cameras = pgTable("cameras", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).default("").notNull(),
  model: varchar("model", { length: 100 }),
  locationId: integer("locationId").references(() => locations.id, {
    onDelete: "set null",
  }),
  position: varchar("position", { length: 100 }),
  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const camerasRelations = relations(cameras, ({ one, many }) => ({
  detections: many(detections),
  location: one(locations, {
    fields: [cameras.locationId],
    references: [locations.id],
  }),
}));

export const locations = pgTable("locations", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 100 }).default("").notNull(),
  address: text("address"),
  locationType: varchar("locationType", { length: 50 }),
  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const locationsRelations = relations(locations, ({ many }) => ({
  cameras: many(cameras),
  detections: many(detections),
  parkingEntries: many(parkingEntries),
}));

export const parkingEntries = pgTable("parking_entries", {
  id: serial("id").primaryKey(),
  entryTime: timestamp("entryTime", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  exitTime: timestamp("exitTime", { mode: "date", withTimezone: true }),
  entryType: entryTypeEnum("entryType").default("unknown"),
  detectedPlateResultId: integer("detectedPlateResultId").references(
    () => detectedPlateResults.id,
    { onDelete: "set null" }
  ),
  plateNumber: varchar("plateNumber", { length: 20 }).default(""),
  locationId: integer("locationId")
    .notNull()
    .references(() => locations.id, { onDelete: "cascade" }),
  detectionId: integer("detectionId").references(() => detections.id, {
    onDelete: "set null",
  }),
  parkingFee: real("parkingFee"),
  paymentStatus: varchar("paymentStatus", { length: 30 }),
  paymentTime: timestamp("paymentTime", { mode: "date", withTimezone: true }),
  createdAt: timestamp("createdAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updatedAt", { mode: "date", withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
});

export const parkingEntriesRelations = relations(
  parkingEntries,
  ({ one }) => ({
    detectedPlateResult: one(detectedPlateResults, {
      fields: [parkingEntries.detectedPlateResultId],
      references: [detectedPlateResults.id],
    }),
    location: one(locations, {
      fields: [parkingEntries.locationId],
      references: [locations.id],
    }),
    detection: one(detections, {
      fields: [parkingEntries.detectionId],
      references: [detections.id],
    }),
  })
);
