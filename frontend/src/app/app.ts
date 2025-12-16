import { Component, OnInit, inject } from '@angular/core';
import { RouterOutlet, RouterLink } from '@angular/router';
import { MatTooltipModule } from '@angular/material/tooltip';
import { VeConfigurationService } from './ve-configuration.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, MatTooltipModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit {
  private cfg = inject(VeConfigurationService);
  ngOnInit(): void {
    this.cfg.initVeContext();
  }
}
