import { db } from "./index";
import * as schema from "./schema";
import {
  eq,
  desc,
  asc,
  inArray,
  and,
  sql,
  ilike,
  gte,
  lte,
  count,
  SQL,
  lt,
  TransactionRollbackError,
} from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { ApiResponse } from "../types";

export type ApiPaginationState = { pageIndex: number; pageSize: number };
export type ApiSort = { id: string; desc: boolean };
export type ApiSortingState = ApiSort[];
export type ApiColumnFiltersState = { id: string; value: unknown }[];
export type ApiDateRange = { from?: Date; to?: Date };

import { startOfDay, addDays } from "date-fns";

type DetectionInsert = typeof schema.detections.$inferInsert;
type DetectedPlateResultInsert = typeof schema.detectedPlateResults.$inferInsert;
type LicensePlateInsert = typeof schema.licensePlates.$inferInsert;
type DetectionSelect = typeof schema.detections.$inferSelect;
type DetectedPlateResultSelect = typeof schema.detectedPlateResults.$inferSelect;
type LicensePlateSelect = typeof schema.licensePlates.$inferSelect;

type TxType = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export async function insertDetectionAndResults(
  apiResponse: ApiResponse,
  source: (typeof schema.detectionSourceEnum.enumValues)[number],
  originalImageUrl: string
): Promise<DetectionSelect | null> {
  if (
    !apiResponse ||
    !apiResponse.detections ||
    apiResponse.detections.length === 0
  ) {
    console.log("No detections to save.");
    return null;
  }

  try {
    const result = await db.transaction(async (tx: TxType) => {
      // 1. Insert Detection
      const detectionInsertResult = await tx
        .insert(schema.detections)
        .values({
          source: source,
          imageUrl: originalImageUrl,
          processedImageUrl: apiResponse.processed_image_url,
          detectionTime: new Date(),
          processTimeMs:
            typeof apiResponse.processing_time_ms === "number"
              ? Math.round(apiResponse.processing_time_ms)
              : null,
        })
        .returning({ insertedId: schema.detections.id });

      const detectionId = detectionInsertResult[0]?.insertedId;
      if (!detectionId) {
        throw new Error("Failed to insert detection record.");
      }

      // 2. Prepare and Find/Create License Plates
      const detectedPlateNumbers = apiResponse.detections
        .map((det) => det.plate_number)
        .filter((pn): pn is string => !!pn && pn.trim() !== "");
      const uniquePlateNumbers = [...new Set(detectedPlateNumbers)];

      const licensePlateRecords: Record<string, number> = {};

      if (uniquePlateNumbers.length > 0) {
        await tx
          .insert(schema.licensePlates)
          .values(uniquePlateNumbers.map((pn) => ({ plateNumber: pn })))
          .onConflictDoNothing({ target: schema.licensePlates.plateNumber });

        const fetchedPlates = await tx
          .select({
            id: schema.licensePlates.id,
            plateNumber: schema.licensePlates.plateNumber,
          })
          .from(schema.licensePlates)
          .where(inArray(schema.licensePlates.plateNumber, uniquePlateNumbers));

        fetchedPlates.forEach((p: { id: number; plateNumber: string }) => {
          licensePlateRecords[p.plateNumber] = p.id;
        });
      }

      // 3. Prepare DetectedPlateResult inserts
      const plateDataToInsert: DetectedPlateResultInsert[] = [];
      for (const det of apiResponse.detections) {
        const plateAnalysis = det.plate_analysis;
        const primaryPlateNumber = det.plate_number;
        const licensePlateId =
          primaryPlateNumber && licensePlateRecords[primaryPlateNumber]
            ? licensePlateRecords[primaryPlateNumber]
            : null;

        const plateTypeInfo = plateAnalysis?.plate_type_info;
        const vehicleCategoryValue = plateTypeInfo?.category;
        const vehicleCategory =
          vehicleCategoryValue &&
          schema.vehicleCategoryEnum.enumValues.includes(
            vehicleCategoryValue as (typeof schema.vehicleCategoryEnum.enumValues)[number]
          )
            ? (vehicleCategoryValue as (typeof schema.vehicleCategoryEnum.enumValues)[number])
            : null;

        const detectedPlateData: DetectedPlateResultInsert = {
          detectionId: detectionId,
          licensePlateId: licensePlateId,
          plateNumber: primaryPlateNumber,
          normalizedPlate: plateAnalysis?.normalized,
          confidenceDetection: det.confidence_detection,
          boundingBox: det.bounding_box,
          ocrEngineUsed: det.ocr_engine_used,
          provinceCode: plateAnalysis?.province_code,
          provinceName: plateAnalysis?.province_name,
          plateType: plateAnalysis?.plate_type,
          detectedColor: plateAnalysis?.detected_color,
          isValidFormat: plateAnalysis?.is_valid_format,
          formatDescription: plateAnalysis?.format_description,
          typeVehicle: vehicleCategory,
        };
        plateDataToInsert.push(detectedPlateData);
      }

      // 4. Insert Detected Plate Results
      if (plateDataToInsert.length > 0) {
        await tx.insert(schema.detectedPlateResults).values(plateDataToInsert);
      }

      return { id: detectionId };
    });

    const createdDetection = await db.query.detections.findFirst({
      where: eq(schema.detections.id, result.id),
      with: {
        detectedPlates: true,
      },
    });

    return createdDetection ?? null;
  } catch (error) {
    console.error("Error in insertDetectionAndResults:", error);
    throw new Error("Failed to save detection result via query function.");
  }
}

export type HistoryQueryResultItem = DetectedPlateResultSelect & {
  detection: DetectionSelect | null;
  licensePlate: LicensePlateSelect | null;
};

export interface FetchHistoryResult {
  rows: HistoryQueryResultItem[];
  totalRowCount: number;
}

const filterColumnMap: Record<string, any> = {
  plateNumber: schema.detectedPlateResults.plateNumber,
  normalizedPlate: schema.detectedPlateResults.normalizedPlate,
  confidence: schema.detectedPlateResults.confidenceDetection,
  date: schema.detections.detectionTime,
  provinceName: schema.detectedPlateResults.provinceName,
  isValidFormat: schema.detectedPlateResults.isValidFormat,
  ocrEngine: schema.detectedPlateResults.ocrEngineUsed,
  typeVehicle: schema.detectedPlateResults.typeVehicle,
  source: schema.detections.source,
  processTime: schema.detections.processTimeMs,
};

const sortColumnMap: Record<string, any> = {
  plateNumber: schema.detectedPlateResults.plateNumber,
  confidence: schema.detectedPlateResults.confidenceDetection,
  date: schema.detections.detectionTime,
  provinceName: schema.detectedPlateResults.provinceName,
  isValidFormat: schema.detectedPlateResults.isValidFormat,
  ocrEngine: schema.detectedPlateResults.ocrEngineUsed,
  normalizedPlate: schema.detectedPlateResults.normalizedPlate,
  source: schema.detections.source,
  processTime: schema.detections.processTimeMs,
};

/**
 * Parses API filter parameters into Drizzle WHERE conditions.
 */
function parseFiltersToDrizzle(filters: ApiColumnFiltersState): SQL | undefined {
  const conditions: (SQL | undefined)[] = [];
  for (const filter of filters) {
    const columnId = filter.id;
    const filterValue = filter.value;
    const column = filterColumnMap[columnId];

    if (!column) continue;

    switch (columnId) {
      case "plateNumber":
      case "normalizedPlate":
      case "provinceName":
        if (typeof filterValue === "string" && filterValue.length > 0) {
          conditions.push(ilike(column, `%${filterValue}%`));
        }
        break;
      case "ocrEngine":
      case "typeVehicle":
      case "source":
        if (typeof filterValue === "string" && filterValue.length > 0) {
          if (
            columnId === "typeVehicle" &&
            !schema.vehicleCategoryEnum.enumValues.includes(filterValue as any)
          )
            break;
          if (
            columnId === "source" &&
            !schema.detectionSourceEnum.enumValues.includes(filterValue as any)
          )
            break;
          conditions.push(eq(column, filterValue));
        }
        break;
      case "confidence":
      case "processTime":
        if (
          Array.isArray(filterValue) &&
          filterValue.length === 2 &&
          (typeof filterValue[0] === "number" ||
            typeof filterValue[1] === "number")
        ) {
          const [min, max] = filterValue;
          const conditionList: (SQL | undefined)[] = [];
          if (typeof min === "number") {
            const minValue = columnId === "confidence" ? min / 100 : min;
            conditionList.push(gte(column, minValue));
          }
          if (typeof max === "number") {
            const maxValue = columnId === "confidence" ? max / 100 : max;
            conditionList.push(lte(column, maxValue));
          }
          if (conditionList.length > 0) {
            conditions.push(and(...conditionList.filter((c): c is SQL => !!c)));
          }
        }
        break;
      case "isValidFormat":
        if (typeof filterValue === "boolean") {
          conditions.push(eq(column, filterValue));
        }
        break;
      case "date":
        if (
          typeof filterValue === "object" &&
          filterValue !== null &&
          ("from" in filterValue || "to" in filterValue)
        ) {
          const { from, to } = filterValue as ApiDateRange;
          const conditionList: (SQL | undefined)[] = [];
          if (from instanceof Date) {
            conditionList.push(gte(column, startOfDay(from)));
          }
          if (to instanceof Date) {
            conditionList.push(lt(column, addDays(startOfDay(to), 1)));
          }
          if (conditionList.length > 0) {
            conditions.push(and(...conditionList.filter((c): c is SQL => !!c)));
          }
        }
        break;
      default:
        break;
    }
  }

  if (conditions.length === 0) {
    return undefined;
  }
  return and(...conditions.filter((c): c is SQL => !!c));
}

/**
 * Parses API sorting parameters into Drizzle ORDER BY clause.
 */
function parseSortingToDrizzle(sorting: ApiSortingState) {
  if (sorting.length === 0) {
    return [desc(schema.detections.detectionTime)];
  }

  const orderByClauses = sorting.map((sort: ApiSort) => {
    const column = sortColumnMap[sort.id];
    if (!column) {
      return desc(schema.detections.detectionTime);
    }
    return sort.desc ? desc(column) : asc(column);
  });

  return orderByClauses.filter((c): c is NonNullable<typeof c> => !!c);
}

/**
 * Fetches detection history based on API parameters.
 */
export async function fetchDetectionHistory(
  pagination: ApiPaginationState,
  sorting: ApiSortingState,
  filters: ApiColumnFiltersState
): Promise<FetchHistoryResult> {
  const { pageIndex, pageSize } = pagination;
  const offset = pageIndex * pageSize;
  const limit = pageSize;

  const whereCondition = parseFiltersToDrizzle(filters);
  const orderByCondition = parseSortingToDrizzle(sorting);

  const baseQuery = db
    .select()
    .from(schema.detectedPlateResults)
    .leftJoin(
      schema.detections,
      eq(schema.detectedPlateResults.detectionId, schema.detections.id)
    )
    .leftJoin(
      schema.licensePlates,
      eq(schema.detectedPlateResults.licensePlateId, schema.licensePlates.id)
    );

  try {
    const query = baseQuery
      .where(whereCondition)
      .orderBy(...orderByCondition)
      .limit(limit)
      .offset(offset);

    const countQuery = db
      .select({ totalCount: count() })
      .from(schema.detectedPlateResults)
      .leftJoin(
        schema.detections,
        eq(schema.detectedPlateResults.detectionId, schema.detections.id)
      )
      .where(whereCondition);

    // console.log('SQL Query:', query.toSQL()); // For debugging
    // console.log('SQL Count Query:', countQuery.toSQL()); // For debugging

    const [rows, totalResult] = await Promise.all([
      query,
      countQuery.then((res: { totalCount: number }[]) => res[0]),
    ]);

    type QueryRow = {
      detected_plate_results: DetectedPlateResultSelect;
      detections: DetectionSelect | null;
      license_plates: LicensePlateSelect | null;
    };

    const mappedRows: HistoryQueryResultItem[] = rows.map((row: QueryRow) => {
      return {
        ...row.detected_plate_results,
        // Assign potentially null related objects
        detection: row.detections,
        licensePlate: row.license_plates,
      };
    });

    return {
      rows: mappedRows,
      totalRowCount: totalResult?.totalCount || 0,
    };
  } catch (error) {
    console.error("Error fetching detection history:", error);
    throw new Error("Failed to fetch detection history from database.");
  }
}

/**
 * Fetches distinct options for filtering.
 */
export async function getFilterOptions(): Promise<{
  ocrEngines: string[];
  vehicleTypes: string[];
  sources: string[];
}> {
  try {
    const [enginesResult, typesResult, sourcesResult] = await Promise.all([
      db
        .selectDistinct({ engine: schema.detectedPlateResults.ocrEngineUsed })
        .from(schema.detectedPlateResults)
        .where(
          and(
            sql`${schema.detectedPlateResults.ocrEngineUsed} IS NOT NULL`,
            sql`${schema.detectedPlateResults.ocrEngineUsed} != \'\'`
          )
        )
        .orderBy(asc(schema.detectedPlateResults.ocrEngineUsed)),
      db
        .selectDistinct({ type: schema.detectedPlateResults.typeVehicle })
        .from(schema.detectedPlateResults)
        .where(sql`${schema.detectedPlateResults.typeVehicle} IS NOT NULL`)
        .orderBy(asc(schema.detectedPlateResults.typeVehicle)),
      db
        .selectDistinct({ source: schema.detections.source })
        .from(schema.detections)
        .where(sql`${schema.detections.source} IS NOT NULL`)
        .orderBy(asc(schema.detections.source)),
    ]);

    // Filter out null values after mapping (empty strings already filtered by DB)
    const ocrEngines = enginesResult
      .map((e: { engine: string | null }) => e.engine)
      .filter((e): e is string => typeof e === "string");

    const vehicleTypes = typesResult
      .map(
        (t: {
          type: (typeof schema.vehicleCategoryEnum.enumValues)[number] | null;
        }) => t.type
      )
      .filter((t): t is NonNullable<typeof t> => t !== null);

    const sources = sourcesResult
      .map(
        (s: {
          source: (typeof schema.detectionSourceEnum.enumValues)[number] | null;
        }) => s.source
      )
      .filter((s): s is NonNullable<typeof s> => s !== null);

    return {
      ocrEngines,
      vehicleTypes: vehicleTypes as string[],
      sources: sources as string[],
    };
  } catch (error) {
    console.error("Error fetching filter options:", error);
    throw new Error("Failed to fetch filter options from database.");
  }
}
