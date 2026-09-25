/**
 * Logger structuré avec support audit
 */

import { appendFileSync, createWriteStream } from 'node:fs';
import os from 'node:os';
import { logDirCandidates, resolveLogDir } from './log-dir.js';

// Niveaux de log
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// Structure d'une entrée de log
export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  event: string;
  message?: string;
  tool?: string;
  params?: Record<string, unknown>;
  correlation_id?: string;
  duration_ms?: number;
  error?: string;
  exit_code?: number;
}

// Structure d'une entrée d'audit
export interface AuditEntry {
  timestamp: string;
  tool: string;
  params: Record<string, unknown>;
  user: string;
  result: 'success' | 'error';
  duration_ms: number;
  error?: string;
  exit_code?: number;
}

// Générateur de correlation ID
export function generateCorrelationId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

class Logger {
  private logStream: ReturnType<typeof createWriteStream> | null = null;
  private auditPath: string | null = null;
  private errorStream: ReturnType<typeof createWriteStream> | null = null;
  private initialized = false;
  /** Dossier effectivement utilisé (null : stderr seulement). */
  dir: string | null = null;

  // Initialisation à la première écriture : `--help` n'ouvre aucun fichier.
  private init(): void {
    if (this.initialized) return;
    this.initialized = true;

    // Avant, seul /var/log/mcp-agents était essayé : pour un utilisateur normal
    // rien n'était écrit sur disque, journal d'audit compris.
    this.dir = resolveLogDir(logDirCandidates(process.env, os.homedir()));
    if (this.dir === null) {
      console.error('[Logger] No writable log directory (MCP_AGENTS_LOG_DIR, /var/log/mcp-agents, ~/.local/state/mcp-agents): logging to stderr only');
      return;
    }
    const date = new Date().toISOString().split('T')[0];
    const open = (name: string) => createWriteStream(`${this.dir}/${name}-${date}.log`, { flags: 'a', mode: 0o600 });
    this.logStream = open('server');
    // audit en écriture synchrone : l'entrée est sur disque avant de rendre la main,
    // même si le processus s'arrête aussitôt (fin de stdin, crash)
    this.auditPath = `${this.dir}/audit-${date}.log`;
    this.errorStream = open('error');
  }

  private formatEntry(entry: LogEntry): string {
    return JSON.stringify(entry);
  }

  private write(entry: LogEntry): void {
    this.init();
    const line = `${this.formatEntry(entry)}\n`;

    // Toujours écrire sur stderr (pour debug)
    if (entry.level === 'error') {
      process.stderr.write(line);
    }

    // Écrire dans les fichiers si disponibles
    if (this.logStream) {
      this.logStream.write(line);
    }

    if (entry.level === 'error' && this.errorStream) {
      this.errorStream.write(line);
    }
  }

  private log(level: LogLevel, event: string, data?: Partial<LogEntry>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      event,
      ...data
    };
    this.write(entry);
  }

  debug(event: string, data?: Partial<LogEntry>): void {
    this.log('debug', event, data);
  }

  info(event: string, data?: Partial<LogEntry>): void {
    this.log('info', event, data);
  }

  warn(event: string, data?: Partial<LogEntry>): void {
    this.log('warn', event, data);
  }

  error(event: string, data?: Partial<LogEntry>): void {
    this.log('error', event, data);
  }

  // Log spécifique pour les appels d'outils
  toolCall(tool: string, params: Record<string, unknown>, correlationId: string): void {
    this.info('tool_call_start', {
      tool,
      params,
      correlation_id: correlationId
    });
  }

  toolResult(
    tool: string,
    params: Record<string, unknown>,
    correlationId: string,
    durationMs: number,
    exitCode: number,
    error?: string
  ): void {
    const level = exitCode === 0 ? 'info' : 'error';
    this.log(level, 'tool_call_end', {
      tool,
      params,
      correlation_id: correlationId,
      duration_ms: durationMs,
      exit_code: exitCode,
      error
    });
  }

  // Audit des opérations sensibles
  audit(entry: Omit<AuditEntry, 'timestamp'>): void {
    const auditEntry: AuditEntry = {
      timestamp: new Date().toISOString(),
      ...entry
    };

    const line = `${JSON.stringify(auditEntry)}\n`;

    this.init();
    if (this.auditPath) {
      try {
        appendFileSync(this.auditPath, line, { mode: 0o600 });
      } catch (e) {
        process.stderr.write(`[Logger] audit write failed: ${(e as Error).message}\n${line}`);
      }
    }

    // Aussi logger normalement
    this.info('audit', {
      tool: entry.tool,
      params: entry.params,
      duration_ms: entry.duration_ms,
      error: entry.error
    });
  }

  // Fermer proprement les streams
  close(): void {
    this.logStream?.end();
    this.errorStream?.end();
  }
}

// Instance singleton
export const logger = new Logger();

// Cleanup à la fermeture
process.on('beforeExit', () => {
  logger.close();
});
