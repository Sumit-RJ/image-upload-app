/**
 * @file app.config.ts
 * @description Angular 20 application configuration.
 *
 * Key choices:
 *  - provideZonelessChangeDetection()  → No Zone.js; signals drive all updates.
 *  - provideHttpClient(withInterceptorsFromDi()) → enables progress events.
 */

import { ApplicationConfig, provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { mockUploadInterceptor } from './mock-upload.interceptor';
import { provideRouter }                                       from '@angular/router';

export const appConfig: ApplicationConfig = {
  providers: [
    // ── Zoneless change detection (Angular 18+, stable in Angular 20) ─────
    // Required for signals-based components with OnPush to work correctly
    // without Zone.js side-effects.
    provideZonelessChangeDetection(),

    // ── HTTP client with progress event support ────────────────────────────
    // withInterceptorsFromDi() allows token-based interceptors (e.g. auth JWT)
    // to be added later without changing this config.
    provideHttpClient(withInterceptors([mockUploadInterceptor])),

    // ── Router (add your routes here as the app grows) ────────────────────
    provideRouter([
      {
        path:      '',
        loadComponent: () =>
          import('./features/image-upload/image-upload.component')
            .then(m => m.ImageUploadComponent),
      },
    ]),
  ],
};
