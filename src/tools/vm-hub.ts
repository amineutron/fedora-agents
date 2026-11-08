/**
 * Outils "hub" : cycle de vie (pause, reprise, redemarrage), creation depuis une image,
 * telechargement d'image, console, lecture et edition du materiel. Pilotage libvirt direct,
 * couture `utils/runner.ts`.
 */

import { vmConsoleTools } from './vm-console.js';
import { vmCreateTools } from './vm-create.js';
import { vmEditTools } from './vm-edit.js';
import { vmHardwareTools } from './vm-hardware.js';
import { vmImageFetchTools } from './vm-image-fetch.js';
import { vmLifecycleTools } from './vm-lifecycle.js';
import type { ToolDefinition } from './vm-controller.js';

export const vmHubTools: ToolDefinition[] = [
  ...vmLifecycleTools,
  ...vmCreateTools,
  ...vmImageFetchTools,
  ...vmConsoleTools,
  ...vmHardwareTools,
  ...vmEditTools
];
