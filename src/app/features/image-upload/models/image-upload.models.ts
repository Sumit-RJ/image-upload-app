/**
 * @file image-upload.models.ts
 * @description Shared TypeScript interfaces and enums for the image upload feature.
 *              Keeping models in one place ensures consistency across services and components.
 */

// ─── Upload Stage Enum ────────────────────────────────────────────────────────

/** Represents the current stage of the image processing + upload pipeline. */
export enum UploadStage {
  Idle        = 'idle',
  Validating  = 'validating',
  Processing  = 'processing',
  Uploading   = 'uploading',
  Complete    = 'complete',
  Error       = 'error',
}

// ─── Progress Model ───────────────────────────────────────────────────────────

/** Tracks the overall progress of the image pipeline. */
export interface UploadProgress {
  /** 0–100 percentage value shown on the progress bar. */
  percentage: number;
  /** Which stage of the pipeline we are currently in. */
  stage: UploadStage;
  /** Human-readable status message shown below the progress bar. */
  message: string;
}

// ─── Processed Image Result ───────────────────────────────────────────────────

/** Holds the two output blobs produced by ImageProcessorService. */
export interface ProcessedImages {
  /** JPEG blob ≤ 200 KB at 1080p resolution. */
  compressed: Blob;
  /** JPEG blob ≤ 60 KB at 300 × 300 px, face-centred. */
  thumbnail: Blob;
}

// ─── API Response ─────────────────────────────────────────────────────────────

/** Shape of the successful JSON response from the .NET 10 upload endpoint. */
export interface UploadResponse {
  success: boolean;
  /** CDN / storage URL for the compressed full-size image. */
  compressedImageUrl: string;
  /** CDN / storage URL for the face-centred thumbnail. */
  thumbnailImageUrl: string;
  /** Optional server message (e.g. "Uploaded successfully"). */
  message: string;
}

// ─── Compression Config ───────────────────────────────────────────────────────

/** Tuning knobs passed into the adaptive compression loop. */
export interface CompressionConfig {
  /** Hard upper bound in bytes (default: 200 * 1024 = 204 800). */
  maxSizeBytes: number;
  /** Long edge in pixels to cap at 1080 p (default: 1920). */
  maxWidthPx: number;
  /** Short edge in pixels for 1080 p (default: 1080). */
  maxHeightPx: number;
  /** Starting JPEG quality (0–1). The loop steps down by qualityStep. */
  initialQuality: number;
  /** Amount to reduce quality each iteration (default: 0.05). */
  qualityStep: number;
  /** Lowest allowed quality before giving up (default: 0.1). */
  minQuality: number;
}

/** Tuning knobs for the thumbnail generation step. */
export interface ThumbnailConfig {
  /** Output width in pixels (default: 300). */
  widthPx: number;
  /** Output height in pixels (default: 300). */
  heightPx: number;
  /** Hard upper bound in bytes (default: 30 * 1024 = 30 720). */
  maxSizeBytes: number;
  /**
   * Padding multiplier applied to the face bounding box before cropping.
   * 2.5 = 150 % extra space around the detected face (default).
   */
  facePaddingFactor: number;
}

// ─── Retry Config ─────────────────────────────────────────────────────────────

/** Configuration for the RxJS retry-with-delay strategy. */
export interface RetryConfig {
  /** Maximum number of retry attempts (default: 3). */
  maxAttempts: number;
  /** Base delay in ms before first retry (doubled each attempt). */
  delayMs: number;
}
