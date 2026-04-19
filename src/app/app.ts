import { Component } from '@angular/core';
import { ImageUploadComponent } from './features/image-upload/image-upload.component';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [ImageUploadComponent],
  template: `<app-image-upload />`
})
export class App {}