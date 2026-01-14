import { Component, Input, inject } from '@angular/core';
import { FormGroup, ReactiveFormsModule, FormControl } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { MatExpansionModule } from '@angular/material/expansion';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import { IParameter, IJsonError } from '../../shared/types';
import { ErrorHandlerService } from '../shared/services/error-handler.service';

@Component({
  selector: 'app-parameter-group',
  standalone: true,
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    MatSlideToggleModule,
    MatIconModule,
    MatButtonModule,
    MatExpansionModule
  ],
  templateUrl: './parameter-group.component.html',
  styleUrl: './parameter-group.component.scss'
})
export class ParameterGroupComponent {
  @Input({ required: true }) groupName!: string;
  @Input({ required: true }) groupedParameters!: Record<string, IParameter[]>;
  @Input({ required: true }) form!: FormGroup;
  @Input({ required: true }) showAdvanced!: boolean;

  private errorHandler = inject(ErrorHandlerService);
  private sanitizer = inject(DomSanitizer);
  expandedHelp: Record<string, boolean> = {};

  getTooltip(param: IParameter): string | undefined {
    // Only show tooltip if help is not expandable
    if (this.hasExpandableHelp(param)) {
      return undefined;
    }
    return param.description;
  }

  hasExpandableHelp(param: IParameter): boolean {
    const desc = param.description || '';
    // Check for markdown indicators: newlines, list markers, code blocks, etc.
    return desc.length > 150 || 
           desc.includes('\n') || 
           desc.includes('- ') ||
           desc.includes('* ') ||
           desc.includes('```') ||
           desc.includes('Example:') ||
           desc.includes('Format:');
  }

  toggleHelp(paramId: string): void {
    this.expandedHelp[paramId] = !this.expandedHelp[paramId];
  }

  isHelpExpanded(paramId: string): boolean {
    return this.expandedHelp[paramId] || false;
  }

  getMarkdownHelp(param: IParameter): SafeHtml {
    const markdown = param.description || '';
    const html = marked.parse(markdown, { async: false }) as string;
    return this.sanitizer.sanitize(1, html) || '';
  }

  getEnumOptionLabel(option: string | { name: string; value: string | number | boolean }): string {
    return typeof option === 'string' ? option : option.name;
  }

  getEnumOptionValue(option: string | { name: string; value: string | number | boolean }): string | number | boolean {
    return typeof option === 'string' ? option : option.value;
  }

  isVisible(param: IParameter): boolean {
    if (param.advanced && !this.showAdvanced) return false;
    if (param.if && !this.form.get(param.if)?.value) return false;
    // For enum parameters with enumValuesTemplate, only hide if enumValues is an empty array
    // Show the field if enumValues is undefined (error case) or has values
    if (param.type === 'enum' && param.enumValues !== undefined) {
      // Only hide if it's an empty array (no devices found)
      // Show if undefined (error) or has values
      if (Array.isArray(param.enumValues) && param.enumValues.length === 0) {
        return false;
      }
    }
    return true;
  }

  isGroupVisible(): boolean {
    const params = this.groupedParameters[this.groupName];
    return params?.some(p => this.isVisible(p)) ?? false;
  }

  get params(): IParameter[] {
    return this.groupedParameters[this.groupName] || [];
  }

  async onFileSelected(event: Event, paramId: string): Promise<void> {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      try {
        const base64 = await this.readFileAsBase64(file);
        this.form.get(paramId)?.setValue(base64);
        this.form.get(paramId)?.markAsTouched();
      } catch (error) {
        const errors: IJsonError[] = [{
          name: 'FileReadError',
          message: `Failed to read file: ${error}`,
          details: undefined
        } as IJsonError];
        this.errorHandler.showErrorDialog(errors);
      }
    }
  }

  private readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:application/pdf;base64,")
        const base64 = result.includes(',') ? result.split(',')[1] : result;
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }
}

