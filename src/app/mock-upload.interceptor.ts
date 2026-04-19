import { HttpInterceptorFn, HttpResponse } from '@angular/common/http';
import { of, delay } from 'rxjs';

/** Intercepts upload calls and returns a fake success response after 2 s. */
export const mockUploadInterceptor: HttpInterceptorFn = (req, next) => {
  if (req.url.includes('/api/images/upload')) {
    console.log('[Mock] Intercepted upload request — returning fake success');
    return of(new HttpResponse({
      status: 200,
      body: {
        success: true,
        compressedImageUrl: 'https://example.com/compressed.jpg',
        thumbnailImageUrl:  'https://example.com/thumbnail.jpg',
        message: 'Mock upload complete!',
      }
    })).pipe(delay(2000));  // simulate 2 s network latency
  }
  return next(req);
};