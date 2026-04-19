/**
 * @file image-upload.component.ts
 * @description Angular 20 standalone component that orchestrates the full
 *              image-processing + upload pipeline. Uses Angular Signals for
 *              reactive, fine-grained state management without Zone.js overhead.
 *
 * State flow:
 *   Idle → Validating → Processing → Uploading → Complete | Error
 */

import {
  Component,
  inject,
  signal,
  computed,
  effect,
  ChangeDetectionStrategy,
  ElementRef,
  viewChild,
}                                          from '@angular/core';
import { CommonModule }                    from '@angular/common';
import { ImageProcessorService }           from './services/image-processor.service';
import { ImageUploadApiService }           from './services/image-upload-api.service';
import {
  ProcessedImages,
  UploadProgress,
  UploadStage,
}                                          from './models/image-upload.models';

/** Allowed MIME types for file validation. */
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/** Maximum raw input file size (50 MB) – prevents reading enormous files. */
const MAX_INPUT_SIZE_MB = 50;

/**
 * Maps stage chip label → its pipeline order index.
 * Used by isStageComplete / isStageActive to drive chip styling.
 */
const STAGE_ORDER: Record<string, number> = {
  [UploadStage.Validating]: 1,
  [UploadStage.Processing]: 2,
  [UploadStage.Uploading]:  3,
  [UploadStage.Complete]:   4,
};

/** Maps the display label shown in the template → the enum value it maps to. */
const CHIP_LABEL_TO_STAGE: Record<string, UploadStage> = {
  Validating: UploadStage.Validating,
  Processing: UploadStage.Processing,
  Uploading:  UploadStage.Uploading,
  Complete:   UploadStage.Complete,
};

@Component({
  selector:         'app-image-upload',
  standalone:       true,
  imports:          [CommonModule],
  templateUrl:      './image-upload.component.html',
  styleUrl:         './image-upload.component.scss',
  // OnPush + signals = zero unnecessary re-renders.
  changeDetection:  ChangeDetectionStrategy.OnPush,
})
export class ImageUploadComponent {

  // ── Service Injection ──────────────────────────────────────────────────────
  private readonly processor = inject(ImageProcessorService);
  private readonly uploader  = inject(ImageUploadApiService);

  // ── View References ────────────────────────────────────────────────────────
  /** Hidden native <input type="file"> triggered programmatically. */
  private readonly fileInput = viewChild.required<ElementRef<HTMLInputElement>>('fileInput');

  // ── Signals (Reactive State) ───────────────────────────────────────────────

  /** The file currently selected by the user (null when none). */
  readonly selectedFile  = signal<File | null>(null);

  /** Object URL for the original preview. Revoked when replaced. */
  readonly previewUrl    = signal<string | null>(null);

  /** Object URL for the compressed image preview (post-processing). */
  readonly compressedUrl = signal<string | null>(null);

  /** Object URL for the thumbnail preview (post-processing). */
  readonly thumbnailUrl  = signal<string | null>(null);

  /** Current upload/processing progress. */
  readonly progress      = signal<UploadProgress>({
    percentage: 0,
    stage:      UploadStage.Idle,
    message:    '',
  });

  /** Non-null when a validation or processing error has occurred. */
  readonly errorMessage  = signal<string | null>(null);

  // ── Computed Signals ───────────────────────────────────────────────────────

  /** True while the pipeline is running (disables UI controls). */
  readonly isBusy = computed(() => {
    const s = this.progress().stage;
    return s === UploadStage.Processing || s === UploadStage.Uploading;
  });

  /** True only after a fully successful upload. */
  readonly isComplete = computed(() => this.progress().stage === UploadStage.Complete);

  /** Expose UploadStage enum to the template (Angular templates can't access enums directly). */
  readonly Stage = UploadStage;

  // ── Effects ────────────────────────────────────────────────────────────────

  constructor() {
    /**
     * Automatically revoke object URLs when they are replaced, preventing
     * memory leaks. The onCleanup callback runs before the next effect run
     * and on component destroy.
     */
    effect((onCleanup) => {
      const urls = [
        this.previewUrl(),
        this.compressedUrl(),
        this.thumbnailUrl(),
      ].filter(Boolean) as string[];

      onCleanup(() => urls.forEach((u) => URL.revokeObjectURL(u)));
    });
  }

  // ──────────────────────────────────────────────────────────────────────────
  // User Interaction Handlers
  // ──────────────────────────────────────────────────────────────────────────

  /** Opens the hidden file picker programmatically. */
  openFilePicker(): void {
    this.fileInput().nativeElement.click();
  }

  /** Prevents browser default (open file) so the drop event fires. */
  onDragOver(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
  }

  /** Handles a file dropped onto the drop zone. */
  onDrop(event: DragEvent): void {
    event.preventDefault();
    event.stopPropagation();
    const file = event.dataTransfer?.files[0];
    if (file) this.handleFile(file);
  }

  /** Handles a file selected via the native <input> picker. */
  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file  = input.files?.[0];
    if (file) this.handleFile(file);
    input.value = '';  // allow re-selecting same file
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Stage Chip Helpers (consumed by the template @for loop)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Returns true when the given chip's pipeline stage has already been passed.
   * Used to apply the green "done" chip style.
   */
  isStageComplete(chipLabel: string): boolean {
    const enumStage    = CHIP_LABEL_TO_STAGE[chipLabel];
    const currentOrder = STAGE_ORDER[this.progress().stage] ?? 0;
    const chipOrder    = STAGE_ORDER[enumStage]             ?? 0;
    return currentOrder > chipOrder;
  }

  /**
   * Returns true when the given chip represents the currently active stage.
   * Used to apply the blue "active" chip style.
   */
  isStageActive(chipLabel: string): boolean {
    const enumStage = CHIP_LABEL_TO_STAGE[chipLabel];
    return this.progress().stage === enumStage;
  }

  /** Resets all state so the user can start a new upload. */
  reset(): void {
    this.resetState();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Private Pipeline
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Entry point for both pick and drop: validates then starts the pipeline.
   */
  private handleFile(file: File): void {
    this.resetState();

    const validationError = this.validateFile(file);
    if (validationError) {
      this.errorMessage.set(validationError);
      this.progress.set({ percentage: 0, stage: UploadStage.Error, message: validationError });
      return;
    }

    this.selectedFile.set(file);
    this.previewUrl.set(URL.createObjectURL(file));
    this.runPipeline(file);
  }

  /**
   * Full async pipeline:
   *   1. Compress image + generate face thumbnail (client-side canvas).
   *   2. Show local previews.
   *   3. Upload both blobs via HttpClient with real-time progress events.
   */
  private async runPipeline(file: File): Promise<void> {
    try {

      // ── Step 1: Client-side processing ───────────────────────────────────
      this.progress.set({
        percentage: 10,
        stage:      UploadStage.Processing,
        message:    'Compressing image and generating face thumbnail…',
      });

      const processed: ProcessedImages = await this.processor.processImage(file);

      // Immediately display the processed results for user feedback.
      this.compressedUrl.set(URL.createObjectURL(processed.compressed));
      this.thumbnailUrl.set(URL.createObjectURL(processed.thumbnail));

      this.progress.set({
        percentage: 20,
        stage:      UploadStage.Processing,
        message:    'Processing complete — starting upload…',
      });

      // ── Step 2: Upload stream ────────────────────────────────────────────
      this.uploader
        .uploadImages(processed.compressed, processed.thumbnail)
        .subscribe({
          next:  (prog) => this.progress.set(prog),
          error: (errProg: UploadProgress) => {
            this.progress.set(errProg);
            this.errorMessage.set(errProg.message);
          },
        });

    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Image processing failed.';
      this.errorMessage.set(msg);
      this.progress.set({ percentage: 0, stage: UploadStage.Error, message: msg });
    }
  }

  /**
   * Validates the selected file's MIME type and size.
   * Returns an error string, or null on success.
   */
  private validateFile(file: File): string | null {
    this.progress.set({ percentage: 0, stage: UploadStage.Validating, message: 'Validating…' });

    if (!ALLOWED_TYPES.includes(file.type)) {
      return `Unsupported type "${file.type}". Use JPEG, PNG, or WebP.`;
    }

    if (file.size > MAX_INPUT_SIZE_MB * 1024 * 1024) {
      return `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_INPUT_SIZE_MB} MB.`;
    }

    return null;
  }

  /** Clears every reactive state signal back to its default. */
  private resetState(): void {
    this.selectedFile.set(null);
    this.previewUrl.set(null);
    this.compressedUrl.set(null);
    this.thumbnailUrl.set(null);
    this.errorMessage.set(null);
    this.progress.set({ percentage: 0, stage: UploadStage.Idle, message: '' });
  }
}
