import { Component, Input, Output, EventEmitter, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ProxmoxConfigurationService } from '../ve-configuration.service';
import { ISsh } from '../../shared/types';

@Component({
  selector: 'app-configuration-dialog',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './configuration-dialog.html',
  styleUrl: './configuration-dialog.scss',
})

export class ConfigurationDialog implements OnInit {
  @Input() sshMode = false;
  @Output() dialogClose = new EventEmitter<void>();
  @Output() saved = new EventEmitter<ISsh>();

  ssh: ISsh[] = [];
  loading = false;
  error = '';
  configService = inject(ProxmoxConfigurationService);

  ngOnInit() {
    if (this.sshMode) {
      this.loading = true;
      this.configService.getSshConfigs().subscribe({
        next: ssh => {
          this.ssh = ssh && ssh.length > 0 ? ssh : [];
          this.loading = false;
        },
        error: () => { this.error = 'Error loading SSH configuration.'; this.loading = false; }
      });
    }
  }

  setCurrent(index: number) {
    this.ssh.forEach((s, i) => s.current = i === index);
  }

  addSsh() {
    // If list is empty, mark the first configuration as current
    this.ssh.push({ host: '', port: 22, current: this.ssh.length === 0 });
  }

  removeSsh(index: number) {
    const wasCurrent = this.ssh[index].current;
    this.ssh.splice(index, 1);
    if (wasCurrent && this.ssh.length > 0) {
      this.ssh[0].current = true;
    }
  }

  save() {
    this.loading = true;
    const ssh = this.ssh.find(s => s.current);
    if(!ssh) {
      this.error = 'Please choose an SSH configuration.';
      this.loading = false;
      return;
    }
    this.configService.setSshConfig(ssh).subscribe({
      next: () => { this.loading = false; this.saved.emit(ssh); this.dialogClose.emit(); },
      error: () => { this.error = 'Error saving SSH configuration.'; this.loading = false; }
    });
  }

  get canSave(): boolean {
    // Saving is allowed only if at least one SSH configuration exists
    return this.ssh.length > 0 && !this.loading;
  }

  cancel() {
    this.dialogClose.emit();
  }
}
