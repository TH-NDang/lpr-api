export interface BackendPlateAnalysis {
  original: string;
  normalized: string;
  province_code: string | null;
  province_name: string | null;
  serial: string | null;
  number: string | null;
  plate_type: string;
  plate_type_info: {
    name: string;
    description: string;
    category?: string;
  } | null;
  detected_color: string | null;
  is_valid_format: boolean;
  format_description: string | null;
}

export interface BackendDetection {
  plate_number: string;
  confidence_detection: number;
  bounding_box: [number, number, number, number];
  plate_analysis: BackendPlateAnalysis | null;
  ocr_engine_used: string | null;
}

export interface ApiResponse {
  detections: BackendDetection[];
  processed_image_url: string | null;
  processing_time_ms?: number;
  error: string | null;
}
