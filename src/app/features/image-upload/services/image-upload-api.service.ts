/**
 * @file image-upload-api.service.ts
 * @description Sends the two processed image streams (compressed + thumbnail)
 *              to the .NET 10 Web API endpoint as a multipart/form-data request.
 *
 * Features:
 *  - Upload progress percentage via HttpClient reportProgress events.
 *  - Exponential-backoff retry using RxJS operators.
 *  - Typed response mapped to UploadResponse.
 */

import { Injectable, inject }                               from '@angular/core';
import {
  HttpClient,
  HttpEvent,
  HttpEventType,
  HttpRequest,
  HttpResponse,
}                                                           from '@angular/common/http';
import { Observable, throwError, timer }                    from 'rxjs';
import { catchError, filter, map, retry, switchMap }        from 'rxjs/operators';
import { RetryConfig, UploadProgress, UploadResponse, UploadStage } from '../models/image-upload.models';

// ─── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_RETRY: RetryConfig = {
  maxAttempts: 3,
  delayMs:     1000,   // 1 s → 2 s → 4 s (exponential back-off)
};

/** Base URL of your .NET 10 Web API. Override via environment config. */
const API_BASE_URL = '/api';

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable({ providedIn: 'root' })
export class ImageUploadApiService {

  private readonly http = inject(HttpClient);

  // ──────────────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Uploads both image blobs to the .NET 10 endpoint.
   *
   * Emits a stream of UploadProgress objects so the UI can update a progress
   * bar in real-time. Completes with a final { stage: Complete } emission
   * containing the server response URLs.
   *
   * @param compressed  The ≤ 200 KB JPEG blob (1080 p).
   * @param thumbnail   The ≤ 60 KB JPEG blob (300 × 300, face-centred).
   * @param retryCfg    Optional retry configuration override.
   */
  uploadImages(
    compressed: Blob,
    thumbnail:  Blob,
    retryCfg:   RetryConfig = DEFAULT_RETRY,
  ): Observable<UploadProgress> {

    // Build a multipart/form-data body.
    // Angular's HttpClient sets Content-Type + boundary automatically.
    const formData = new FormData();
    formData.append('compressedImage', compressed, 'compressed.jpg');
    formData.append('thumbnailImage',  thumbnail,  'thumbnail.jpg');

    // Build the request with progress reporting enabled.
    const req = new HttpRequest('POST', `${API_BASE_URL}/images/upload`, formData, {
      reportProgress: true,
      // Do NOT set Content-Type header manually — the browser must set the
      // multipart boundary automatically.
    });

    return this.http.request<UploadResponse>(req).pipe(

      // ── Retry with exponential back-off ──────────────────────────────────
      retry({
        count: retryCfg.maxAttempts,
        delay: (error, attempt) => {
          const backoffMs = retryCfg.delayMs * Math.pow(2, attempt - 1);
          console.warn(
            `[UploadService] Attempt ${attempt} failed. ` +
            `Retrying in ${backoffMs} ms…`, error,
          );
          return timer(backoffMs);
        },
        resetOnSuccess: true,
      }),

      // ── Map HttpEvents → UploadProgress ──────────────────────────────────
      map((event: HttpEvent<UploadResponse>) => this.mapEventToProgress(event)),

      // ── Filter: only emit meaningful progress updates ─────────────────────
      filter((progress): progress is UploadProgress => progress !== null),

      // ── Error handler ─────────────────────────────────────────────────────
      catchError((err) => {
        console.error('[UploadService] Upload failed after all retries:', err);
        const errorProgress: UploadProgress = {
          percentage: 0,
          stage:      UploadStage.Error,
          message:    this.extractErrorMessage(err),
        };
        return throwError(() => errorProgress);
      }),
    );
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private Helpers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Converts a raw HttpEvent into a structured UploadProgress object.
   * Returns null for event types we don't care about (e.g. Sent).
   */
  private mapEventToProgress(
    event: HttpEvent<UploadResponse>,
  ): UploadProgress | null {

    switch (event.type) {

      // Request has been dispatched to the server.
      case HttpEventType.Sent:
        return {
          percentage: 5,
          stage:      UploadStage.Uploading,
          message:    'Connecting to server…',
        };

      // Upload body bytes are being transferred.
      case HttpEventType.UploadProgress: {
        const total   = event.total ?? 1;
        // Map upload bytes to the 5 %–90 % range so there's headroom for the
        // server-side processing phase (90 %–100 %).
        const percent = Math.round(5 + (event.loaded / total) * 85);
        return {
          percentage: percent,
          stage:      UploadStage.Uploading,
          message:    `Uploading… ${percent}%`,
        };
      }

      // Server has returned a full response.
      case HttpEventType.Response: {
        const res = event as HttpResponse<UploadResponse>;
        if (res.ok && res.body) {
          return {
            percentage: 100,
            stage:      UploadStage.Complete,
            message:    res.body.message || 'Upload complete!',
          };
        }
        // Non-2xx status falls through to catchError.
        return null;
      }

      default:
        return null;
    }
  }

  /**
   * Extracts a user-friendly error message from an HttpErrorResponse.
   */
  private extractErrorMessage(err: unknown): string {
    if (err && typeof err === 'object' && 'error' in err) {
      const httpErr = err as { error: { message?: string }; status: number };
      if (httpErr.error?.message) return httpErr.error.message;
      return `Server error (HTTP ${httpErr.status})`;
    }
    return 'An unexpected error occurred. Please try again.';
  }
}
