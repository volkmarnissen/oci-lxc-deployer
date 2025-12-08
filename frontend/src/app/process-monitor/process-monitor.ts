import { NgZone, OnDestroy, Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatExpansionModule } from '@angular/material/expansion';
import { IProxmoxExecuteMessage } from '../../shared/types';
import { HttpClient, HttpClientModule } from '@angular/common/http';

@Component({
  selector: 'app-process-monitor',
  standalone: true,
  imports: [CommonModule, MatExpansionModule, HttpClientModule],
  templateUrl: './process-monitor.html',
  styleUrl: './process-monitor.scss',
})
export class ProcessMonitor implements OnInit, OnDestroy {
  messages: IProxmoxExecuteMessage[] = [];
  private destroyed = false;
  private pollInterval?: number;

  private http = inject(HttpClient);
  private zone = inject(NgZone);

  ngOnInit() {
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
      this.http.get<IProxmoxExecuteMessage[]>('/api/ProxmoxExecuteMessages').subscribe({
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

}