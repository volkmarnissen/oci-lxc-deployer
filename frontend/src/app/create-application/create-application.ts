import { Component, OnInit, OnDestroy, signal, inject, ViewChild } from '@angular/core';
import { MatStepper } from '@angular/material/stepper';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule, FormControl, AbstractControl, ValidationErrors, AsyncValidatorFn } from '@angular/forms';
import { Observable, of } from 'rxjs';
import { map, catchError } from 'rxjs/operators';
import { MatStepperModule } from '@angular/material/stepper';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatIconModule } from '@angular/material/icon';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { VeConfigurationService } from '../ve-configuration.service';
import { ErrorHandlerService } from '../shared/services/error-handler.service';
import { CacheService } from '../shared/services/cache.service';
import { IFrameworkName, IParameter, IParameterValue, IPostFrameworkFromImageResponse } from '../../shared/types';
import { ParameterGroupComponent } from '../ve-configuration-dialog/parameter-group.component';
import { Subject, takeUntil, debounceTime, distinctUntilChanged } from 'rxjs';

@Component({
  selector: 'app-create-application',
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    MatStepperModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatCardModule,
    MatTooltipModule,
    MatIconModule,
    ParameterGroupComponent
  ],
  templateUrl: './create-application.html',
  styleUrl: './create-application.scss'
})
export class CreateApplication implements OnInit, OnDestroy {
  @ViewChild('stepper') stepper!: MatStepper;
  
  private fb = inject(FormBuilder);
  private configService = inject(VeConfigurationService);
  private router = inject(Router);
  private errorHandler = inject(ErrorHandlerService);
  private cacheService = inject(CacheService);

  // Step 1: Framework selection
  frameworks: IFrameworkName[] = [];
  selectedFramework: IFrameworkName | null = null;
  loadingFrameworks = signal(true);
  
  // OCI Image input (only for oci-image framework)
  imageReference = signal('');
  loadingImageAnnotations = signal(false);
  imageError = signal<string | null>(null);
  imageAnnotationsReceived = signal(false);
  private imageInputSubject = new Subject<string>();
  private destroy$ = new Subject<void>();
  private imageAnnotationsTimeout: ReturnType<typeof setTimeout> | null = null;
  private lastAnnotationsResponse: IPostFrameworkFromImageResponse | null = null;

  // Step 2: Application properties
  appPropertiesForm: FormGroup = this.fb.group({
    name: ['', [Validators.required]],
    applicationId: ['', [Validators.required, Validators.pattern(/^[a-z0-9-]+$/)]],
    description: ['', [Validators.required]],
    url: [''],
    documentation: [''],
    source: [''],
    vendor: [''],
  });
  
  // Application ID validation
  applicationIdError = signal<string | null>(null);
  private applicationIdSubject = new Subject<string>();
  
  // Icon upload
  selectedIconFile: File | null = null;
  iconPreview = signal<string | null>(null);
  iconContent = signal<string | null>(null);

  // Step 3: Parameters
  parameters: IParameter[] = [];
  parameterForm: FormGroup = this.fb.group({});
  groupedParameters: Record<string, IParameter[]> = {};
  showAdvanced = signal(false);
  loadingParameters = signal(false);

  // Step 4: Summary
  creating = signal(false);
  createError = signal<string | null>(null);
  createErrorStep = signal<number | null>(null); // Step number to navigate to on error

  ngOnInit(): void {
    // Preload cache in background
    this.cacheService.preloadAll();
    // Load frameworks from cache (or fetch if not cached)
    this.loadFrameworks();
    
    // Set up async validator for applicationId
    const applicationIdControl = this.appPropertiesForm.get('applicationId');
    if (applicationIdControl) {
      applicationIdControl.setAsyncValidators([this.applicationIdUniqueValidator()]);
    }
    
    // Debounce image input changes and trigger API call
    this.imageInputSubject.pipe(
      takeUntil(this.destroy$),
      debounceTime(500), // Wait 500ms after user stops typing
      distinctUntilChanged()
    ).subscribe(imageRef => {
      if (imageRef && imageRef.trim()) {
        // Update oci_image parameter when debounced value is ready
        this.updateOciImageParameter(imageRef);
        this.fetchImageAnnotations(imageRef.trim());
      } else {
        this.imageError.set(null);
        this.loadingImageAnnotations.set(false);
        // Clear oci_image parameter if input is empty
        if (this.parameterForm.get('oci_image')) {
          this.parameterForm.patchValue({ oci_image: '' }, { emitEvent: false });
        }
      }
    });
    
    // Note: AsyncValidator will be triggered automatically by Angular Forms
    // when the value changes through the input field
    // The applicationIdSubject is kept for potential future use (e.g., custom error messages)
  }

  ngOnDestroy(): void {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.imageAnnotationsTimeout) {
      clearTimeout(this.imageAnnotationsTimeout);
    }
  }

  loadFrameworks(): void {
    this.loadingFrameworks.set(true);
    // Use cache service for faster loading
    this.cacheService.getFrameworks().subscribe({
      next: (frameworks) => {
        this.frameworks = frameworks;
        this.loadingFrameworks.set(false);
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load frameworks', err);
        this.loadingFrameworks.set(false);
      }
    });
  }

  onFrameworkSelected(frameworkId: string): void {
    this.selectedFramework = this.frameworks.find(f => f.id === frameworkId) || null;
    // Reset image-related state when framework changes
    this.imageReference.set('');
    this.imageError.set(null);
    this.loadingImageAnnotations.set(false);
    this.imageAnnotationsReceived.set(false);
    if (this.imageAnnotationsTimeout) {
      clearTimeout(this.imageAnnotationsTimeout);
    }
    
    if (this.selectedFramework) {
      this.loadParameters(frameworkId);
    }
  }

  onImageReferenceInput(event: Event): void {
    const imageRef = (event.target as HTMLInputElement).value;
    this.imageReference.set(imageRef);
    // Reset error state immediately for better UX
    this.imageError.set(null);
    this.imageAnnotationsReceived.set(false);
    
    // Emit to subject for debounced API call
    this.imageInputSubject.next(imageRef);
  }

  private updateOciImageParameter(imageRef: string): void {
    // Set oci_image parameter if it exists in the parameter form
    if (imageRef.trim() && this.parameterForm.get('oci_image')) {
      this.parameterForm.patchValue({ oci_image: imageRef.trim() }, { emitEvent: false });
    }
  }

  onIconFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
      const file = input.files[0];
      
      // Validate file type (images only)
      if (!file.type.startsWith('image/')) {
        alert('Please select an image file');
        input.value = '';
        return;
      }
      
      // Validate file size (max 1MB)
      if (file.size > 1024 * 1024) {
        alert('Image file size must be less than 1MB');
        input.value = '';
        return;
      }
      
      this.selectedIconFile = file;
      
      // Read file as base64
      const reader = new FileReader();
      reader.onload = (e) => {
        const result = e.target?.result as string;
        // Remove data:image/...;base64, prefix
        const base64Content = result.split(',')[1] || result;
        this.iconContent.set(base64Content);
        
        // Set preview
        this.iconPreview.set(result);
      };
      reader.onerror = () => {
        alert('Failed to read image file');
        this.selectedIconFile = null;
        this.iconContent.set(null);
        this.iconPreview.set(null);
        input.value = '';
      };
      reader.readAsDataURL(file);
    }
  }

  removeIcon(): void {
    this.selectedIconFile = null;
    this.iconContent.set(null);
    this.iconPreview.set(null);
    // Reset file input
    this.resetIconFileInput();
  }

  openIconFileDialog(): void {
    const fileInput = document.getElementById('icon-file-input') as HTMLInputElement;
    if (fileInput) {
      fileInput.click();
    }
  }

  private resetIconFileInput(): void {
    const fileInput = document.getElementById('icon-file-input') as HTMLInputElement;
    if (fileInput) {
      fileInput.value = '';
    }
  }

  isOciImageFramework(): boolean {
    return this.selectedFramework?.id === 'oci-image';
  }

  fetchImageAnnotations(imageRef: string): void {
    if (!imageRef || !imageRef.trim()) {
      return;
    }

    this.loadingImageAnnotations.set(true);
    this.imageError.set(null);
    
    // Parse image reference (support format: image:tag or image)
    const parts = imageRef.split(':');
    const image = parts[0];
    const tag = parts.length > 1 ? parts[1] : 'latest';

    // Start timeout: after 1 second, enable Next button even if annotations are still loading
    this.imageAnnotationsTimeout = setTimeout(() => {
      // After 1 second, we can proceed even if annotations are still loading
      // The annotations will be filled in when they arrive
    }, 1000);

    this.configService.getFrameworkFromImage({ image, tag }).subscribe({
      next: (res: IPostFrameworkFromImageResponse) => {
        this.loadingImageAnnotations.set(false);
        this.imageAnnotationsReceived.set(true);
        if (this.imageAnnotationsTimeout) {
          clearTimeout(this.imageAnnotationsTimeout);
          this.imageAnnotationsTimeout = null;
        }
        
        // Store the response for later use (e.g., when navigating to Step 2)
        this.lastAnnotationsResponse = res;
        
        // Auto-fill fields that haven't been manually changed
        this.fillFieldsFromAnnotations(res);
      },
      error: (err) => {
        this.loadingImageAnnotations.set(false);
        if (this.imageAnnotationsTimeout) {
          clearTimeout(this.imageAnnotationsTimeout);
          this.imageAnnotationsTimeout = null;
        }
        
        // Handle error - show message but don't block navigation
        const errorMessage = err?.error?.error || err?.message || 'Failed to fetch image annotations';
        this.imageError.set(errorMessage);
        // Don't call errorHandler here - we want to allow proceeding even if annotations fail
      }
    });
  }

  fillFieldsFromAnnotations(res: IPostFrameworkFromImageResponse): void {
    const defaults = res.defaults;
    const form = this.appPropertiesForm;
    
    // Helper function to check if a field is empty (null, undefined, or empty string)
    const isEmpty = (value: string | number | boolean | null | undefined): boolean => {
      return value === null || value === undefined || value === '';
    };
    
    // Fill Application Properties from defaults (if not manually changed)
    if (defaults.applicationProperties) {
      const appProps = defaults.applicationProperties;
      
      if (appProps.name && isEmpty(form.get('name')?.value)) {
        form.patchValue({ name: appProps.name }, { emitEvent: false });
      }
      if (appProps.applicationId && isEmpty(form.get('applicationId')?.value)) {
        const applicationIdControl = form.get('applicationId');
        if (applicationIdControl) {
          // Set value without triggering form events
          applicationIdControl.patchValue(appProps.applicationId, { emitEvent: false });
          // Trigger async validator after setting value programmatically
          // Don't use emitEvent: false here, as we want validation to run
          applicationIdControl.updateValueAndValidity();
        }
      }
      if (appProps.description && isEmpty(form.get('description')?.value)) {
        form.patchValue({ description: appProps.description }, { emitEvent: false });
      }
      if (appProps.url && isEmpty(form.get('url')?.value)) {
        form.patchValue({ url: appProps.url }, { emitEvent: false });
      }
      if (appProps.documentation && isEmpty(form.get('documentation')?.value)) {
        form.patchValue({ documentation: appProps.documentation }, { emitEvent: false });
      }
      if (appProps.source && isEmpty(form.get('source')?.value)) {
        form.patchValue({ source: appProps.source }, { emitEvent: false });
      }
      if (appProps.vendor && isEmpty(form.get('vendor')?.value)) {
        form.patchValue({ vendor: appProps.vendor }, { emitEvent: false });
      }
    }
    
    // Fill parameter defaults (if not manually changed)
    if (defaults.parameters) {
      for (const [paramId, paramValue] of Object.entries(defaults.parameters)) {
        const paramControl = this.parameterForm.get(paramId);
        if (paramControl && isEmpty(paramControl.value)) {
          paramControl.patchValue(paramValue, { emitEvent: false });
        }
      }
    }
    
    // Set oci_image parameter if it exists in the parameter form
    const imageRef = this.imageReference().trim();
    if (imageRef && this.parameterForm.get('oci_image')) {
      // Only set if not already changed by user
      const currentValue = this.parameterForm.get('oci_image')?.value;
      if (isEmpty(currentValue)) {
        this.parameterForm.patchValue({ oci_image: imageRef }, { emitEvent: false });
      }
    }
  }

  loadParameters(frameworkId: string): void {
    this.loadingParameters.set(true);
    this.parameters = [];
    this.parameterForm = this.fb.group({});
    this.groupedParameters = {};

    this.configService.getFrameworkParameters(frameworkId).subscribe({
      next: (res) => {
        this.parameters = res.parameters;
        // Group parameters by template (or use 'General' as default)
        this.groupedParameters = {};
        for (const param of this.parameters) {
          const group = param.templatename || 'General';
          if (!this.groupedParameters[group]) {
            this.groupedParameters[group] = [];
          }
          this.groupedParameters[group].push(param);
          
          const validators = param.required ? [Validators.required] : [];
          const defaultValue = param.default !== undefined ? param.default : '';
          this.parameterForm.addControl(param.id, new FormControl(defaultValue, validators));
        }
        // Sort parameters in each group: required first, then optional
        for (const group in this.groupedParameters) {
          this.groupedParameters[group] = this.groupedParameters[group].slice().sort(
            (a, b) => Number(!!b.required) - Number(!!a.required)
          );
        }
        this.loadingParameters.set(false);
      },
      error: (err) => {
        this.errorHandler.handleError('Failed to load framework parameters', err);
        this.loadingParameters.set(false);
      }
    });
  }

  toggleAdvanced(): void {
    this.showAdvanced.set(!this.showAdvanced());
  }

  hasAdvancedParams(): boolean {
    return this.parameters.some(p => p.advanced);
  }

  get groupNames(): string[] {
    return Object.keys(this.groupedParameters);
  }

  canProceedToStep2(): boolean {
    if (!this.selectedFramework) {
      return false;
    }
    
    // For oci-image framework, require image reference
    if (this.isOciImageFramework()) {
      return this.imageReference().trim().length > 0;
    }
    
    return true;
  }

  onStepChange(event: { selectedIndex: number }): void {
    // When Step 2 is entered, fill fields from annotations if they were already loaded
    if (event.selectedIndex === 1 && this.lastAnnotationsResponse) {
      // Use setTimeout to ensure the form is fully rendered
      setTimeout(() => {
        this.fillFieldsFromAnnotations(this.lastAnnotationsResponse!);
      }, 0);
    }
  }

  canProceedToStep3(): boolean {
    if (this.appPropertiesForm.invalid) {
      this.appPropertiesForm.markAllAsTouched();
      return false;
    }
    return true;
  }

  canProceedToStep4(): boolean {
    if (this.parameterForm.invalid) {
      this.parameterForm.markAllAsTouched();
      return false;
    }
    return true;
  }

  createApplication(): void {
    if (!this.selectedFramework || this.appPropertiesForm.invalid || this.parameterForm.invalid) {
      return;
    }

    this.creating.set(true);
    this.createError.set(null);
    this.createErrorStep.set(null);

    const parameterValues: { id: string; value: IParameterValue }[] = [];
    for (const param of this.parameters) {
      const value = this.parameterForm.get(param.id)?.value;
      if (value !== null && value !== undefined && value !== '') {
        parameterValues.push({ id: param.id, value });
      }
    }

    const body = {
      frameworkId: this.selectedFramework.id,
      applicationId: this.appPropertiesForm.get('applicationId')?.value,
      name: this.appPropertiesForm.get('name')?.value,
      description: this.appPropertiesForm.get('description')?.value,
      url: this.appPropertiesForm.get('url')?.value || undefined,
      documentation: this.appPropertiesForm.get('documentation')?.value || undefined,
      source: this.appPropertiesForm.get('source')?.value || undefined,
      vendor: this.appPropertiesForm.get('vendor')?.value || undefined,
      ...(this.selectedIconFile && this.iconContent() && {
        icon: this.selectedIconFile.name,
        iconContent: this.iconContent()!,
      }),
      parameterValues
    };

    this.configService.createApplicationFromFramework(body).subscribe({
      next: (res) => {
        this.creating.set(false);
        if (res.success) {
          alert(`Application "${body.name}" created successfully!`);
          this.router.navigate(['/applications']);
        } else {
          this.createError.set('Failed to create application. Please try again.');
          this.createErrorStep.set(null);
        }
      },
      error: (err: { error?: { error?: string }; message?: string }) => {
        this.creating.set(false);
        
        // Extract error message
        const errorMessage = err?.error?.error || err?.message || 'Failed to create application';
        
        // Determine which step to navigate to based on error
        let targetStep: number | null = null;
        
        // Check for specific error types
        if (errorMessage.includes('already exists') || errorMessage.includes('Application') && errorMessage.includes('exists')) {
          // Application ID already exists - navigate to Step 2 (Application Properties)
          targetStep = 1; // Step index is 0-based, Step 2 is index 1
          this.createError.set(`Application ID "${body.applicationId}" already exists. Please choose a different ID.`);
        } else if (errorMessage.includes('applicationId') || errorMessage.includes('Missing applicationId')) {
          // Application ID related error - navigate to Step 2
          targetStep = 1;
          this.createError.set(errorMessage);
        } else if (errorMessage.includes('name') || errorMessage.includes('Missing name')) {
          // Name related error - navigate to Step 2
          targetStep = 1;
          this.createError.set(errorMessage);
        } else if (errorMessage.includes('parameter') || errorMessage.includes('Parameter')) {
          // Parameter related error - navigate to Step 3 (Parameters)
          targetStep = 2; // Step index is 0-based, Step 3 is index 2
          this.createError.set(errorMessage);
        } else {
          // Generic error - show in Step 4
          this.createError.set(errorMessage);
          targetStep = null;
        }
        
        this.createErrorStep.set(targetStep);
        
        // Don't automatically navigate - let the user decide when to navigate using the button
        // The error will be displayed in Step 4, and the user can click "Go to Step X to Fix" if needed
      }
    });
  }

  navigateToErrorStep(): void {
    const errorStep = this.createErrorStep();
    if (errorStep !== null && this.stepper) {
      // Navigate to the error step
      this.stepper.selectedIndex = errorStep;
      
      // Mark the form field as touched to show validation errors after navigation
      setTimeout(() => {
        if (errorStep === 1) {
          // Step 2 - mark applicationId field as touched if it's an ID error
          const errorMessage = this.createError();
          if (errorMessage && (errorMessage.includes('already exists') || errorMessage.includes('applicationId'))) {
            this.appPropertiesForm.get('applicationId')?.markAsTouched();
          }
        }
        // Don't clear the error immediately - let it stay visible so user can see what to fix
        // The error will be cleared when they try to create again or manually dismiss it
      }, 100);
    }
  }

  clearError(): void {
    this.createError.set(null);
    this.createErrorStep.set(null);
  }

  getImageReferenceTooltip(): string {
    return `Enter an OCI image reference:
• Docker Hub: image:tag or owner/image:tag (e.g., mariadb:latest, nodered/node-red:latest)
• GitHub Container Registry: ghcr.io/owner/image:tag (e.g., ghcr.io/home-assistant/home-assistant:latest)
• Tag is optional and defaults to 'latest' if not specified
The system will automatically fetch metadata from the image and pre-fill application properties.`;
  }

  /**
   * Custom async validator for application ID uniqueness
   */
  applicationIdUniqueValidator(): AsyncValidatorFn {
    return (control: AbstractControl): Observable<ValidationErrors | null> => {
      const applicationId = control.value;
      
      // If empty, don't validate (required validator will handle it)
      if (!applicationId || !applicationId.trim()) {
        return of(null);
      }
      
      // Check against cache
      return this.cacheService.isApplicationIdTaken(applicationId.trim()).pipe(
        map(isTaken => {
          if (isTaken) {
            return { applicationIdTaken: true };
          }
          return null;
        }),
        catchError(() => {
          // On error, don't block the user - validation will happen on submit
          return of(null);
        })
      );
    };
  }

  onApplicationIdInput(event: Event): void {
    const applicationId = (event.target as HTMLInputElement).value;
    this.applicationIdSubject.next(applicationId);
  }

  validateApplicationId(applicationId: string): void {
    if (!applicationId || !applicationId.trim()) {
      this.applicationIdError.set(null);
      return;
    }
    
    this.cacheService.isApplicationIdTaken(applicationId).subscribe({
      next: (isTaken) => {
        if (isTaken) {
          this.applicationIdError.set(`Application ID "${applicationId}" already exists. Please choose a different ID.`);
          this.appPropertiesForm.get('applicationId')?.setErrors({ taken: true });
        } else {
          this.applicationIdError.set(null);
          // Clear 'taken' error if it exists
          const control = this.appPropertiesForm.get('applicationId');
          if (control?.hasError('taken')) {
            const errors = { ...control.errors };
            delete errors['taken'];
            control.setErrors(Object.keys(errors).length > 0 ? errors : null);
          }
        }
      },
      error: () => {
        // On error, don't block the user - validation will happen on submit
        this.applicationIdError.set(null);
      }
    });
  }

  cancel(): void {
    this.router.navigate(['/applications']);
  }
}

