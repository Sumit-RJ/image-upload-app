/**
 * @file image-processor.service.ts
 * @description Handles all client-side image processing:
 *   1. Adaptive JPEG compression → ≤ 200 KB at 1080 p.
 *   2. Face-centred thumbnail generation → ≤ 30 KB at 300 × 300 px.
 *
 * Dependencies (install via npm):
 *   npm install @vladmandic/face-api
 *
 * Face-API models must be placed in /public/face-api-models/
 * Download from: https://github.com/vladmandic/face-api/tree/master/model
 * Required model files:
 *   - tiny_face_detector_model-weights_manifest.json + shard(s)
 *   - face_landmark_68_tiny_model-weights_manifest.json + shard(s)
 */

import { Injectable, inject }        from '@angular/core';
import { HttpClient }                 from '@angular/common/http';
import * as faceapi                   from '@vladmandic/face-api';
import {
  CompressionConfig,
  ProcessedImages,
  ThumbnailConfig,
} from '../models/image-upload.models';

// ─── Default Configuration Constants ─────────────────────────────────────────

const DEFAULT_COMPRESSION: CompressionConfig = {
  maxSizeBytes:   200 * 1024,   // 200 KB
  maxWidthPx:     1920,         // 1080 p landscape width
  maxHeightPx:    1080,         // 1080 p landscape height
  initialQuality: 0.92,
  qualityStep:    0.05,
  minQuality:     0.10,
};

const DEFAULT_THUMBNAIL: ThumbnailConfig = {
  widthPx:          300,
  heightPx:         300,
  maxSizeBytes:     30 * 1024,  // 30 KB
  facePaddingFactor: 1.5,       // 50 % padding around detected face
};

/** Path (relative to app root) where face-api model JSON files are served. */
const FACE_API_MODEL_URL = '/face-api-models';

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ImageProcessorService {

  // face-api requires HttpClient internally when loading models from URL
  private readonly http = inject(HttpClient);

  /** Tracks whether the face-api models have already been loaded. */
  private modelsLoaded = false;

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Entry point: convert a raw File into two processed Blobs.
   *
   * @param file   The original image selected by the user.
   * @param compressionCfg  Override defaults for the compression step.
   * @param thumbnailCfg    Override defaults for the thumbnail step.
   * @returns      Promise resolving to { compressed, thumbnail }.
   */
  async processImage(
    file: File,
    compressionCfg: CompressionConfig = DEFAULT_COMPRESSION,
    thumbnailCfg:    ThumbnailConfig    = DEFAULT_THUMBNAIL,
  ): Promise<ProcessedImages> {

    // 1. Decode the raw file into an HTMLImageElement so we can draw it.
    const img = await this.fileToImageElement(file);

    // 2. Run both pipelines concurrently to save time.
    const [compressed, thumbnail] = await Promise.all([
      this.createCompressedImage(img, compressionCfg),
      this.createFaceThumbnail(img, thumbnailCfg),
    ]);

    return { compressed, thumbnail };
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Compression Pipeline  (≤ 200 KB, 1080 p)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Resizes the image to fit within 1080 p then iteratively lowers JPEG
   * quality until the blob is ≤ maxSizeBytes.
   *
   * Strategy: binary-search-like adaptive loop.
   *   - Start high (initialQuality) to preserve as much fidelity as possible.
   *   - Step down by qualityStep each iteration.
   *   - Stop as soon as blob.size ≤ maxSizeBytes.
   *   - Never drop below minQuality to avoid extreme artefacts.
   */
  private async createCompressedImage(
    img: HTMLImageElement,
    cfg: CompressionConfig,
  ): Promise<Blob> {

    // Draw image onto a canvas capped at 1080 p dimensions.
    const canvas = this.resizeToCanvas(img, cfg.maxWidthPx, cfg.maxHeightPx);

    let quality = cfg.initialQuality;
    let blob    = await this.canvasToBlob(canvas, 'image/jpeg', quality);

    // Adaptive loop: reduce quality until size target is met.
    while (blob.size > cfg.maxSizeBytes && quality > cfg.minQuality) {
      quality = Math.max(quality - cfg.qualityStep, cfg.minQuality);
      blob    = await this.canvasToBlob(canvas, 'image/jpeg', quality);
    }

    // Edge case: even minQuality exceeds the limit (extremely large source).
    // Apply aggressive pixel-level downscale as last resort.
    if (blob.size > cfg.maxSizeBytes) {
      blob = await this.emergencyDownscale(canvas, cfg);
    }

    console.debug(
      `[ImageProcessor] Compressed → ${(blob.size / 1024).toFixed(1)} KB ` +
      `at quality=${quality.toFixed(2)}`,
    );
    return blob;
  }

  /**
   * Last-resort downscale: halve canvas dimensions until the size target is met.
   * Only called when quality-reduction alone cannot reach the target.
   */
  private async emergencyDownscale(
    canvas: HTMLCanvasElement,
    cfg:    CompressionConfig,
  ): Promise<Blob> {
    let w = canvas.width;
    let h = canvas.height;
    let blob: Blob;

    do {
      w = Math.floor(w * 0.8);
      h = Math.floor(h * 0.8);

      const scaledCanvas   = this.createCanvas(w, h);
      const ctx            = scaledCanvas.getContext('2d')!;
      ctx.drawImage(canvas, 0, 0, w, h);

      blob = await this.canvasToBlob(scaledCanvas, 'image/jpeg', cfg.minQuality);
    } while (blob!.size > cfg.maxSizeBytes && w > 200);

    return blob!;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Thumbnail Pipeline  (300 × 300, face-centred, ≤ 30 KB)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Generates a 300 × 300 face-centred thumbnail.
   *
   * Steps:
   *  1. Load face-api.js models (once, cached).
   *  2. Run tiny-face-detector on the image.
   *  3. If a face is found, expand its bounding box with padding and crop.
   *  4. If no face is found, fall back to centre-crop.
   *  5. Apply the same adaptive quality loop used for compression.
   */
  private async createFaceThumbnail(
    img: HTMLImageElement,
    cfg: ThumbnailConfig,
  ): Promise<Blob> {

    // Ensure face-api models are loaded before detection.
    await this.ensureFaceApiModels();

    // Attempt face detection using the lightweight Tiny Face Detector.
    const detection = await faceapi
      .detectSingleFace(img, new faceapi.TinyFaceDetectorOptions())
      .withFaceLandmarks(/* useTinyModel= */ true);

    // Compute the crop rectangle (face region or centre fallback).
    const cropRect = detection
      ? this.buildFaceCropRect(img, detection.detection.box, cfg.facePaddingFactor)
      : this.buildCentreCropRect(img);

    // Render the crop into a 300 × 300 canvas.
    const thumbCanvas = this.cropToSquareCanvas(img, cropRect, cfg.widthPx, cfg.heightPx);

    // Adaptive quality loop to stay under 30 KB.
    let quality = 0.85;
    let blob    = await this.canvasToBlob(thumbCanvas, 'image/jpeg', quality);

    while (blob.size > cfg.maxSizeBytes && quality > 0.05) {
      quality -= 0.05;
      blob     = await this.canvasToBlob(thumbCanvas, 'image/jpeg', quality);
    }

    console.debug(
      `[ImageProcessor] Thumbnail → ${(blob.size / 1024).toFixed(1)} KB ` +
      `| Face detected: ${!!detection}`,
    );
    return blob;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Face-API Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Loads the face-api TinyFaceDetector + 68-point landmark models from
   * /public/face-api-models/. Subsequent calls are no-ops (modelsLoaded flag).
   */
  private async ensureFaceApiModels(): Promise<void> {
    if (this.modelsLoaded) return;

    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(FACE_API_MODEL_URL),
      faceapi.nets.faceLandmark68TinyNet.loadFromUri(FACE_API_MODEL_URL),
    ]);

    this.modelsLoaded = true;
    console.debug('[ImageProcessor] face-api models loaded.');
  }

  /**
   * Expands a face bounding box by paddingFactor and clamps it within the
   * image dimensions so the crop always includes some neck/hair context.
   *
   * @param img           Source image element (for bounds clamping).
   * @param box           Raw bounding box returned by face-api.
   * @param paddingFactor e.g. 1.5 → 50 % padding around the face box.
   */
  private buildFaceCropRect(
    img:           HTMLImageElement,
    box:           faceapi.Box,
    paddingFactor: number,
  ): DOMRect {
    const padW = (box.width  * (paddingFactor - 1)) / 2;
    const padH = (box.height * (paddingFactor - 1)) / 2;

    const x = Math.max(0, box.x - padW);
    const y = Math.max(0, box.y - padH);
    const w = Math.min(img.naturalWidth  - x, box.width  + padW * 2);
    const h = Math.min(img.naturalHeight - y, box.height + padH * 2);

    // Make the crop square by taking the smaller dimension.
    const side = Math.min(w, h);
    const cx   = Math.max(0, x + (w - side) / 2);
    const cy   = Math.max(0, y + (h - side) / 2);

    return new DOMRect(cx, cy, side, side);
  }

  /**
   * Fallback: extract a centred square from the image when no face is found.
   */
  private buildCentreCropRect(img: HTMLImageElement): DOMRect {
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const x    = (img.naturalWidth  - side) / 2;
    const y    = (img.naturalHeight - side) / 2;
    return new DOMRect(x, y, side, side);
  }

  /**
   * Draws a cropped region of `img` into a new canvas of the specified size.
   */
  private cropToSquareCanvas(
    img:    HTMLImageElement,
    rect:   DOMRect,
    width:  number,
    height: number,
  ): HTMLCanvasElement {
    const canvas = this.createCanvas(width, height);
    const ctx    = canvas.getContext('2d')!;

    ctx.drawImage(
      img,
      rect.x, rect.y, rect.width, rect.height,  // source region
      0,      0,      width,       height,        // destination
    );
    return canvas;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Canvas / Blob Utilities
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Resizes an image element onto a new canvas, preserving aspect ratio and
   * never exceeding maxWidth × maxHeight.
   */
  private resizeToCanvas(
    img:       HTMLImageElement,
    maxWidth:  number,
    maxHeight: number,
  ): HTMLCanvasElement {
    const { naturalWidth: w, naturalHeight: h } = img;
    const scale  = Math.min(maxWidth / w, maxHeight / h, 1); // never upscale
    const canvas = this.createCanvas(Math.round(w * scale), Math.round(h * scale));
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  /**
   * Wraps canvas.toBlob in a Promise so it can be awaited.
   */
  private canvasToBlob(
    canvas:  HTMLCanvasElement,
    type:    string,
    quality: number,
  ): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error('Canvas toBlob returned null')),
        type,
        quality,
      );
    });
  }

  /**
   * Decodes a File into an HTMLImageElement, waiting for the load event.
   */
  private fileToImageElement(file: File): Promise<HTMLImageElement> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();

      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image load failed')); };

      img.src = url;
    });
  }

  /** Helper: creates an off-screen canvas of the given size. */
  private createCanvas(width: number, height: number): HTMLCanvasElement {
    const canvas  = document.createElement('canvas');
    canvas.width  = width;
    canvas.height = height;
    return canvas;
  }
}
