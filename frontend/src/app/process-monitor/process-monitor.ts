import { NgZone, OnDestroy, Component, OnInit, inject, Input, Output, EventEmitter } from '@angular/core';
import { ActivatedRoute } from '@angular/router';

import { MatExpansionModule } from '@angular/material/expansion';
import { IVeExecuteMessagesResponse } from '../../shared/types';
import { VeConfigurationService } from '../ve-configuration.service';

@Component({
  selector: 'app-process-monitor',
  standalone: true,
  imports: [MatExpansionModule],
  templateUrl: './process-monitor.html',
  styleUrl: './process-monitor.scss',
})
export class ProcessMonitor implements OnInit, OnDestroy {
  messages: IVeExecuteMessagesResponse| undefined;
  private destroyed = false;
  private pollInterval?: number;
  private veConfigurationService = inject(VeConfigurationService);
   
  @Input() restartKey?: string;
  @Output() restartRequested = new EventEmitter<string>();

  private zone = inject(NgZone);
  private route = inject(ActivatedRoute);

  ngOnInit() {
    // pick restartKey from query params if present
    const key = this.route.snapshot.queryParamMap.get('restartKey');
    if (key) this.restartKey = key;
    this.startPolling();
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
    }
  }

  startPolling() {
    this.pollInterval = setInterval(() => {
      this.veConfigurationService.getExecuteMessages().subscribe({
        next: (msgs) => {
           if (msgs && msgs.length > 0) {
           console.log('Polled messages:', msgs);
           this.zone.run(() => {
              this.messages = [ ...msgs];
            });
          }
        },
        error: () => {
          // Optionally handle error
        }
      });
    }, 5000);
  }

  triggerRestart() {
    if (this.restartKey) {
      this.restartRequested.emit(this.restartKey);
    }
  }

}