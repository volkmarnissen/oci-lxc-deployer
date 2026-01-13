import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet, RouterLink, Router } from '@angular/router';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatSelectModule } from '@angular/material/select';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { FormsModule } from '@angular/forms';
import { CommonModule } from '@angular/common';
import { VeConfigurationService } from './ve-configuration.service';
import { CacheService } from './shared/services/cache.service';
import { ISsh } from '../shared/types';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, MatTooltipModule, MatSelectModule, MatFormFieldModule, MatIconModule, FormsModule, CommonModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  private cfg = inject(VeConfigurationService);
  private router = inject(Router);
  private cacheService = inject(CacheService);
  
  sshConfigs: ISsh[] = [];
  currentHost: string = '';
  
  ngOnInit(): void {
    // Preload cache in background for faster UI loading
    this.cacheService.preloadAll();
    
    this.loadSshConfigs();
    this.cfg.initVeContext().subscribe({
      next: (sshs) => {
        this.sshConfigs = sshs || [];
        this.updateCurrentHost();
        // Check if no SSH configs exist or no current SSH config is set
        if (!sshs || sshs.length === 0 || !sshs.some(ssh => ssh.current === true)) {
          // Only navigate if we're not already on the ssh-config page
          const currentUrl = this.router.url;
          if (!currentUrl.startsWith('/ssh-config')) {
            this.router.navigate(['/ssh-config']);
          }
        }
      },
      error: (err) => {
        console.warn('Failed to initialize VE context', err);
        // On error, navigate to ssh-config page if not already there
        const currentUrl = this.router.url;
        if (!currentUrl.startsWith('/ssh-config')) {
          this.router.navigate(['/ssh-config']);
        }
      }
    });
  }
  
  loadSshConfigs(): void {
    this.cfg.getSshConfigs().subscribe({
      next: (res) => {
        this.sshConfigs = res.sshs || [];
        this.updateCurrentHost();
      },
      error: () => {
        this.sshConfigs = [];
        this.currentHost = '';
      }
    });
  }
  
  updateCurrentHost(): void {
    const current = this.sshConfigs.find(ssh => ssh.current === true);
    if (current) {
      this.currentHost = current.host;
    } else if (this.sshConfigs.length > 0) {
      this.currentHost = this.sshConfigs[0].host;
    } else {
      this.currentHost = '';
    }
  }
  
  onHostChange(host: string): void {
    const selected = this.sshConfigs.find(ssh => ssh.host === host);
    if (selected) {
      this.cfg.setSshConfig({ host: selected.host, port: selected.port, current: true }).subscribe({
        next: () => {
          this.currentHost = host;
          // Reload SSH configs to update current status
          this.loadSshConfigs();
          // Reload VE context
          this.cfg.initVeContext().subscribe();
        },
        error: (err) => {
          console.error('Failed to set current host', err);
          // Revert selection on error
          this.updateCurrentHost();
        }
      });
    }
  }
  
  getHostDisplay(ssh: ISsh): string {
    if (ssh.port && ssh.port !== 22) {
      return `${ssh.host}:${ssh.port}`;
    }
    return ssh.host;
  }
}
