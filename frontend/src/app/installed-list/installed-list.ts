
import { Component, inject, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { VeConfigurationService } from '../ve-configuration.service';
import { IInstallationEntry } from '../../shared/types';

@Component({
  selector: 'app-installed-list',
  standalone: true,
  imports: [CommonModule, RouterModule],
  templateUrl: './installed-list.html',
  styleUrl: './installed-list.scss',
})
export class InstalledList implements OnInit {
  installations: IInstallationEntry[] = [];
  loading = true;
  error?: string;
  private svc = inject(VeConfigurationService);
  private router = inject(Router);

  ngOnInit(): void {
    this.svc.getInstallations().subscribe({
      next: (items) => {
        this.installations = items;
        this.loading = false;
      },
      error: () => {
        this.error = 'Fehler beim Laden der Installationen';
        this.loading = false;
      }
    });
  }

  copyUpgrade(entry: IInstallationEntry) {
    this.svc.restartInstallation(entry.vmInstallKey).subscribe({
      next: () => {
        this.router.navigate(['/monitor']);
      },
      error: () => {
        // Global handler in service already alerts and navigates
      }
    });
  }
}
