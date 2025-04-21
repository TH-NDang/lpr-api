import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { StatusCode } from "hono/utils/http-status";

import {
  getFilterOptions,
  fetchDetectionHistory,
  insertDetectionAndResults,
} from "./db/queries";
import { z } from "zod";
import type {
  ApiPaginationState,
  ApiSortingState,
  ApiColumnFiltersState,
  ApiDateRange,
} from "./db/queries";
import type { ApiResponse } from "./types";
import * as schema from "./db/schema";

const app = new Hono();

// --- Middleware ---
app.use("*", logger());
app.use("*", cors());

const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://127.0.0.1:8000";

async function processAndSave(
  fetchPromise: Promise<Response>,
  source: (typeof schema.detectionSourceEnum.enumValues)[number],
  originalIdentifier: string // file.name or url
): Promise<ApiResponse> {
  let apiResponseData: ApiResponse | null = null;
  try {
    const response = await fetchPromise;

    if (!response.ok) {
      let errorBody = null;
      try {
        errorBody = await response.json();
      } catch (e) {
        /* Ignore parsing error */
      }
      throw new Error(
        `Python API Error: ${response.status} ${
          response.statusText
        }. Details: ${JSON.stringify(errorBody)}`
      );
    }

    apiResponseData = (await response.json()) as ApiResponse;

    if (apiResponseData?.detections && apiResponseData.detections.length > 0) {
      try {
        console.log(`Saving detection from ${source}: ${originalIdentifier}`);
        const createdDetection = await insertDetectionAndResults(
          apiResponseData,
          source,
          originalIdentifier
        );
        if (!createdDetection) {
          console.warn(
            "DB insert function returned null, potential issue saving detection."
          );
        }
      } catch (dbError) {
        console.error(
          "Error saving detection to database after successful Python API call:",
          dbError
        );
        if (apiResponseData) {
          const message =
            dbError instanceof Error ? dbError.message : String(dbError);
          apiResponseData.error = apiResponseData.error
            ? `${apiResponseData.error}. DB save failed: ${message}`
            : `DB save failed: ${message}`;
        }
      }
    }

    return (
      apiResponseData ?? {
        detections: [],
        processed_image_url: null,
        error: "No response data received from Python API.",
      }
    );
  } catch (error) {
    console.error("Error during Python API call or DB save:", error);
    let errorMessage = "An unknown error occurred during processing.";
    if (error instanceof Error) {
      if (
        error.message.includes("fetch failed") ||
        error.message.includes("ENOTFOUND") ||
        error.message.includes("ECONNREFUSED")
      ) {
        errorMessage = `Could not connect to Python processing service at ${PYTHON_API_URL}.`;
      } else if (error.message.startsWith("Python API Error:")) {
        errorMessage = error.message;
      } else {
        errorMessage = `Processing failed: ${error.message}`;
      }
    }
    return {
      detections: apiResponseData?.detections ?? [],
      processed_image_url: apiResponseData?.processed_image_url ?? null,
      error: errorMessage,
    };
  }
}

// ------------------------------------
// --- Routes ---
// ------------------------------------

app.get("/history/options", async (c) => {
  try {
    const options = await getFilterOptions();
    return new Response(JSON.stringify(options), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching filter options:", error);
    return new Response(
      JSON.stringify({ error: "Failed to fetch filter options" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});

const historyQuerySchema = z.object({
  pageIndex: z.coerce.number().int().min(0).default(0),
  pageSize: z.coerce.number().int().min(1).max(100).default(10),
  sortId: z.string().optional(),
  sortDesc: z.enum(["true", "false"]).optional(),
  plateNumber: z.string().optional(),
  normalizedPlate: z.string().optional(),
  provinceName: z.string().optional(),
  ocrEngine: z.string().optional(),
  typeVehicle: z.string().optional(),
  source: z.string().optional(),
  isValidFormat: z.enum(["true", "false"]).optional(),
  confidenceMin: z.coerce.number().min(0).max(100).optional(),
  confidenceMax: z.coerce.number().min(0).max(100).optional(),
  processTimeMin: z.coerce.number().int().min(0).optional(),
  processTimeMax: z.coerce.number().int().min(0).optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
});

app.get("/history", async (c) => {
  try {
    const queryParams = c.req.query();
    const validationResult = historyQuerySchema.safeParse(queryParams);

    if (!validationResult.success) {
      return new Response(
        JSON.stringify({
          error: "Invalid query parameters",
          details: validationResult.error.flatten(),
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    const validQueryParams = validationResult.data;

    const pagination: ApiPaginationState = {
      pageIndex: validQueryParams.pageIndex,
      pageSize: validQueryParams.pageSize,
    };

    const sorting: ApiSortingState = [];
    if (validQueryParams.sortId) {
      sorting.push({
        id: validQueryParams.sortId,
        desc:
          validQueryParams.sortDesc === "true" ||
          (validQueryParams.sortId === "date" && !validQueryParams.sortDesc),
      });
    }

    const filters: ApiColumnFiltersState = [];
    const dateFilter: ApiDateRange = {};

    for (const [key, value] of Object.entries(validQueryParams)) {
      if (value === undefined || value === null) continue;

      if (
        key === "pageIndex" ||
        key === "pageSize" ||
        key === "sortId" ||
        key === "sortDesc"
      )
        continue;

      if (key === "dateFrom") {
        dateFilter.from = value as Date;
      } else if (key === "dateTo") {
        dateFilter.to = value as Date;
      } else if (key === "confidenceMin" || key === "confidenceMax") {
        const existing = filters.find(
          (f: { id: string; value: unknown }) => f.id === "confidence"
        );
        if (existing) {
          if (key === "confidenceMin")
            (existing.value as [number?, number?])[0] = value as number;
          else (existing.value as [number?, number?])[1] = value as number;
        } else {
          filters.push({
            id: "confidence",
            value:
              key === "confidenceMin"
                ? [value as number, undefined]
                : [undefined, value as number],
          });
        }
      } else if (key === "processTimeMin" || key === "processTimeMax") {
        const existing = filters.find(
          (f: { id: string; value: unknown }) => f.id === "processTime"
        );
        if (existing) {
          if (key === "processTimeMin")
            (existing.value as [number?, number?])[0] = value as number;
          else (existing.value as [number?, number?])[1] = value as number;
        } else {
          filters.push({
            id: "processTime",
            value:
              key === "processTimeMin"
                ? [value as number, undefined]
                : [undefined, value as number],
          });
        }
      } else if (key === "isValidFormat") {
        filters.push({ id: key, value: value === "true" });
      } else {
        filters.push({ id: key, value: value });
      }
    }

    if (dateFilter.from || dateFilter.to) {
      filters.push({ id: "date", value: dateFilter });
    }

    const result = await fetchDetectionHistory(pagination, sorting, filters);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error fetching detection history:", error);
    const errorMessage =
      error instanceof Error ? error.message : "An unknown error occurred";
    return new Response(
      JSON.stringify({
        error: "Failed to fetch detection history",
        details: errorMessage,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});

app.post("/process-image", async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get("file") as File;

    if (!file || !(file instanceof File)) {
      c.status(400);
      return c.json({
        error: 'Invalid file upload. "file" field is missing or not a file.',
      });
    }

    console.log(
      `Received file: ${file.name}, type: ${file.type}, size: ${file.size} bytes`
    );

    if (!file.type.startsWith("image/")) {
      c.status(415);
      return c.json({
        error: "Unsupported file type. Only image files are accepted.",
      });
    }

    const backendUrl = `${process.env.PYTHON_BACKEND_URL}/process-image`;
    console.log(`Forwarding request to: ${backendUrl}`);

    const pythonFormData = new FormData();
    pythonFormData.append("file", file, file.name);

    const response = await fetch(backendUrl, {
      method: "POST",
      body: pythonFormData,
    });

    const result = (await response.json()) as ApiResponse;

    if (!response.ok) {
      console.error(`Python backend error: ${response.status}`, result);
      const statusCode =
        response.status === 415 ||
        response.status === 413 ||
        response.status === 422
          ? response.status
          : 500;
      c.status(statusCode as StatusCode);
      return c.json(result);
    }

    const dbResult = await insertDetectionAndResults(
      result,
      "upload",
      file.name
    );
    console.log("Record inserted:", dbResult);

    c.status(200 as StatusCode);
    return c.json(result);
  } catch (error) {
    console.error("Error processing image upload:", error);
    let status = 500;
    let body: { error: string; details?: string } = {
      error: "An unexpected server error occurred.",
    };
    if (error instanceof Error) {
      body.details = error.message;
      if (
        error.message.includes("fetch failed") ||
        error.message.includes("ECONNREFUSED")
      ) {
        status = 502;
        body.error = "Could not connect to the backend processing service.";
      } else if (error.message.includes("multipart")) {
        status = 400;
        body.error = "Failed to parse multipart form data.";
      }
    }
    c.status(status as StatusCode);
    return c.json(body);
  }
});

const processImageUrlBodySchema = z.object({
  url: z.string().url("Invalid URL provided"),
});

app.post("/process-image-url", async (c) => {
  try {
    const { url } = await c.req.json<{ url: string }>();

    if (!url) {
      c.status(400);
      return c.json({ error: 'Missing "url" in request body.' });
    }

    try {
      new URL(url);
    } catch (_) {
      c.status(400);
      return c.json({ error: "Invalid URL format." });
    }

    console.log(`Processing image from URL: ${url}`);

    const backendUrl = `${process.env.PYTHON_BACKEND_URL}/process-image-url`;
    console.log(`Forwarding request to: ${backendUrl}`);

    const response = await fetch(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });

    const result = (await response.json()) as ApiResponse;

    if (!response.ok) {
      console.error(`Python backend error: ${response.status}`, result);
      const statusCode = response.status === 422 ? 422 : 500;
      c.status(statusCode as StatusCode);
      return c.json(result);
    }

    const dbResult = await insertDetectionAndResults(result, "api", url);
    console.log("Record inserted:", dbResult);

    c.status(200 as StatusCode);
    return c.json(result);
  } catch (error) {
    console.error("Error processing image URL:", error);
    let status = 500;
    let body: { error: string; details?: string } = {
      error: "An unexpected server error occurred processing the URL.",
    };
    if (error instanceof Error) {
      body.details = error.message;
      if (
        error.message.includes("fetch failed") ||
        error.message.includes("ECONNREFUSED")
      ) {
        status = 502;
        body.error = "Could not connect to the backend processing service.";
      }
    }
    c.status(status as StatusCode);
    return c.json(body);
  }
});

const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3001;
console.log(`Server is running on port ${port}`);

export default {
  port: port,
  fetch: app.fetch,
};
