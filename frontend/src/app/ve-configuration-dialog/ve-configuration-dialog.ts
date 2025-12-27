
// ...existing code...
import { Component, OnInit, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef, MatDialog } from '@angular/material/dialog';

import { FormsModule, ReactiveFormsModule, FormBuilder, FormGroup, Validators, FormControl } from '@angular/forms';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatButtonModule } from '@angular/material/button';
import { IApplicationWeb, IParameter, IParameterValue, IJsonError } from '../../shared/types';
import { VeConfigurationService, VeConfigurationParam } from '../ve-configuration.service';
import { ErrorDialog } from '../applications-list/error-dialog';
import type { NavigationExtras } from '@angular/router';
@Component({
  selector: 'app-ve-configuration-dialog',
  standalone: true,
  imports: [
    MatDialogModule,
    FormsModule,
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    MatSlideToggleModule,
    MatIconModule,
    MatButtonModule
],
  templateUrl: './ve-configuration-dialog.html',
  styleUrl: './ve-configuration-dialog.scss',
})
export class VeConfigurationDialog implements OnInit {
  form: FormGroup;
  unresolvedParameters: IParameter[] = [];
  groupedParameters: Record<string, IParameter[]> = {};
  loading = signal(true);
  hasError = signal(false);
  showAdvanced = signal(false);
  private initialValues = new Map<string, IParameterValue>();
  private configService: VeConfigurationService = inject(VeConfigurationService);
  public dialogRef: MatDialogRef<VeConfigurationDialog> = inject(MatDialogRef<VeConfigurationDialog>);
  private dialog = inject(MatDialog);
  private fb: FormBuilder = inject(FormBuilder);
  public data = inject(MAT_DIALOG_DATA) as { app: IApplicationWeb };
  constructor(  ) {
    this.form = this.fb.group({});
  }
  ngOnInit(): void {
    // For demo purposes: use 'installation' as the default task, can be extended
    this.configService.getUnresolvedParameters(this.data.app.id, 'installation').subscribe({
      next: (res) => {
        this.unresolvedParameters = res.unresolvedParameters;
        // Group parameters by template
        this.groupedParameters = {};
        for (const param of this.unresolvedParameters) {
          const group = param.templatename || 'General';
          if (!this.groupedParameters[group]) this.groupedParameters[group] = [];
          this.groupedParameters[group].push(param);
          const validators = param.required ? [Validators.required] : [];
          const defaultValue = param.default !== undefined ? param.default : '';
          this.form.addControl(param.id, new FormControl(defaultValue, validators));
          // Store initial value for comparison
          this.initialValues.set(param.id, defaultValue);
        }
        // Sort parameters in each group: required first, then optional
        for (const group in this.groupedParameters) {
          this.groupedParameters[group] = this.groupedParameters[group].slice().sort((a, b) => Number(!!b.required) - Number(!!a.required));
        }
        this.form.markAllAsTouched();
        this.loading.set(false);
      },
      error: (err: unknown) => {
        const errors = this.convertErrorToJsonErrors('Failed to load parameters', err);
        this.showErrorDialog(errors);
        this.loading.set(false);
        this.hasError.set(true);
        // Note: Dialog remains open so user can see the error and close manually
      }
    });
  }

  getTooltip(param: IParameter): string | undefined {
    return param.description;
  }

  getEnumOptionLabel(option: string | { name: string; value: string | number | boolean }): string {
    return typeof option === 'string' ? option : option.name;
  }

  getEnumOptionValue(option: string | { name: string; value: string | number | boolean }): string | number | boolean {
    return typeof option === 'string' ? option : option.value;
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
        this.showErrorDialog(errors);
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

  save() {
    if (this.form.invalid) return;
    this.loading.set(true);
    
    // Separate params and changed parameters
    const params: VeConfigurationParam[] = [];
    const changedParams: VeConfigurationParam[] = [];
    
    for (const [paramId, currentValue] of Object.entries(this.form.value) as [string, IParameterValue][]) {
      const initialValue = this.initialValues.get(paramId);
      // Check if value has changed (compare with initial value)
      const hasChanged = initialValue !== currentValue && 
                        (currentValue !== null && currentValue !== undefined && currentValue !== '');
      
      if (hasChanged) {
        // Collect changed parameters for vmInstallContext
        if (currentValue !== null && currentValue !== undefined && currentValue !== '') {
          changedParams.push({ name: paramId, value: currentValue as IParameterValue });
          params.push({ name: paramId, value: currentValue as IParameterValue });
        }
      } else if (currentValue !== null && currentValue !== undefined && currentValue !== '') {
        // Include unchanged values that are not empty (for required fields)
        params.push({ name: paramId, value: currentValue as IParameterValue });
      }
    }
    
    const application = this.data.app.id;
    const task = 'installation';
    
    // Pass changedParams to backend for vmInstallContext
        this.configService.postVeConfiguration(application, task, params, changedParams.length > 0 ? changedParams : undefined).subscribe({
          next: (res) => {
            this.loading.set(false);
            // Navigate to process monitor; pass restartKey, vmInstallKey and original parameters
            const extras: NavigationExtras = {
              queryParams: res.restartKey ? { restartKey: res.restartKey } : {},
              state: { 
                originalParams: params,
                application: application,
                task: task,
                restartKey: res.restartKey,
                vmInstallKey: res.vmInstallKey
              }
            };
            this.dialogRef.close(this.form.value);
            this.configService['router'].navigate(['/monitor'], extras);
          },
      error: (err: unknown) => {
        const errors = this.convertErrorToJsonErrors('Failed to install configuration', err);
        this.showErrorDialog(errors);
        this.loading.set(false);
      }
    });
  }

  close(): void {
    this.dialogRef.close();
  }

  toggleAdvanced(): void {
    this.showAdvanced.set(!this.showAdvanced());
  }

  hasAdvancedParams(): boolean {
    return this.unresolvedParameters.some(p => p.advanced);
  }

  isVisible(param: IParameter): boolean {
    if (param.advanced && !this.showAdvanced()) return false;
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

  isGroupVisible(groupName: string): boolean {
    const params = this.groupedParameters[groupName];
    return params?.some(p => this.isVisible(p)) ?? false;
  }

  get groupNames(): string[] {
    return Object.keys(this.groupedParameters);
  }

  private convertErrorToJsonErrors(prefix: string, err: unknown): IJsonError[] {
    if (!err) {
      return [{
        name: 'Error',
        message: prefix,
        details: undefined
      } as IJsonError];
    }

    try {
      const errObj = err as Record<string, unknown>;
      // HTTP errors from Angular HttpClient have the response body in the 'error' property
      // Backend returns: { success: false, error: <error message>, errorDetails: <error object> }
      const errorBody = errObj['error'] as Record<string, unknown> | string | undefined;
      
      // Handle case where errorBody is an object (from HTTP error response)
      if (errorBody && typeof errorBody === 'object') {
        // First, check for errorDetails (VE routes use this)
        const errorDetails = errorBody['errorDetails'] as Record<string, unknown> | undefined;
        if (errorDetails && typeof errorDetails === 'object') {
          const name = (errorDetails['name'] as string) || 'Error';
          const message = (errorDetails['message'] as string) || '';
          const details = errorDetails['details'];
          
          const convertedDetails: IJsonError[] | undefined = this.convertDetailsArray(details);
          
          return [{
            name: name,
            message: prefix ? `${prefix}: ${message}` : message,
            details: convertedDetails
          } as IJsonError];
        }
        
        // Check for serializedError (legacy support for other routes)
        const serializedError = errorBody['serializedError'];
        if (serializedError && typeof serializedError === 'object') {
          const name = ((serializedError as Record<string, unknown>)['name'] as string) || 'Error';
          const message = ((serializedError as Record<string, unknown>)['message'] as string) || '';
          const details = (serializedError as Record<string, unknown>)['details'];
          
          const convertedDetails: IJsonError[] | undefined = this.convertDetailsArray(details);
          
          return [{
            name: name,
            message: prefix ? `${prefix}: ${message}` : message,
            details: convertedDetails
          } as IJsonError];
        }
        
        // Check if errorBody has nested 'error' property (from backend response structure)
        const nestedError = errorBody['error'] as Record<string, unknown> | undefined;
        
        // If nested error exists and is an object, use it (this is the actual error structure)
        if (nestedError && typeof nestedError === 'object') {
          const name = (nestedError['name'] as string) || 'Error';
          const message = (nestedError['message'] as string) || '';
          const details = nestedError['details'];
          
          const convertedDetails: IJsonError[] | undefined = this.convertDetailsArray(details);
          
          return [{
            name: name,
            message: prefix ? `${prefix}: ${message}` : message,
            details: convertedDetails
          } as IJsonError];
        }
        
        // If errorBody itself has name/message/details (direct error object), use it
        if (errorBody['name'] || errorBody['message']) {
          const name = (errorBody['name'] as string) || 'Error';
          const message = (errorBody['message'] as string) || '';
          const details = errorBody['details'];
          
          const convertedDetails: IJsonError[] | undefined = this.convertDetailsArray(details);
          
          return [{
            name: name,
            message: prefix ? `${prefix}: ${message}` : message,
            details: convertedDetails
          } as IJsonError];
        }
        
        // Handle case where errorBody.error is a string (but only if errorDetails was not found)
        // This should be checked AFTER errorDetails to avoid overriding detailed errors
        const errorMessage = errorBody['error'];
        if (typeof errorMessage === 'string' && errorMessage.length > 0) {
          // Only use this as fallback if we haven't already found errorDetails
          // This prevents script output from overriding validation errors
          return [{
            name: 'Error',
            message: `${prefix}: ${errorMessage}`,
            details: undefined
          } as IJsonError];
        }
        
        // Fallback: stringify the error body
        return [{
          name: 'Error',
          message: `${prefix}: ${JSON.stringify(errorBody)}`,
          details: undefined
        } as IJsonError];
      }
      
      // Handle case where errorBody is a string directly
      if (typeof errorBody === 'string') {
        return [{
          name: 'Error',
          message: `${prefix}: ${errorBody}`,
          details: undefined
        } as IJsonError];
      }
      
      // Handle case where err has a message property (direct Error object)
      if (errObj['message']) {
        return [{
          name: 'Error',
          message: `${prefix}: ${errObj['message']}`,
          details: undefined
        } as IJsonError];
      }
      
      // Final fallback
      return [{
        name: 'Error',
        message: `${prefix}: ${JSON.stringify(err)}`,
        details: undefined
      } as IJsonError];
    } catch {
      return [{
        name: 'Error',
        message: `${prefix}: ${String(err)}`,
        details: undefined
      } as IJsonError];
    }
  }

  /**
   * Converts a details array (which can be nested) to IJsonError[].
   * Handles both flat arrays and nested structures recursively.
   */
  private convertDetailsArray(details: unknown): IJsonError[] | undefined {
    if (!details) {
      return undefined;
    }
    
    if (!Array.isArray(details)) {
      return undefined;
    }
    
    if (details.length === 0) {
      return undefined;
    }
    
    return details.map((d: unknown) => {
      if (!d || typeof d !== 'object') {
        return {
          name: 'Error',
          message: String(d),
          details: undefined
        } as IJsonError;
      }
      
      const detailObj = d as Record<string, unknown>;
      const nestedDetails = detailObj['details'];
      
      return {
        name: (detailObj['name'] as string) || undefined,
        message: (detailObj['message'] as string) || JSON.stringify(detailObj),
        line: detailObj['line'] as number | undefined,
        details: this.convertDetailsArray(nestedDetails)
      } as IJsonError;
    });
  }
  
  /**
   * @deprecated Use convertDetailsArray instead
   */
  private convertDetailsRecursive(details: Record<string, unknown>[]): IJsonError[] {
    return this.convertDetailsArray(details) || [];
  }

  private showErrorDialog(errors: IJsonError[]): void {
    this.dialog.open(ErrorDialog, { 
      data: { errors }, 
      panelClass: 'error-dialog-panel' 
    });
  }
}
